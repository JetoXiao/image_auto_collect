import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { archiveImageRecords } from "./image-archive.js";
import { createPool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const csvPath = path.join(projectRoot, "twitter_prompt_sources.csv");
const galleryUrl = process.env.PROMPTBAY_API_URL || "http://43.167.208.107/api/prompts?limit=1000";
const galleryBaseUrl = "http://43.167.208.107";
const fallbackSourceHandle = "@PromptBayAdmin";
const maxImportCases = Number(process.env.MAX_IMPORT_CASES || 0);

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (char !== "\r") {
      cell += char;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const [header, ...records] = rows.filter((item) => item.length > 1);
  const cleanHeader = header.map((key) => key.replace(/^\uFEFF/, ""));
  return records.map((record) => Object.fromEntries(cleanHeader.map((key, index) => [key, record[index] || ""])));
}

function normalizeHandle(handle) {
  if (!handle) return "";
  const match = String(handle).match(/^@?([A-Za-z0-9_]{1,20})$/);
  return match ? `@${match[1]}` : "";
}

function normalizeAuthorHandle(author = "") {
  const direct = normalizeHandle(author);
  if (direct) return direct;
  const compact = String(author).replace(/[^A-Za-z0-9_]+/g, "");
  return normalizeHandle(compact) || fallbackSourceHandle;
}

function extractHandle(sourceUrl = "", sourceLabel = "") {
  const fromUrl = String(sourceUrl).match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,20})/i);
  if (fromUrl) return `@${fromUrl[1]}`;
  const fromLabelUrl = String(sourceLabel).match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,20})/i);
  if (fromLabelUrl) return `@${fromLabelUrl[1]}`;
  const fromAtLabel = String(sourceLabel).match(/(^|\s)@([A-Za-z0-9_]{1,20})(\s|$)/);
  return fromAtLabel ? `@${fromAtLabel[2]}` : "";
}

function extractTweetId(sourceUrl = "", sourceLabel = "") {
  const match = `${sourceUrl} ${sourceLabel}`.match(/\/status\/(\d+)/);
  return match ? match[1] : null;
}

function numericCaseId(value) {
  const match = String(value || "").match(/\d+/);
  return match ? Number(match[0]) : null;
}

function absolutizeImage(image) {
  if (!image) return null;
  if (/^https?:\/\//i.test(image)) return image;
  return `${galleryBaseUrl}${image.startsWith("/") ? "" : "/"}${image}`;
}

function archiveContext(handle, item) {
  return {
    group: item.sourcePlatform || "seed",
    handle,
    tweetId: extractTweetId(item.sourceUrl, item.sourceLabel),
    caseId: item.id || item.externalCaseId
  };
}

function normalizeCategory(category = "", tags = []) {
  const value = String(category || "").trim();
  const map = new Map([
    ["摄影与写实", "Photography & Realism"],
    ["人物与角色", "Characters & People"],
    ["海报与排版", "Posters & Typography"],
    ["插画与艺术", "Illustration & Art"],
    ["品牌与标志", "Brand & Logo"],
    ["图表与信息可视化", "Charts & Infographics"],
    ["场景与叙事", "Scenes & Storytelling"],
    ["建筑与空间", "Architecture & Space"],
    ["商品与电商", "Products & E-commerce"],
    ["文档与出版物", "Documents & Publishing"],
    ["UI 与界面", "UI & Interfaces"],
    ["历史与古风题材", "History & Classical"],
    ["其他应用场景", "Other Use Cases"]
  ]);
  if (map.has(value)) return map.get(value);
  const tagText = tags.join(" ").toLowerCase();
  if (/realistic|photography/.test(tagText)) return "Photography & Realism";
  if (/poster|typography/.test(tagText)) return "Posters & Typography";
  if (/ui|interface/.test(tagText)) return "UI & Interfaces";
  if (/brand|logo/.test(tagText)) return "Brand & Logo";
  if (/infographic|chart/.test(tagText)) return "Charts & Infographics";
  return value || "Other Use Cases";
}

function splitTags(tags = []) {
  const styleSet = new Set([
    "UI",
    "Poster",
    "Realistic",
    "Photography",
    "Infographic",
    "Charts",
    "Illustration",
    "Character",
    "Brand",
    "Product",
    "Classical",
    "Other Use Cases"
  ]);
  const sceneSet = new Set(["Tech", "Social", "Creative", "Education", "Travel", "Commerce", "Fashion", "Food", "Story"]);
  const styles = tags.filter((tag) => styleSet.has(tag));
  const scenes = tags.filter((tag) => sceneSet.has(tag));
  return {
    styles: styles.length ? styles : ["Other Use Cases"],
    scenes: scenes.length ? scenes : ["Creative"]
  };
}

function normalizePromptItem(item, payload = {}) {
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const handle = extractHandle(item.sourceUrl, item.sourceLabel) || normalizeAuthorHandle(item.author);
  const originalImage = absolutizeImage(item.image);
  const { styles, scenes } = splitTags(tags);
  return {
    id: item.id,
    externalCaseId: String(item.id || item.caseId || item.title || ""),
    sourcePlatform: item.sourceUrl?.includes("x.com/") || item.sourceUrl?.includes("twitter.com/") ? "x" : "promptbay",
    sourceHandle: handle,
    sourceUrl: item.sourceUrl || `${galleryBaseUrl}/prompts/${encodeURIComponent(String(item.id || ""))}`,
    sourceTweetId: extractTweetId(item.sourceUrl, item.sourceLabel),
    title: item.title || "PromptBay prompt",
    originalImages: originalImage ? [originalImage] : [],
    imageAlt: item.imageAlt || item.title || null,
    prompt: item.prompt || "",
    promptPreview: item.promptPreview || `${String(item.prompt || "").slice(0, 180)}${String(item.prompt || "").length > 180 ? "..." : ""}`,
    category: normalizeCategory(item.category, tags),
    styles,
    scenes,
    metadata: {
      sourceLabel: item.sourceLabel || item.author || null,
      githubUrl: item.githubUrl || null,
      featured: Boolean(item.featured),
      promptbayId: item.id || null,
      tags,
      uses: item.uses ?? null,
      likes: item.likes ?? null,
      model: item.model || null,
      ratio: item.ratio || null,
      cost: item.cost ?? null,
      importedFrom: payload.repository || galleryUrl
    }
  };
}

function promptItemsFromPayload(payload) {
  if (Array.isArray(payload?.cases)) return payload.cases.map((item) => ({
    id: item.id,
    externalCaseId: `gallery_case_${item.id}`,
    sourcePlatform: "x",
    sourceHandle: extractHandle(item.sourceUrl, item.sourceLabel),
    sourceUrl: item.sourceUrl || null,
    sourceTweetId: extractTweetId(item.sourceUrl, item.sourceLabel),
    title: item.title || null,
    originalImages: item.image ? [absolutizeImage(item.image)] : [],
    imageAlt: item.imageAlt || null,
    prompt: item.prompt || "",
    promptPreview: item.promptPreview || `${String(item.prompt || "").slice(0, 180)}${String(item.prompt || "").length > 180 ? "..." : ""}`,
    category: item.category || "Other Use Cases",
    styles: item.styles || [],
    scenes: item.scenes || [],
    metadata: {
      sourceLabel: item.sourceLabel || null,
      githubUrl: item.githubUrl || null,
      featured: Boolean(item.featured),
      importedFrom: payload.repository || galleryUrl
    }
  }));
  return (payload?.prompts || payload?.items || payload?.data || []).map((item) => normalizePromptItem(item, payload));
}

async function upsertCreator(client, creator) {
  const handle = normalizeHandle(creator.handle);
  if (!handle) return null;
  const profileUrl = creator.profile_url || `https://x.com/${handle.slice(1)}`;
  const sampleCaseIds = String(creator.sample_case_ids || creator.sampleCases || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter(Number.isFinite);

  const result = await client.query(
    `INSERT INTO twitter_creators
      (handle, profile_url, source_case_count, status_link_count, latest_case_id, latest_case_title, sample_case_ids, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (handle_normalized) DO UPDATE SET
      profile_url = EXCLUDED.profile_url,
      source_case_count = GREATEST(twitter_creators.source_case_count, EXCLUDED.source_case_count),
      status_link_count = GREATEST(twitter_creators.status_link_count, EXCLUDED.status_link_count),
      latest_case_id = CASE
        WHEN EXCLUDED.latest_case_id IS NOT NULL
          AND (twitter_creators.latest_case_id IS NULL OR EXCLUDED.latest_case_id > twitter_creators.latest_case_id)
        THEN EXCLUDED.latest_case_id
        ELSE twitter_creators.latest_case_id
      END,
      latest_case_title = CASE
        WHEN EXCLUDED.latest_case_id IS NOT NULL
          AND (twitter_creators.latest_case_id IS NULL OR EXCLUDED.latest_case_id >= twitter_creators.latest_case_id)
        THEN COALESCE(EXCLUDED.latest_case_title, twitter_creators.latest_case_title)
        ELSE twitter_creators.latest_case_title
      END,
      sample_case_ids = CASE
        WHEN cardinality(EXCLUDED.sample_case_ids) > 0 THEN EXCLUDED.sample_case_ids
        ELSE twitter_creators.sample_case_ids
      END,
      last_seen_at = now()
     RETURNING id`,
    [
      handle,
      profileUrl,
      Number(creator.case_count || creator.source_case_count || 0),
      Number(creator.status_link_count || 0),
      creator.latest_case_id ? Number(creator.latest_case_id) : null,
      creator.latest_case_title || null,
      sampleCaseIds
    ]
  );
  return result.rows[0].id;
}

async function importCreators(client) {
  let count = 0;
  try {
    const csv = await fs.readFile(csvPath, "utf8");
    for (const row of parseCsv(csv)) {
      await upsertCreator(client, row);
      count += 1;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return count;
}

async function importCases(client) {
  const response = await fetch(galleryUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${galleryUrl}: ${response.status}`);
  }
  const gallery = await response.json();
  const promptItems = promptItemsFromPayload(gallery);
  let imported = 0;
  let skipped = 0;

  const selectedItems = maxImportCases > 0 ? promptItems.slice(0, maxImportCases) : promptItems;
  const imageRecords = selectedItems.flatMap((item) =>
    (item.originalImages || []).map((url, index) => ({
      url,
      context: {
        ...archiveContext(item.sourceHandle, item),
        index
      }
    }))
  );
  const archivedImageMap = await archiveImageRecords(imageRecords);

  for (const item of selectedItems) {
    const handle = item.sourceHandle;
    if (!handle) {
      skipped += 1;
      continue;
    }
    const creatorId = await upsertCreator(client, {
      handle,
      profile_url: `https://x.com/${handle.slice(1)}`,
      source_case_count: item.sourcePlatform === "promptbay" ? 1 : 0,
      status_link_count: item.sourceUrl?.includes("/status/") ? 1 : 0,
      latest_case_id: numericCaseId(item.id),
      latest_case_title: item.title,
      sample_case_ids: String(numericCaseId(item.id) || "")
    });

    const prompt = item.prompt || "";
    const promptPreview = item.promptPreview || `${prompt.slice(0, 180)}${prompt.length > 180 ? "..." : ""}`;
    const originalImages = item.originalImages || [];
    if (!originalImages.length) {
      skipped += 1;
      continue;
    }
    const archivedImages = originalImages.map((url) => archivedImageMap.get(url)).filter(Boolean);
    if (!archivedImages.length) {
      console.warn(`skip case ${item.id}: image archive missing`);
      skipped += 1;
      continue;
    }
    const result = await client.query(
      `INSERT INTO raw_prompt_templates
        (creator_id, source_platform, source_handle, source_url, source_tweet_id, external_case_id,
         title, original_image_url, original_image_urls, image_url, image_urls, image_alt,
         prompt, prompt_preview, category, styles, scenes, metadata, scraped_at)
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now())
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [
        creatorId,
        item.sourcePlatform,
        handle,
        item.sourceUrl,
        item.sourceTweetId,
        item.externalCaseId,
        item.title || null,
        originalImages[0],
        originalImages,
        archivedImages[0],
        archivedImages,
        item.imageAlt,
        prompt,
        promptPreview,
        item.category,
        item.styles,
        item.scenes,
        {
          originalImageUrls: originalImages,
          ...item.metadata
        }
      ]
    );
    imported += result.rowCount;
  }
  return { imported, skipped, total: promptItems.length, attempted: selectedItems.length };
}

const pool = createPool();
const client = await pool.connect();

try {
  const creators = await importCreators(client);
  const cases = await importCases(client);
  console.log(JSON.stringify({ creators, cases }, null, 2));
} catch (error) {
  throw error;
} finally {
  client.release();
  await pool.end();
}
