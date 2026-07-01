import pg from "pg";
import { createPool } from "./db.js";

const { Pool } = pg;

const targetSystem = process.env.AWESOME_TARGET_SYSTEM || "awesome-image2-web";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const syncAll = args.includes("--all");
const retryFailed = process.env.SYNC_RETRY_FAILED !== "0";
const batchSize = readNumberArg("--limit", Number(process.env.SYNC_BATCH_SIZE || 200));
const categoryBatchSize = readNumberArg("--category-limit", Number(process.env.SYNC_CATEGORY_BATCH_SIZE || 100));

function readNumberArg(name, fallback) {
  const prefix = `${name}=`;
  const match = args.find((arg) => arg.startsWith(prefix));
  const value = match ? Number(match.slice(prefix.length)) : fallback;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function createTargetPool() {
  if (process.env.AWESOME_DATABASE_URL || process.env.PROMPTBAY_DATABASE_URL) {
    return new Pool({
      connectionString: process.env.AWESOME_DATABASE_URL || process.env.PROMPTBAY_DATABASE_URL,
      max: 5
    });
  }

  return new Pool({
    host: process.env.AWESOME_PGHOST || process.env.PROMPTBAY_PGHOST || "awesome-image2-postgres",
    port: Number(process.env.AWESOME_PGPORT || process.env.PROMPTBAY_PGPORT || 5432),
    database: process.env.AWESOME_PGDATABASE || process.env.PROMPTBAY_PGDATABASE || "promptbay",
    user: process.env.AWESOME_PGUSER || process.env.PROMPTBAY_PGUSER || "promptbay",
    password: process.env.AWESOME_PGPASSWORD || process.env.PROMPTBAY_PGPASSWORD || "promptbay",
    max: 5
  });
}

function syncStatuses() {
  if (syncAll) return null;
  return retryFailed ? ["pending", "failed"] : ["pending"];
}

function imageMimeType(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith(".png")) return "image/png";
    if (pathname.endsWith(".webp")) return "image/webp";
    if (pathname.endsWith(".gif")) return "image/gif";
    if (pathname.endsWith(".avif")) return "image/avif";
  } catch {
    // Fall through to the target app's common case.
  }
  return "image/jpeg";
}

function cleanText(value, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim();
}

function cleanTextBlock(value, fallback = "") {
  return String(value || fallback).replace(/\r\n?/g, "\n").trim();
}

function uniqueTags(value) {
  const items = Array.isArray(value) ? value : [];
  return [...new Set(items.map((item) => cleanText(item)).filter(Boolean))].slice(0, 12);
}

function imageUrls(value) {
  const items = Array.isArray(value) ? value : [];
  return [...new Set(items.map((item) => cleanText(item)).filter(Boolean))];
}

function promptPayload(row) {
  const title = cleanText(row.title, `Prompt ${row.approved_prompt_id}`).slice(0, 180);
  const description = cleanText(row.description || row.positive_prompt, title).slice(0, 500);
  return {
    id: row.target_prompt_id,
    slug: row.target_slug,
    title,
    description,
    positivePrompt: cleanTextBlock(row.positive_prompt),
    negativePrompt: cleanTextBlock(row.negative_prompt),
    category: cleanText(row.category, "其他应用场景"),
    tags: uniqueTags(row.tags),
    model: cleanText(row.model, "gpt-image-2"),
    ratio: cleanText(row.ratio, "auto"),
    quality: cleanText(row.quality) || null,
    costCredits: Number(row.cost_credits || 10),
    reviewedAt: row.approved_at || new Date()
  };
}

async function ensureLocalSyncRows(source) {
  await source.query(
    `INSERT INTO approved_prompt_syncs (approved_prompt_id, target_system, target_prompt_id, target_slug)
     SELECT id, $1, 'iac_prompt_' || id::text, 'image-auto-' || id::text
     FROM approved_prompt_templates
     ON CONFLICT (approved_prompt_id, target_system) DO NOTHING`,
    [targetSystem]
  );
}

async function loadCategoryEvents(source) {
  const statuses = syncStatuses();
  const params = [targetSystem, categoryBatchSize];
  const statusClause = statuses ? "AND sync_status = ANY($3::text[])" : "";
  if (statuses) params.push(statuses);
  const result = await source.query(
    `SELECT *
     FROM prompt_category_sync_events
     WHERE target_system = $1
       ${statusClause}
     ORDER BY id ASC
     LIMIT $2`,
    params
  );
  return result.rows;
}

async function markCategoryEvent(source, event, status, error = null, payload = {}) {
  await source.query(
    `UPDATE prompt_category_sync_events
     SET sync_status = $2,
         sync_error = $3,
         payload = payload || $4::jsonb,
         processed_at = CASE WHEN $2 IN ('synced', 'skipped') THEN now() ELSE processed_at END
     WHERE id = $1`,
    [event.id, status, error ? String(error).slice(0, 1000) : null, JSON.stringify(payload)]
  );

  if (event.category_id && status === "synced") {
    await source.query(
      `UPDATE prompt_categories
       SET sync_status = 'synced',
           last_synced_at = now(),
           sync_error = NULL
       WHERE id = $1`,
      [event.category_id]
    );
  } else if (event.category_id && status === "failed") {
    await source.query(
      `UPDATE prompt_categories
       SET sync_status = 'failed',
           sync_error = $2
       WHERE id = $1`,
      [event.category_id, error ? String(error).slice(0, 1000) : "CATEGORY_SYNC_FAILED"]
    );
  }
}

async function syncCategoryEvent(source, target, event) {
  if (dryRun) {
    return { id: event.id, action: event.event_type, updated: 0, dryRun: true };
  }

  if (event.event_type === "rename" && event.old_target_category_name && event.new_target_category_name) {
    const result = await target.query(
      `UPDATE "Prompt"
       SET "category" = $2,
           "updatedAt" = now()
       WHERE "category" = $1
         AND left("id", length($3)) = $3`,
      [event.old_target_category_name, event.new_target_category_name, "iac_prompt_"]
    );
    await markCategoryEvent(source, event, "synced", null, { targetUpdatedPrompts: result.rowCount });
    return { id: event.id, action: "rename", updated: result.rowCount };
  }

  await markCategoryEvent(source, event, "synced", null, { note: "target has no standalone category table" });
  return { id: event.id, action: event.event_type, updated: 0 };
}

async function loadPromptRows(source) {
  const statuses = syncStatuses();
  const params = [batchSize];
  const statusClause = statuses ? "AND sync_status = ANY($2::text[])" : "";
  if (statuses) params.push(statuses);
  const result = await source.query(
    `SELECT *
     FROM awesome_image2_prompt_export
     WHERE cardinality(image_urls) > 0
       ${statusClause}
     ORDER BY approved_at ASC, approved_prompt_id ASC
     LIMIT $1`,
    params
  );
  return result.rows;
}

async function upsertPrompt(target, row) {
  const payload = promptPayload(row);
  const reviewedAt = payload.reviewedAt ? new Date(payload.reviewedAt) : new Date();
  const createdAt = reviewedAt;

  await target.query("BEGIN");
  try {
    await target.query(
      `INSERT INTO "Prompt"
        ("id", "slug", "title", "description", "positivePrompt", "negativePrompt",
         "category", "tags", "model", "ratio", "quality", "costCredits", "source",
         "reviewStatus", "publishStatus", "reviewedAt", "createdAt", "updatedAt")
       VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'DEVELOPER_UPLOAD',
         'APPROVED', 'PUBLISHED', $13, $14, now())
       ON CONFLICT ("id") DO UPDATE
       SET "slug" = EXCLUDED."slug",
           "title" = EXCLUDED."title",
           "description" = EXCLUDED."description",
           "positivePrompt" = EXCLUDED."positivePrompt",
           "negativePrompt" = EXCLUDED."negativePrompt",
           "category" = EXCLUDED."category",
           "tags" = EXCLUDED."tags",
           "model" = EXCLUDED."model",
           "ratio" = EXCLUDED."ratio",
           "quality" = EXCLUDED."quality",
           "costCredits" = EXCLUDED."costCredits",
           "source" = 'DEVELOPER_UPLOAD',
           "reviewStatus" = 'APPROVED',
           "publishStatus" = 'PUBLISHED',
           "reviewedAt" = EXCLUDED."reviewedAt",
           "updatedAt" = now()`,
      [
        payload.id,
        payload.slug,
        payload.title,
        payload.description,
        payload.positivePrompt,
        payload.negativePrompt || null,
        payload.category,
        payload.tags,
        payload.model,
        payload.ratio,
        payload.quality,
        payload.costCredits,
        reviewedAt,
        createdAt
      ]
    );

    const urls = imageUrls(row.image_urls);
    const imagePrefix = `iac_prompt_image_${row.approved_prompt_id}_`;
    await target.query(
      `DELETE FROM "PromptImage"
       WHERE "promptId" = $1
         AND left("id", length($2)) = $2`,
      [payload.id, imagePrefix]
    );

    for (const [index, url] of urls.entries()) {
      const assetId = `iac_asset_${row.approved_prompt_id}_${index + 1}`;
      const promptImageId = `${imagePrefix}${index + 1}`;
      await target.query(
        `INSERT INTO "Asset"
          ("id", "kind", "provider", "objectKey", "publicUrl", "mimeType", "sizeBytes", "createdAt", "updatedAt")
         VALUES ($1, 'PROMPT_EXAMPLE', 'LOCAL', $2, $2, $3, 0, now(), now())
         ON CONFLICT ("id") DO UPDATE
         SET "kind" = 'PROMPT_EXAMPLE',
             "provider" = 'LOCAL',
             "objectKey" = EXCLUDED."objectKey",
             "publicUrl" = EXCLUDED."publicUrl",
             "mimeType" = EXCLUDED."mimeType",
             "updatedAt" = now()`,
        [assetId, url, imageMimeType(url)]
      );

      await target.query(
        `INSERT INTO "PromptImage"
          ("id", "promptId", "assetId", "isPrimary", "sortOrder", "createdAt")
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT ("id") DO UPDATE
         SET "isPrimary" = EXCLUDED."isPrimary",
             "sortOrder" = EXCLUDED."sortOrder"`,
        [promptImageId, payload.id, assetId, index === 0, index]
      );
    }

    await target.query("COMMIT");
    return { promptId: payload.id, slug: payload.slug, imageCount: urls.length, category: payload.category };
  } catch (error) {
    await target.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

async function markPromptSynced(source, row, result) {
  await source.query(
    `UPDATE approved_prompt_syncs
     SET target_prompt_id = $3,
         target_slug = $4,
         sync_status = 'synced',
         sync_error = NULL,
         sync_payload = sync_payload || $5::jsonb,
         last_synced_at = now(),
         updated_at = now()
     WHERE approved_prompt_id = $1
       AND target_system = $2`,
    [
      row.approved_prompt_id,
      targetSystem,
      result.promptId,
      result.slug,
      JSON.stringify({ imageCount: result.imageCount, category: result.category })
    ]
  );
}

async function markPromptFailed(source, row, error) {
  await source.query(
    `UPDATE approved_prompt_syncs
     SET sync_status = 'failed',
         sync_error = $3,
         updated_at = now()
     WHERE approved_prompt_id = $1
       AND target_system = $2`,
    [row.approved_prompt_id, targetSystem, String(error.message || error).slice(0, 1000)]
  );
}

async function main() {
  const source = createPool();
  const target = createTargetPool();
  const summary = {
    targetSystem,
    dryRun,
    syncAll,
    categoryEvents: { scanned: 0, synced: 0, failed: 0 },
    prompts: { scanned: 0, synced: 0, failed: 0 }
  };

  try {
    await ensureLocalSyncRows(source);

    if (dryRun) {
      const preview = await source.query(
        `SELECT count(*)::int AS count
         FROM awesome_image2_prompt_export
         WHERE cardinality(image_urls) > 0
           ${syncStatuses() ? "AND sync_status = ANY($1::text[])" : ""}`,
        syncStatuses() ? [syncStatuses()] : []
      );
      summary.prompts.scanned = preview.rows[0]?.count || 0;
      console.log(JSON.stringify(summary, null, 2));
      return;
    }

    const categoryEvents = await loadCategoryEvents(source);
    summary.categoryEvents.scanned = categoryEvents.length;
    for (const event of categoryEvents) {
      try {
        await syncCategoryEvent(source, target, event);
        summary.categoryEvents.synced += 1;
      } catch (error) {
        await markCategoryEvent(source, event, "failed", error.message || error);
        summary.categoryEvents.failed += 1;
      }
    }

    const rows = await loadPromptRows(source);
    summary.prompts.scanned = rows.length;
    for (const row of rows) {
      try {
        if (!dryRun) {
          const result = await upsertPrompt(target, row);
          await markPromptSynced(source, row, result);
        }
        summary.prompts.synced += 1;
      } catch (error) {
        await markPromptFailed(source, row, error);
        summary.prompts.failed += 1;
      }
    }

    console.log(JSON.stringify(summary, null, 2));
  } finally {
    await target.end();
    await source.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
