import { createHash } from "node:crypto";
import https from "node:https";
import { spawn } from "node:child_process";
import { createPool } from "./db.js";

const SEARCH_BASES = (process.env.NITTER_SEARCH_BASES || "https://xcancel.com,https://nitter.net")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20000);
const USER_AGENT = process.env.DISCOVERY_USER_AGENT || "Mozilla/5.0";
const QUERY_DELAY_MS = Number(process.env.DISCOVERY_DELAY_MS || 900);
const MAX_RESULTS_PER_QUERY = Number(process.env.MAX_RESULTS_PER_QUERY || 30);
const MIN_DISCOVERY_SCORE = Number(process.env.MIN_DISCOVERY_SCORE || 4);
const MAX_SEED_CREATORS = Number(process.env.MAX_SEED_CREATORS || 40);
const MAX_ITEMS_PER_SEED = Number(process.env.MAX_ITEMS_PER_SEED || 25);
const DISCOVERY_MODE = process.env.DISCOVERY_MODE || "search,seeds";

const defaultQueries = [
  "GPT image prompt",
  "ChatGPT image prompt",
  "GPT-4o image prompt",
  "AI image prompt",
  "image generation prompt",
  "Midjourney prompt",
  "Nano Banana prompt",
  "\u751f\u56fe \u63d0\u793a\u8bcd",
  "\u63d0\u793a\u8bcd \u8bc4\u8bba\u533a \u751f\u56fe",
  "AI \u751f\u56fe \u63d0\u793a\u8bcd",
  "ChatGPT \u751f\u56fe \u63d0\u793a\u8bcd",
  "\u5373\u68a6 \u63d0\u793a\u8bcd"
];

const queries = (process.env.DISCOVERY_QUERIES || defaultQueries.join("|"))
  .split("|")
  .map((item) => item.trim())
  .filter(Boolean);

const creatorBoosts = [
  /prompt/i,
  /image/i,
  /gpt/i,
  /ai/i,
  /midjourney/i,
  /stable\s*diffusion/i,
  /\u63d0\u793a\u8bcd/,
  /\u751f\u56fe/,
  /\u6444\u5f71/,
  /\u6d77\u62a5/
];

const creatorRejects = [
  /^x$/i,
  /^twitter$/i,
  /^home$/i,
  /^settings$/i,
  /^search$/i,
  /^i$/i
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

function candidateHandle(value = "") {
  const handle = String(value).replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9_]{2,20}$/.test(handle)) return null;
  if (creatorRejects.some((pattern) => pattern.test(handle))) return null;
  return `@${handle}`;
}

function handlesFromText(...values) {
  const handles = new Set();
  for (const value of values) {
    for (const match of String(value || "").matchAll(/(?:^|[^\w])@([A-Za-z0-9_]{2,20})\b/g)) {
      const handle = candidateHandle(match[1]);
      if (handle) handles.add(handle);
    }
  }
  return [...handles];
}

function handleFromLink(link = "") {
  const clean = decodeEntities(link);
  const match = clean.match(/https?:\/\/[^/]+\/([A-Za-z0-9_]{2,20})\/status\/(\d{12,})/i);
  const handle = candidateHandle(match?.[1]);
  return handle ? { handle, tweetId: match[2], sourceUrl: `https://x.com/${handle.slice(1)}/status/${match[2]}` } : null;
}

function normalizeProfileUrl(handle) {
  return `https://x.com/${handle.replace(/^@/, "")}`;
}

function scoreCandidate({ query, title, text, images, handle }) {
  const haystack = `${query}\n${title}\n${text}\n${handle}`;
  let score = 0;
  if (images > 0) score += 2;
  for (const pattern of creatorBoosts) {
    if (pattern.test(haystack)) score += 1;
  }
  if (/\b(prompt|keywords?|style|composition|camera|lens|portrait|poster)\b/i.test(text)) score += 2;
  if (/(\u63d0\u793a\u8bcd|\u751f\u56fe|\u6784\u56fe|\u955c\u5934|\u6d77\u62a5)/.test(text)) score += 2;
  return score;
}

function extractImages(description = "") {
  return [...description.matchAll(/<img[^>]+src=["']([^"']+)["']/gi)].length;
}

function parseSearchItem(item, query, base) {
  const rawDescription = extractTag(item, "description");
  const title = stripHtml(extractTag(item, "title"));
  const text = stripHtml(rawDescription) || title;
  const link = stripHtml(extractTag(item, "link"));
  const pubDate = stripHtml(extractTag(item, "pubDate"));
  const fromLink = handleFromLink(link);
  const handles = new Set(handlesFromText(title, text));
  if (fromLink?.handle) handles.add(fromLink.handle);
  const images = extractImages(rawDescription);

  return [...handles].map((handle) => ({
    handle,
    profileUrl: normalizeProfileUrl(handle),
    displayName: title.match(/^(.+?)\s+\(@[A-Za-z0-9_]{2,20}\)/)?.[1]?.trim() || null,
    query,
    source: base,
    title,
    text,
    images,
    sourceUrl: fromLink?.sourceUrl || link || null,
    tweetId: fromLink?.tweetId || null,
    publishedAt: Number.isNaN(Date.parse(pubDate)) ? null : new Date(pubDate).toISOString()
  }));
}

function parseTimelineItem(item, seedCreator, base) {
  const rawDescription = extractTag(item, "description");
  const title = stripHtml(extractTag(item, "title"));
  const text = stripHtml(rawDescription) || title;
  const link = stripHtml(extractTag(item, "link"));
  const guid = stripHtml(extractTag(item, "guid"));
  const tweetId = (guid.match(/\d{12,}/) || link.match(/\/status\/(\d+)/))?.[1] || null;
  const pubDate = stripHtml(extractTag(item, "pubDate"));
  const handles = handlesFromText(title, text).filter((handle) => handle.toLowerCase() !== seedCreator.handle.toLowerCase());
  const images = extractImages(rawDescription);

  return handles.map((handle) => ({
    handle,
    profileUrl: normalizeProfileUrl(handle),
    displayName: null,
    query: `seed:${seedCreator.handle}`,
    source: `${base}/seed-rss`,
    title: title || `${seedCreator.handle} mentions ${handle}`,
    text,
    images,
    sourceUrl: tweetId ? `https://x.com/${seedCreator.handle.replace(/^@/, "")}/status/${tweetId}` : link || null,
    tweetId,
    publishedAt: Number.isNaN(Date.parse(pubDate)) ? null : new Date(pubDate).toISOString()
  }));
}

function parseSearchHtml(html, query, base) {
  const candidates = [];
  const statusPattern = /href=["']\/([A-Za-z0-9_]{2,20})\/status\/(\d{12,})[^"']*["'][\s\S]{0,1800}?(?:class=["'][^"']*tweet-content[^"']*["'][^>]*>([\s\S]*?)<\/div>|$)/gi;
  for (const match of html.matchAll(statusPattern)) {
    const handle = candidateHandle(match[1]);
    if (!handle) continue;
    const tweetId = match[2];
    const text = stripHtml(match[3] || "");
    candidates.push({
      handle,
      profileUrl: normalizeProfileUrl(handle),
      displayName: null,
      query,
      source: `${base}/search`,
      title: text ? text.slice(0, 120) : `${handle} search result`,
      text: text || query,
      images: 0,
      sourceUrl: `https://x.com/${handle.slice(1)}/status/${tweetId}`,
      tweetId,
      publishedAt: null
    });
  }
  return candidates;
}

function discoveryHash(candidate) {
  return createHash("md5").update(`${candidate.handle}|${candidate.query}|${candidate.sourceUrl || ""}`).digest("hex");
}

function cleanTextForDb(value, maxLength = 2000) {
  if (value == null) return value;
  return String(value)
    .replace(/\u0000/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .slice(0, maxLength);
}

function cleanJsonValue(value) {
  if (typeof value === "string") return cleanTextForDb(value, 2000);
  if (Array.isArray(value)) return value.map((item) => cleanJsonValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [cleanTextForDb(key, 200), cleanJsonValue(item)]));
  }
  return value;
}

async function fetchWithNodeHttps(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      url,
      {
        timeout: REQUEST_TIMEOUT_MS,
        headers: {
          "User-Agent": USER_AGENT,
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
  const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; $ProgressPreference='SilentlyContinue'; $uri=${JSON.stringify(url)}; (Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec ${timeout} -Headers @{'User-Agent'=${JSON.stringify(USER_AGENT)}; 'Accept'='application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8'}).Content`;
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
      if (code === 0) resolve({ ok: true, status: 200, text });
      else reject(new Error(errorText || `PowerShell exited with ${code}`));
    });
  });
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
      USER_AGENT,
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

async function searchQuery(query) {
  const errors = [];
  for (const base of SEARCH_BASES) {
    const root = base.replace(/\/$/, "");
    const rssUrl = `${root}/search/rss?f=tweets&q=${encodeURIComponent(query)}`;
    try {
      const response = await fetchWithTimeout(rssUrl);
      if (response.ok && response.text && !/RSS reader not yet whitelist/i.test(response.text)) {
        const items = parseItems(response.text).slice(0, MAX_RESULTS_PER_QUERY);
        if (items.length) {
          const candidates = items.flatMap((item) => parseSearchItem(item, query, base));
          if (candidates.length) {
            return {
              base: `${base}/rss`,
              errors,
              candidates
            };
          }
        }
      }
    } catch (error) {
      errors.push({ base: `${base}/rss`, error: error.message });
    }

    const htmlUrl = `${root}/search?f=tweets&q=${encodeURIComponent(query)}`;
    try {
      const response = await fetchWithTimeout(htmlUrl);
      if (!response.ok || !response.text) continue;
      const candidates = parseSearchHtml(response.text, query, base).slice(0, MAX_RESULTS_PER_QUERY);
      if (!candidates.length) continue;
      return {
        base: `${base}/html`,
        errors,
        candidates
      };
    } catch (error) {
      errors.push({ base: `${base}/html`, error: error.message });
    }
  }
  return { base: null, errors, candidates: [] };
}

async function loadSeedCreators(client) {
  const result = await client.query(
    `SELECT id, handle, profile_url
     FROM twitter_creators
     WHERE monitor_enabled = true
     ORDER BY discovery_score DESC, source_case_count DESC, latest_case_id DESC NULLS LAST, id
     LIMIT $1`,
    [MAX_SEED_CREATORS]
  );
  return result.rows;
}

async function discoverFromSeedCreator(seedCreator) {
  const errors = [];
  for (const base of SEARCH_BASES) {
    const root = base.replace(/\/$/, "");
    const handle = seedCreator.handle.replace(/^@/, "");
    const url = `${root}/${handle}/rss`;
    try {
      const response = await fetchWithTimeout(url);
      if (!response.ok || !response.text) continue;
      const items = parseItems(response.text).slice(0, MAX_ITEMS_PER_SEED);
      const candidates = items.flatMap((item) => parseTimelineItem(item, seedCreator, base));
      return { base: `${base}/seed-rss`, errors, candidates };
    } catch (error) {
      errors.push({ base: `${base}/seed-rss`, error: error.message });
    }
  }
  return { base: null, errors, candidates: [] };
}

async function upsertCreator(client, candidate) {
  const score = scoreCandidate(candidate);
  if (score < MIN_DISCOVERY_SCORE) return { inserted: false, skipped: true, score };
  const metadata = cleanJsonValue({
    [`discovery:${discoveryHash(candidate)}`]: {
      query: candidate.query,
      source: candidate.source,
      sourceUrl: candidate.sourceUrl,
      tweetId: candidate.tweetId,
      title: candidate.title,
      textPreview: candidate.text.slice(0, 300),
      images: candidate.images,
      score
    }
  });
  const result = await client.query(
    `INSERT INTO twitter_creators
      (handle, profile_url, display_name, source_case_count, status_link_count,
       monitor_enabled, discovery_source, discovery_query, discovery_score,
       discovery_metadata, first_discovered_at, last_discovered_at, last_seen_at)
     VALUES
      ($1, $2, $3, 0, 1, true, $4, $5, $6, $7::jsonb, now(), now(), $8)
     ON CONFLICT (handle_normalized) DO UPDATE
     SET profile_url = COALESCE(NULLIF(EXCLUDED.profile_url, ''), twitter_creators.profile_url),
         display_name = COALESCE(EXCLUDED.display_name, twitter_creators.display_name),
         status_link_count = twitter_creators.status_link_count + 1,
         discovery_source = COALESCE(EXCLUDED.discovery_source, twitter_creators.discovery_source),
         discovery_query = EXCLUDED.discovery_query,
         discovery_score = GREATEST(twitter_creators.discovery_score, EXCLUDED.discovery_score),
         discovery_metadata = twitter_creators.discovery_metadata || EXCLUDED.discovery_metadata,
         first_discovered_at = COALESCE(twitter_creators.first_discovered_at, now()),
         last_discovered_at = now(),
         last_seen_at = GREATEST(COALESCE(twitter_creators.last_seen_at, '-infinity'::timestamptz), COALESCE(EXCLUDED.last_seen_at, now()))
     RETURNING id, (xmax = 0) AS inserted`,
    [
      candidate.handle,
      cleanTextForDb(candidate.profileUrl, 500),
      cleanTextForDb(candidate.displayName, 200),
      cleanTextForDb(candidate.source, 500),
      cleanTextForDb(candidate.query, 500),
      score,
      JSON.stringify(metadata),
      candidate.publishedAt
    ]
  );
  return { inserted: result.rows[0]?.inserted === true, skipped: false, score, id: result.rows[0]?.id };
}

const pool = createPool();
const client = await pool.connect();
const summary = {
  searchBases: SEARCH_BASES,
  mode: DISCOVERY_MODE,
  queries: queries.length,
  seedCreators: 0,
  candidates: 0,
  inserted: 0,
  updated: 0,
  skipped: 0,
  errors: 0,
  details: []
};

async function writeCandidates(client, label, result) {
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const seenHandles = new Set();
  for (const candidate of result.candidates) {
    if (seenHandles.has(candidate.handle)) continue;
    seenHandles.add(candidate.handle);
    summary.candidates += 1;
    try {
      const write = await upsertCreator(client, candidate);
      if (write.skipped) skipped += 1;
      else if (write.inserted) inserted += 1;
      else updated += 1;
    } catch (error) {
      skipped += 1;
      summary.errors += 1;
      summary.details.push({ label, handle: candidate.handle, error: error.message });
    }
  }
  summary.inserted += inserted;
  summary.updated += updated;
  summary.skipped += skipped;
  summary.details.push({ label, base: result.base, candidates: result.candidates.length, inserted, updated, skipped, errors: result.errors });
  return { inserted, updated, skipped };
}

try {
  if (DISCOVERY_MODE.includes("search")) {
    for (const [index, query] of queries.entries()) {
      try {
        const result = await searchQuery(query);
        const written = await writeCandidates(client, `search:${query}`, result);
        console.log(`[search ${index + 1}/${queries.length}] ${query}: base=${result.base || "none"} candidates=${result.candidates.length} inserted=${written.inserted} updated=${written.updated} skipped=${written.skipped}`);
      } catch (error) {
        summary.errors += 1;
        summary.details.push({ label: `search:${query}`, error: error.message });
        console.log(`[search ${index + 1}/${queries.length}] ${query}: error=${error.message}`);
      }
      if (QUERY_DELAY_MS > 0 && index < queries.length - 1) await sleep(QUERY_DELAY_MS);
    }
  }

  if (DISCOVERY_MODE.includes("seeds")) {
    const seeds = await loadSeedCreators(client);
    summary.seedCreators = seeds.length;
    for (const [index, seed] of seeds.entries()) {
      try {
        const result = await discoverFromSeedCreator(seed);
        const written = await writeCandidates(client, `seed:${seed.handle}`, result);
        console.log(`[seed ${index + 1}/${seeds.length}] ${seed.handle}: base=${result.base || "none"} candidates=${result.candidates.length} inserted=${written.inserted} updated=${written.updated} skipped=${written.skipped}`);
      } catch (error) {
        summary.errors += 1;
        summary.details.push({ label: `seed:${seed.handle}`, error: error.message });
        console.log(`[seed ${index + 1}/${seeds.length}] ${seed.handle}: error=${error.message}`);
      }
      if (QUERY_DELAY_MS > 0 && index < seeds.length - 1) await sleep(QUERY_DELAY_MS);
    }
  }
} finally {
  client.release();
  await pool.end();
}

console.log(JSON.stringify(summary, null, 2));
