import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { archiveImages } from "./image-archive.js";
import { classifyPrompt, previewFromText, titleFromText } from "./prompt-classifier.js";
import { createPool } from "./db.js";

const SOURCE_BASE = (process.env.DOINGFB_BASE_URL || "https://prompt.doingfb.com").replace(/\/$/, "");
const PAGE_LIMIT = Math.min(100, Math.max(1, Number(process.env.DOINGFB_PAGE_LIMIT || 100)));
const MAX_ITEMS = Math.max(0, Number(process.env.DOINGFB_MAX_ITEMS || 0));
const DELAY_MS = Math.max(0, Number(process.env.DOINGFB_DELAY_MS || 250));
const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.DOINGFB_REQUEST_TIMEOUT_MS || 30000));

function normalizeAuthorName(value) {
  return String(value || "DoingFB").replace(/\s+/g, " ").trim().slice(0, 120) || "DoingFB";
}

function sourceUrl(item) {
  return `${SOURCE_BASE}/?prompt=${encodeURIComponent(item.id)}`;
}

function sourcePublishedAt(item) {
  const value = item.createdAt || item.updatedAt || item.generatedDate;
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
}

function normalizePrompt(item) {
  const prompt = String(item.promptText || "").trim();
  const images = [item.url || item.imageUrl].filter(Boolean);
  if (!item.id || !prompt || !images.length) return null;
  const title = String(item.title || titleFromText(prompt, "DoingFB prompt")).trim().slice(0, 180);
  const authorName = normalizeAuthorName(item.authorName || item.author?.username || item.author?.name);
  const classification = classifyPrompt(`${title}\n${prompt}\n${(item.tags || []).join(" ")}`);
  return {
    id: String(item.id),
    externalCaseId: `doingfb:${item.id}`,
    sourcePlatform: "doingfb",
    sourceHandle: "DoingFB",
    sourceUrl: sourceUrl(item),
    title,
    authorName,
    originalImages: images,
    imageAlt: title,
    prompt,
    promptPreview: previewFromText(prompt),
    category: classification.category,
    styles: classification.styles,
    scenes: classification.scenes,
    sourcePublishedAt: sourcePublishedAt(item),
    metadata: {
      importedFrom: SOURCE_BASE,
      doingfbId: item.id,
      imageKey: item.imageKey || null,
      visibility: item.visibility || null,
      generatedDate: item.generatedDate || null,
      description: item.description || null,
      tags: Array.isArray(item.tags) ? item.tags : [],
      authorName,
      author: item.author || null,
      scrapedSource: "doingfb"
    }
  };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
      }
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP_${response.status}${text ? `:${text.slice(0, 160)}` : ""}`);
    }
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function insertPrompt(client, item) {
  let archivedImages = [];
  try {
    archivedImages = await archiveImages(item.originalImages, {
      group: "doingfb",
      handle: item.sourceHandle,
      caseId: item.id
    });
  } catch (error) {
    return { inserted: false, reason: `image_archive_failed:${error.message}` };
  }

  if (!archivedImages.length) return { inserted: false, reason: "image_archive_empty" };

  const result = await client.query(
    `INSERT INTO raw_prompt_templates
      (creator_id, source_platform, source_handle, source_url, source_tweet_id, external_case_id,
       title, original_image_url, original_image_urls, image_url, image_urls, image_alt,
       prompt, prompt_preview, category, styles, scenes, metadata, source_published_at, scraped_at)
     VALUES
      ($1, $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now())
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      null,
      item.sourcePlatform,
      item.sourceHandle,
      item.sourceUrl,
      item.externalCaseId,
      item.title,
      item.originalImages[0],
      item.originalImages,
      archivedImages[0],
      archivedImages,
      item.imageAlt,
      item.prompt,
      item.promptPreview,
      item.category,
      item.styles,
      item.scenes,
      {
        ...item.metadata,
        originalImageUrls: item.originalImages,
        imageUrls: archivedImages,
        contentHash: createHash("md5").update(item.prompt).digest("hex"),
        scrapeVersion: 1
      },
      item.sourcePublishedAt
    ]
  );

  return { inserted: result.rowCount === 1, reason: result.rowCount === 1 ? "inserted" : "duplicate" };
}

function progressLine(summary, subject = "") {
  const total = summary.total || 0;
  const current = Math.min(summary.fetched, total || summary.fetched);
  console.log(
    `DOINGFB_PROGRESS current=${current} total=${total} fetched=${summary.fetched} inserted=${summary.inserted} skipped=${summary.skipped} errors=${summary.errors} subject=${subject}`
  );
}

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  const summary = {
    source: SOURCE_BASE,
    pageLimit: PAGE_LIMIT,
    total: 0,
    pages: 0,
    fetched: 0,
    attempted: 0,
    inserted: 0,
    skipped: 0,
    errors: 0,
    nextCursor: null,
    details: []
  };

  try {
    let cursor = "";
    while (true) {
      const params = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (cursor) params.set("cursor", cursor);
      const url = `${SOURCE_BASE}/api/prompts/public?${params.toString()}`;
      const payload = await fetchJson(url);
      const items = Array.isArray(payload.items) ? payload.items : [];
      summary.total = Number(payload.totalCount || summary.total || items.length);
      summary.pages += 1;

      for (const rawItem of items) {
        if (MAX_ITEMS && summary.fetched >= MAX_ITEMS) break;
        summary.fetched += 1;
        const item = normalizePrompt(rawItem);
        if (!item) {
          summary.skipped += 1;
          continue;
        }
        summary.attempted += 1;
        try {
          const result = await insertPrompt(client, item);
          if (result.inserted) summary.inserted += 1;
          else summary.skipped += 1;
          if (result.inserted || result.reason !== "duplicate") {
            summary.details.push({ id: item.id, title: item.title, result: result.reason });
          }
        } catch (error) {
          summary.errors += 1;
          summary.details.push({ id: item.id, title: item.title, error: error.message });
        }
      }

      progressLine(summary, cursor || "first-page");

      if (MAX_ITEMS && summary.fetched >= MAX_ITEMS) break;
      cursor = payload.nextCursor || "";
      summary.nextCursor = cursor || null;
      if (!cursor || !items.length) break;
      if (DELAY_MS) await sleep(DELAY_MS);
    }
  } finally {
    client.release();
    await pool.end();
  }

  summary.details = summary.details.slice(-80);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(`DOINGFB_ERROR ${error.stack || error.message}`);
  process.exit(1);
});
