import { createHash } from "node:crypto";
import https from "node:https";
import { spawn } from "node:child_process";
import { archiveImages } from "./image-archive.js";
import { createPool } from "./db.js";

const RSS_BASES = (process.env.NITTER_BASES || process.env.NITTER_BASE || "https://nitter.net,https://rss.xcancel.com")
  .split(",")
  .map((item) => item.trim().replace(/\/$/, ""))
  .filter(Boolean);
const RSS_BASE = RSS_BASES[0] || "https://nitter.net";
const MAX_CREATORS = Number(process.env.MAX_CREATORS || 227);
const DELAY_MS = Number(process.env.SCRAPE_DELAY_MS || 450);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 18000);
const MAX_ITEMS_PER_CREATOR = Number(process.env.MAX_ITEMS_PER_CREATOR || 25);

const promptSignals = [
  /\bimage prompt\b/i,
  /\bprompt structure\b/i,
  /(^|\n)\s*(\d+\/\s*)?prompt\s*[:：\n]/i,
  /\bprompt\s+(?:for|to|structure)\b/i,
  /\bkeywords?\s*[:：]/i,
  /\u63d0\u793a\u8bcd\s*[:：]/,
  /\u5492\u8bed\s*[:：]/,
  /\u5173\u952e\u8bcd\s*[:：]/,
  /\u63d0\u793a\u8bcd\u7ed3\u6784/
];

const promptInCommentsSignals = [
  /prompt\s+(?:in|below|comment)/i,
  /prompt\s+structure\s+(?:in|below|comment)/i,
  /\u63d0\u793a\u8bcd.{0,16}\u8bc4\u8bba\u533a/,
  /\u8bc4\u8bba\u533a.{0,16}\u63d0\u793a\u8bcd/,
  /\u63d0\u793a\u8bcd.{0,16}\ud83d\udc47/,
  /prompt.{0,24}\ud83d\udc47/i
];

const obviousNonPrompts = [
  /^rt\s/i,
  /^reposted/i,
  /^article$/i,
  /^portrait\.?$/i,
  /today'?s portrait/i,
  /prompt\s+is\s+in\s+rt/i,
  /\brt\./i,
  /giveaway/i,
  /airdrop/i,
  /\u63d0\u793a\u8bcd\u4e0d\u9519/,
  /access_token/i,
  /backend-api/i,
  /rate-limit/i,
  /\bcodex\b/i
];

const visualSignals = [
  /\bgpt[-\s]?image\b/i,
  /\bimage2\b/i,
  /\bphoto\b/i,
  /\bportrait\b/i,
  /\bcamera\b/i,
  /\blens\b/i,
  /\bposter\b/i,
  /\billustration\b/i,
  /\bstyle\b/i,
  /\bvisual\b/i,
  /\bcomposition\b/i,
  /\bscene\b/i,
  /\bwallpaper\b/i,
  /\u751f\u56fe/,
  /\u56fe\u50cf/,
  /\u753b\u9762/,
  /\u6d77\u62a5/,
  /\u5199\u771f/,
  /\u6444\u5f71/,
  /\u955c\u5934/,
  /\u6784\u56fe/,
  /\u573a\u666f/,
  /\u89c6\u89c9/,
  /\u58c1\u7eb8/,
  /\u63d2\u753b/,
  /\u8272\u5f69/
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeEntities(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripHtml(value = "") {
  return decodeEntities(value)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractTag(item, tag) {
  const match = item.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? decodeEntities(match[1]).trim() : "";
}

function parseItems(xml) {
  return xml
    .split(/<item>/i)
    .slice(1)
    .map((chunk) => chunk.split(/<\/item>/i)[0])
    .filter(Boolean);
}

function extractChannel(xml = "") {
  const match = String(xml).match(/<channel[^>]*>([\s\S]*?)(?:<item>|<\/channel>)/i);
  return match ? match[1] : "";
}

function normalizeImageUrl(value = "", rssBase = RSS_BASE) {
  const rawUrl = decodeEntities(value).trim();
  if (!rawUrl) return "";
  let twitterUrl = rawUrl
    .replace(/^https:\/\/nitter\.net\/pic\//, "https://pbs.twimg.com/")
    .replace(/^https:\/\/rss\.xcancel\.com\/pic\//, "https://pbs.twimg.com/")
    .replace(/^https:\/\/xcancel\.com\/pic\//, "https://pbs.twimg.com/");
  const baseHost = rssBase.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  twitterUrl = twitterUrl.replace(new RegExp(`^https://${baseHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/pic/`), "https://pbs.twimg.com/");
  return twitterUrl
    .replace(/%2F/gi, "/")
    .replace(/^https:\/\/pbs\.twimg\.com\/pbs\.twimg\.com\//, "https://pbs.twimg.com/");
}

function extractImages(description = "", rssBase = RSS_BASE) {
  const urls = [...description.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].map((match) => normalizeImageUrl(match[1], rssBase));
  return [...new Set(urls)];
}

function parseChannelProfile(xml, rssBase) {
  const channel = extractChannel(xml);
  const title = stripHtml(extractTag(channel, "title"));
  const imageBlock = channel.match(/<image[^>]*>([\s\S]*?)<\/image>/i)?.[1] || "";
  const avatarUrl = normalizeImageUrl(extractTag(imageBlock, "url"), rssBase);
  const displayName = title
    .replace(/\s*\/\s*@?[A-Za-z0-9_]{2,20}\s*$/, "")
    .trim();
  return {
    displayName: displayName || null,
    avatarUrl: avatarUrl || null
  };
}

function isReply(title = "") {
  return /^R\s+to\s+@/i.test(title.trim());
}

function nitterLinkToX(link, handle, tweetId) {
  const fromLink = String(link).match(/\/status\/(\d+)/);
  const id = tweetId || fromLink?.[1];
  if (!id) return null;
  return `https://x.com/${handle.replace(/^@/, "")}/status/${id}`;
}

function saysPromptInComments(text) {
  return promptInCommentsSignals.some((pattern) => pattern.test(text));
}

function isLikelyPrompt(text) {
  const clean = text.trim();
  if (clean.length < 80) return false;
  if (obviousNonPrompts.some((pattern) => pattern.test(clean))) return false;
  return promptSignals.some((pattern) => pattern.test(clean)) && visualSignals.some((pattern) => pattern.test(clean));
}

function titleFromText(text) {
  const firstLine = text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  if (!firstLine) return "Twitter prompt";
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
}

function previewFromText(text) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 260 ? `${oneLine.slice(0, 260)}...` : oneLine;
}

function extractPromptBody(text) {
  const markers = [
    /(^|\n)\s*(?:\d+\/\s*)?prompt\s*(?:structure)?\s*[:：\n]/i,
    /(^|\n)\s*(?:\u63d0\u793a\u8bcd|\u5492\u8bed|\u5173\u952e\u8bcd)\s*[:：\n]/
  ];
  const positions = markers
    .map((pattern) => {
      const match = pattern.exec(text);
      return match ? match.index + match[0].length : -1;
    })
    .filter((index) => index >= 0);
  if (!positions.length) return text.trim();
  const start = Math.min(...positions);
  return text.slice(start).trim() || text.trim();
}

function classifyPrompt(text) {
  const lower = text.toLowerCase();
  if (/poster|typography|\u6d77\u62a5|\u5b57\u4f53/.test(lower)) {
    return { category: "Posters & Typography", styles: ["Poster"], scenes: ["Social"] };
  }
  if (/photo|portrait|camera|lens|cinematic|\u6444\u5f71|\u5199\u771f|\u955c\u5934/.test(lower)) {
    return { category: "Photography & Realism", styles: ["Photography", "Realistic"], scenes: ["Creative"] };
  }
  if (/logo|brand|packaging|product|\u5546\u54c1|\u54c1\u724c|\u5305\u88c5/.test(lower)) {
    return { category: "Products & E-commerce", styles: ["Product", "Brand"], scenes: ["Commerce"] };
  }
  if (/infographic|diagram|chart|map|\u4fe1\u606f\u56fe|\u56fe\u8868|\u5730\u56fe/.test(lower)) {
    return { category: "Charts & Infographics", styles: ["Infographic"], scenes: ["Education"] };
  }
  if (/character|avatar|toy|\u89d2\u8272|\u4eba\u7269|\u73a9\u5177/.test(lower)) {
    return { category: "Characters & People", styles: ["Character"], scenes: ["Creative"] };
  }
  if (/ui|app|dashboard|interface|\u754c\u9762|\u622a\u56fe/.test(lower)) {
    return { category: "UI & Interfaces", styles: ["UI"], scenes: ["Tech"] };
  }
  if (/story|scene|video|workflow|\u5206\u955c|\u573a\u666f|\u89c6\u9891|\u5de5\u4f5c\u6d41/.test(lower)) {
    return { category: "Scenes & Storytelling", styles: ["Scenes"], scenes: ["Story"] };
  }
  return { category: "Other Use Cases", styles: ["Other Use Cases"], scenes: ["Creative"] };
}

async function fetchWithTimeout(url) {
  try {
    if (process.platform === "win32" && process.env.USE_CURL_FETCH !== "0") {
      return await fetchWithCurl(url);
    }
    return await fetchWithNodeHttps(url);
  } catch (error) {
    if (process.platform === "win32") return fetchWithPowerShell(url);
    throw error;
  }
}

async function fetchWithCurl(url) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl.exe", [
      "-L",
      "--silent",
      "--show-error",
      "--connect-timeout",
      String(Math.ceil(REQUEST_TIMEOUT_MS / 1000)),
      "--max-time",
      String(Math.ceil((REQUEST_TIMEOUT_MS + 5000) / 1000)),
      "-A",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      "-H",
      "Accept: application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      "-w",
      "\n__HTTP_STATUS__:%{http_code}",
      url
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("curl request timeout"));
    }, REQUEST_TIMEOUT_MS + 9000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString("utf8");
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      const statusMatch = output.match(/\n__HTTP_STATUS__:(\d+)$/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const text = statusMatch ? output.slice(0, statusMatch.index) : output;
      if (code !== 0) {
        reject(new Error(errorText || `curl exited with ${code}`));
        return;
      }
      resolve({ ok: status >= 200 && status < 300, status, text });
    });
  });
}

async function fetchWithNodeHttps(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
          Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8"
        }
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, text });
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error("request timeout")));
    request.on("error", reject);
  });
}

async function fetchWithPowerShell(url) {
  const timeout = Math.ceil(REQUEST_TIMEOUT_MS / 1000);
  const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; (Invoke-WebRequest -Uri ${JSON.stringify(url)} -UseBasicParsing -TimeoutSec ${timeout} -Headers @{'User-Agent'='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36'; 'Accept'='application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8'}).Content`;
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("powershell request timeout"));
    }, REQUEST_TIMEOUT_MS + 8000);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = Buffer.concat(stdout).toString("utf8");
      const errorText = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0 && text) resolve({ ok: true, status: 200, text });
      else reject(new Error(errorText || `PowerShell exited with ${code}`));
    });
  });
}

async function loadCreators(client) {
  const result = await client.query(
    `SELECT id, handle, profile_url
     FROM twitter_creators
     WHERE monitor_enabled = true
     ORDER BY source_case_count DESC, latest_case_id DESC NULLS LAST, id
     LIMIT $1`,
    [MAX_CREATORS]
  );
  return result.rows;
}

async function markCreator(client, id, status, error = null) {
  await client.query(
    `UPDATE twitter_creators
     SET last_scraped_at = now(),
         last_scrape_status = $2,
         last_scrape_error = $3
     WHERE id = $1`,
    [id, status, error ? String(error).slice(0, 500) : null]
  );
}

async function updateCreatorProfile(client, id, profile = {}) {
  if (!profile.displayName && !profile.avatarUrl) return;
  await client.query(
    `UPDATE twitter_creators
     SET display_name = COALESCE(NULLIF($2, ''), display_name),
         avatar_url = COALESCE(NULLIF($3, ''), avatar_url)
     WHERE id = $1`,
    [id, profile.displayName || null, profile.avatarUrl || null]
  );
}

async function tweetAlreadySeen(client, tweetId) {
  if (!tweetId) return false;
  const result = await client.query("SELECT 1 FROM raw_prompt_templates WHERE source_tweet_id = $1 LIMIT 1", [tweetId]);
  return result.rowCount > 0;
}

function parseRssItem(item, creator, rssBase) {
  const title = stripHtml(extractTag(item, "title"));
  const rawDescription = extractTag(item, "description");
  const description = stripHtml(rawDescription);
  const text = description || title;
  const guid = stripHtml(extractTag(item, "guid"));
  const link = stripHtml(extractTag(item, "link"));
  const tweetId = (guid.match(/\d{12,}/) || link.match(/\/status\/(\d+)/))?.[1] || guid.match(/\d{12,}/)?.[0] || null;
  const pubDate = stripHtml(extractTag(item, "pubDate"));

  return {
    title,
    text,
    tweetId,
    link,
    sourceUrl: nitterLinkToX(link, creator.handle, tweetId),
    publishedAt: Number.isNaN(Date.parse(pubDate)) ? null : new Date(pubDate).toISOString(),
    images: extractImages(rawDescription, rssBase),
    isReply: isReply(title)
  };
}

async function insertPrompt(client, creator, parsed, inheritedImages = []) {
  const rawText = parsed.text;
  const text = extractPromptBody(rawText);
  const images = parsed.images.length ? parsed.images : inheritedImages;
  if (!images.length) return { inserted: false, reason: "no_image" };
  if (!isLikelyPrompt(rawText)) return { inserted: false, reason: "not_prompt" };
  if (!parsed.isReply && saysPromptInComments(rawText)) return { inserted: false, reason: "prompt_in_comments_main_post" };

  let archivedImages = [];
  try {
    archivedImages = await archiveImages(images, {
      group: "twitter",
      handle: creator.handle,
      tweetId: parsed.tweetId
    });
  } catch (error) {
    return { inserted: false, reason: `image_archive_failed:${error.message}` };
  }
  if (!archivedImages.length) return { inserted: false, reason: "image_archive_empty" };

  const promptHash = createHash("md5").update(text).digest("hex");
  const { category, styles, scenes } = classifyPrompt(text);
  const result = await client.query(
    `INSERT INTO raw_prompt_templates
      (creator_id, source_platform, source_handle, source_url, source_tweet_id,
       title, original_image_url, original_image_urls, image_url, image_urls, image_alt,
       prompt, prompt_preview, category, styles, scenes,
       metadata, source_published_at, scraped_at)
     VALUES
      ($1, 'x', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now())
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      creator.id,
      creator.handle,
      parsed.sourceUrl,
      parsed.tweetId,
      titleFromText(text),
      images[0],
      images,
      archivedImages[0],
      archivedImages,
      titleFromText(text),
      text,
      previewFromText(text),
      category,
      styles,
      scenes,
      {
        rssBase: RSS_BASE,
        nitterLink: parsed.link || null,
        originalTitle: parsed.title || null,
        originalText: rawText,
        originalImageUrls: images,
        imageUrls: archivedImages,
        ownImageUrls: parsed.images,
        inheritedImages: parsed.images.length === 0,
        contentHash: promptHash,
        scrapeVersion: 3
      },
      parsed.publishedAt
    ]
  );
  return { inserted: result.rowCount === 1, reason: result.rowCount === 1 ? "inserted" : "duplicate" };
}

async function fetchCreatorRss(handle) {
  const errors = [];
  for (const base of RSS_BASES) {
    const url = `${base}/${handle}/rss`;
    try {
      const response = await fetchWithTimeout(url);
      if (response.ok) return { ...response, base, url };
      errors.push(`${base}:HTTP_${response.status}`);
    } catch (error) {
      errors.push(`${base}:${error.message}`);
    }
  }
  throw new Error(errors.join(" | "));
}

async function scrapeCreator(client, creator) {
  const handle = creator.handle.replace(/^@/, "");
  let response;
  try {
    response = await fetchCreatorRss(handle);
  } catch (error) {
    await markCreator(client, creator.id, "error", error.message);
    return { handle: creator.handle, fetched: 0, inserted: 0, skipped: 0, error: error.message };
  }

  await updateCreatorProfile(client, creator.id, parseChannelProfile(response.text, response.base));

  const parsedItems = parseItems(response.text)
    .slice(0, MAX_ITEMS_PER_CREATOR)
    .map((item) => parseRssItem(item, creator, response.base))
    .filter((item) => item.tweetId && item.sourceUrl);

  let inserted = 0;
  let skipped = 0;
  let cachedCommentImages = [];

  for (const item of parsedItems) {
    const oldGalleryTweet = await tweetAlreadySeen(client, item.tweetId);
    if (oldGalleryTweet) {
      skipped += 1;
      if (item.images.length && saysPromptInComments(item.text)) cachedCommentImages = item.images;
      continue;
    }

    if (!item.isReply && item.images.length && saysPromptInComments(item.text)) {
      cachedCommentImages = item.images;
      skipped += 1;
      continue;
    }

    const result = await insertPrompt(client, creator, item, cachedCommentImages);
    if (result.inserted) inserted += 1;
    else skipped += 1;

    if (!item.isReply && !saysPromptInComments(item.text)) {
      cachedCommentImages = [];
    }
  }

  await markCreator(client, creator.id, "ok", null);
  return { handle: creator.handle, fetched: parsedItems.length, inserted, skipped };
}

const pool = createPool();
const client = await pool.connect();
const summary = { rssBases: RSS_BASES, creators: 0, fetchedItems: 0, inserted: 0, skipped: 0, errors: 0, details: [] };

try {
  const creators = await loadCreators(client);
  summary.creators = creators.length;
  for (const [index, creator] of creators.entries()) {
    try {
      const result = await scrapeCreator(client, creator);
      summary.fetchedItems += result.fetched || 0;
      summary.inserted += result.inserted || 0;
      summary.skipped += result.skipped || 0;
      if (result.error) summary.errors += 1;
      if (result.inserted || result.error) summary.details.push(result);
      console.log(`[${index + 1}/${creators.length}] ${creator.handle}: fetched=${result.fetched} inserted=${result.inserted} skipped=${result.skipped}${result.error ? ` error=${result.error}` : ""}`);
    } catch (error) {
      summary.errors += 1;
      summary.details.push({ handle: creator.handle, error: error.message });
      await markCreator(client, creator.id, "error", error.message).catch(() => {});
      console.log(`[${index + 1}/${creators.length}] ${creator.handle}: error=${error.message}`);
    }
    if (DELAY_MS > 0 && index < creators.length - 1) await sleep(DELAY_MS);
  }
} finally {
  client.release();
  await pool.end();
}

console.log(JSON.stringify(summary, null, 2));
