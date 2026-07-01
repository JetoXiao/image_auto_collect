import express from "express";
import { spawn } from "node:child_process";
import { createHash, pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "./scripts/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const pool = createPool();
const port = Number(process.env.PORT || 3017);
const imageCacheDir = path.join(__dirname, "data", "image-cache");
const logsDir = path.join(__dirname, "logs");
const dataDir = path.join(__dirname, "data");
const schedulesPath = path.join(dataDir, "scrape-schedules.json");
const historyPath = path.join(dataDir, "scrape-history.json");
const sessionCookieName = "prompt_review_sid";
const sessionMaxAgeMs = 12 * 60 * 60 * 1000;
const schedulerTimeZone = process.env.SCHEDULER_TIME_ZONE || "Asia/Shanghai";
const awesomeSyncBatchSize = Math.max(1, Math.floor(Number(process.env.UI_AWESOME_SYNC_BATCH_SIZE || 5000)));
const maxImageBytes = 12 * 1024 * 1024;
const allowedImageHosts = new Set([
  "pbs.twimg.com",
  "abs.twimg.com",
  "ton.twimg.com",
  "video.twimg.com",
  "43.167.208.107",
  "cdn-prompts.doingfb.com",
  "useaifor.me"
]);

const defaultCategoryOptions = [
  { value: "摄影与写实", aliases: ["Photography & Realism"] },
  { value: "人物与角色", aliases: ["Characters & People"] },
  { value: "海报与排版", aliases: ["Posters & Typography"] },
  { value: "插画与艺术", aliases: [] },
  { value: "品牌与标志", aliases: [] },
  { value: "图表与信息可视化", aliases: ["Charts & Infographics"] },
  { value: "场景与叙事", aliases: ["Scenes & Storytelling"] },
  { value: "建筑与空间", aliases: [] },
  { value: "商品与电商", aliases: ["Products & E-commerce"] },
  { value: "文档与出版物", aliases: [] },
  { value: "UI 与界面", aliases: ["UI & Interfaces"] },
  { value: "历史与古风题材", aliases: [] },
  { value: "其他应用场景", aliases: ["Other Use Cases"] }
];
let categoryOptions = defaultCategoryOptions.map((item, index) => ({ ...item, sortOrder: (index + 1) * 10 }));

app.use(express.json({ limit: "1mb" }));

function cleanLimit(value) {
  const number = Number(value || 24);
  if (!Number.isFinite(number)) return 24;
  return Math.min(100, Math.max(1, Math.floor(number)));
}

function cleanOffset(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.floor(number));
}

function categoryValues(value) {
  const option = categoryOptions.find((item) => item.value === value || item.aliases.includes(value));
  return option ? [option.value, ...option.aliases] : [value];
}

function isValidCategory(value) {
  return categoryOptions.some((item) => item.value === value);
}

function cleanCategoryName(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function slugFromCategoryName(value, fallback = "category") {
  const slug = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `${fallback}-${Date.now().toString(36)}`;
}

function publicCategory(row) {
  return {
    id: row.id,
    value: row.name,
    slug: row.slug || null,
    description: row.description || "",
    aliases: row.aliases || [],
    isActive: row.is_active !== false,
    targetCategoryName: row.target_category_name || row.name,
    syncStatus: row.sync_status || "pending",
    syncRevision: Number(row.sync_revision || 0),
    lastSyncedAt: row.last_synced_at || null,
    syncError: row.sync_error || null,
    sortOrder: row.sort_order ?? 0
  };
}

async function loadCategoriesFromDb() {
  const result = await pool.query(
    `SELECT id, name, slug, description, aliases, is_active, target_category_name, sync_status, sync_revision,
            last_synced_at, sync_error, sort_order
     FROM prompt_categories
     WHERE is_active IS DISTINCT FROM FALSE
     ORDER BY sort_order ASC, id ASC`
  );
  categoryOptions = result.rows.map(publicCategory);
  return categoryOptions;
}

const awesomeTargetSystem = "awesome-image2-web";

function targetPromptIdForApproved(id) {
  return `iac_prompt_${id}`;
}

function targetSlugForApproved(id) {
  return `image-auto-${id}`;
}

async function queueApprovedPromptSyncs(client, ids) {
  const cleanIds = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  if (!cleanIds.length) return 0;
  const result = await client.query(
    `INSERT INTO approved_prompt_syncs
       (approved_prompt_id, target_system, target_prompt_id, target_slug, sync_status)
     SELECT approved.id,
            $2,
            'iac_prompt_' || approved.id::text,
            'image-auto-' || approved.id::text,
            'pending'
     FROM approved_prompt_templates approved
     WHERE approved.id = ANY($1::bigint[])
     ON CONFLICT (approved_prompt_id, target_system) DO UPDATE
     SET sync_status = 'pending',
         sync_error = NULL,
         target_prompt_id = COALESCE(approved_prompt_syncs.target_prompt_id, EXCLUDED.target_prompt_id),
         target_slug = COALESCE(approved_prompt_syncs.target_slug, EXCLUDED.target_slug),
         updated_at = now()
     RETURNING id`,
    [cleanIds, awesomeTargetSystem]
  );
  return result.rowCount;
}

async function queueApprovedPromptSyncsByCategoryNames(client, categoryNames) {
  const names = [...new Set((categoryNames || []).map((value) => String(value || "").trim()).filter(Boolean))];
  if (!names.length) return 0;
  const result = await client.query(
    `INSERT INTO approved_prompt_syncs
       (approved_prompt_id, target_system, target_prompt_id, target_slug, sync_status)
     SELECT approved.id,
            $2,
            'iac_prompt_' || approved.id::text,
            'image-auto-' || approved.id::text,
            'pending'
     FROM approved_prompt_templates approved
     WHERE approved.category = ANY($1::text[])
     ON CONFLICT (approved_prompt_id, target_system) DO UPDATE
     SET sync_status = 'pending',
         sync_error = NULL,
         target_prompt_id = COALESCE(approved_prompt_syncs.target_prompt_id, EXCLUDED.target_prompt_id),
         target_slug = COALESCE(approved_prompt_syncs.target_slug, EXCLUDED.target_slug),
         updated_at = now()
     RETURNING id`,
    [names, awesomeTargetSystem]
  );
  return result.rowCount;
}

async function queuePromptSyncEvent(client, event) {
  const approvedId = Number(event.approvedPromptId);
  const targetPromptId =
    event.targetPromptId || (Number.isFinite(approvedId) ? targetPromptIdForApproved(approvedId) : null);
  if (!targetPromptId) return null;
  const targetSlug = event.targetSlug || (Number.isFinite(approvedId) ? targetSlugForApproved(approvedId) : null);
  const result = await client.query(
    `INSERT INTO prompt_sync_events
       (target_system, event_type, approved_prompt_id, raw_prompt_id, target_prompt_id,
        target_slug, snapshot, event_key, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [
      awesomeTargetSystem,
      event.eventType || "upsert",
      Number.isFinite(approvedId) ? approvedId : null,
      Number.isFinite(Number(event.rawPromptId)) ? Number(event.rawPromptId) : null,
      targetPromptId,
      targetSlug,
      JSON.stringify(event.snapshot || {}),
      event.eventKey || null,
      event.createdBy || null
    ]
  );
  return result.rows[0]?.id || null;
}

async function queuePromptSyncEventsForApprovedIds(client, ids, eventType, createdBy, snapshot = {}) {
  const cleanIds = [...new Set((ids || []).map(Number).filter(Number.isFinite))];
  if (!cleanIds.length) return 0;
  const rows = await client.query(
    `SELECT
       approved.id,
       approved.raw_prompt_id,
       approved.category,
       approved.prompt_hash,
       approved.source_url,
       COALESCE(sync.target_prompt_id, 'iac_prompt_' || approved.id::text) AS target_prompt_id,
       COALESCE(sync.target_slug, 'image-auto-' || approved.id::text) AS target_slug
     FROM approved_prompt_templates approved
     LEFT JOIN approved_prompt_syncs sync
       ON sync.approved_prompt_id = approved.id
      AND sync.target_system = $2
     WHERE approved.id = ANY($1::bigint[])`,
    [cleanIds, awesomeTargetSystem]
  );
  let queued = 0;
  for (const row of rows.rows) {
    const eventId = await queuePromptSyncEvent(client, {
      approvedPromptId: row.id,
      rawPromptId: row.raw_prompt_id,
      targetPromptId: row.target_prompt_id,
      targetSlug: row.target_slug,
      eventType,
      createdBy,
      snapshot: {
        ...snapshot,
        approvedPromptId: row.id,
        rawPromptId: row.raw_prompt_id,
        promptHash: row.prompt_hash,
        category: row.category,
        sourceUrl: row.source_url
      }
    });
    if (eventId) queued += 1;
  }
  return queued;
}

async function queueRejectSyncForApprovedRow(client, row, createdBy, reason) {
  if (!row?.id) return null;
  const sync = await client.query(
    `SELECT target_prompt_id, target_slug
     FROM approved_prompt_syncs
     WHERE approved_prompt_id = $1
       AND target_system = $2
     LIMIT 1`,
    [row.id, awesomeTargetSystem]
  );
  return queuePromptSyncEvent(client, {
    approvedPromptId: row.id,
    rawPromptId: row.raw_prompt_id,
    targetPromptId: sync.rows[0]?.target_prompt_id || targetPromptIdForApproved(row.id),
    targetSlug: sync.rows[0]?.target_slug || targetSlugForApproved(row.id),
    eventType: "reject",
    createdBy,
    snapshot: {
      reason,
      approvedPromptId: row.id,
      rawPromptId: row.raw_prompt_id,
      promptHash: row.prompt_hash,
      category: row.category,
      title: row.title,
      sourceUrl: row.source_url,
      rejectedAt: new Date().toISOString()
    }
  });
}

async function queueCategorySyncEvent(client, event) {
  const newName = cleanCategoryName(event.newName);
  if (!newName) return null;
  const result = await client.query(
    `INSERT INTO prompt_category_sync_events
       (category_id, target_system, event_type, old_name, new_name,
        old_target_category_name, new_target_category_name, payload, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     RETURNING id`,
    [
      event.categoryId || null,
      awesomeTargetSystem,
      event.eventType || "update",
      event.oldName || null,
      newName,
      event.oldTargetCategoryName || event.oldName || null,
      event.newTargetCategoryName || newName,
      JSON.stringify(event.payload || {}),
      event.createdBy || null
    ]
  );
  return result.rows[0]?.id || null;
}

function previewFromPrompt(prompt) {
  const oneLine = String(prompt || "").replace(/\s+/g, " ").trim();
  return oneLine.length > 260 ? `${oneLine.slice(0, 260)}...` : oneLine;
}

function cleanPromptText(value) {
  let text = String(value || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u00a0/g, " ");

  text = text
    .replace(/!\[[^\]]*]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)]\((?:https?:\/\/|www\.)[^)]*\)/gi, "$1")
    .replace(/(?:https?:\/\/|www\.)[^\s<>"')\]]+/gi, "")
    .replace(/\bpic\.twitter\.com\/[A-Za-z0-9_/-]+/gi, "")
    .replace(/<[^>]+>/g, " ");

  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const compact = line.replace(/\s+/g, " ");
      if (/^(?:source|link|links|more|thread|tweet|x post|original|via|credit|credits|参考|来源|链接|原文|查看|作者)\s*[:：]?$/i.test(compact)) return false;
      if (/^(?:follow|subscribe|like|retweet|repost|share|bookmark|join|dm|reply|comment)\b/i.test(compact)) return false;
      if (/^(?:prompt\s+(?:in|below|comments?)|comment\s+for\s+prompt|提示词.*评论区|评论区.*提示词)/i.test(compact)) return false;
      if (/^[@#][\w.-]+(?:\s+[@#][\w.-]+)*$/i.test(compact)) return false;
      return true;
    });

  text = lines.join("\n");
  text = text
    .replace(/(^|\n)\s*(?:\d+[\).、]\s*)?(?:prompt|image prompt|提示词|咒语|关键词)\s*(?:structure)?\s*[:：-]\s*/gi, "$1")
    .replace(/(^|\n)\s*(?:简洁版|完整版)?(?:通用)?提示词\s*[👇:：-]?\s*/gi, "$1")
    .replace(/\b(?:follow|like|retweet|repost|share|bookmark|subscribe)\b[^.\n。]*[.\n。]?/gi, " ")
    .replace(/(?:^|\s)@\w{2,30}\b/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^[\s,.;:：，。、-]+|[\s,.;:：，。、-]+$/g, "")
    .trim();

  return text;
}

function looksEncodingDamaged(prompt) {
  const questionCount = (prompt.match(/\?/g) || []).length;
  return /\?{6,}/.test(prompt) && questionCount >= 20 && questionCount / Math.max(prompt.length, 1) > 0.15;
}

const qualityPositivePatterns = [
  /\b(prompt|image|photo|photograph|portrait|poster|illustration|render|scene|character|composition|camera|lens|lighting|cinematic|realistic|style|background|color|palette|texture|wide shot|close-up|full body)\b/i,
  /\b(?:midjourney|gpt[-\s]?image|chatgpt|image2|sora|dall[-\s]?e|stable diffusion)\b/i,
  /\b(?:aspect ratio|ar\s+\d|16:9|9:16|1:1|3:2|4:5|--ar|--style|--sref|--v\s*\d)/i,
  /[\u4e00-\u9fff].{0,12}(?:画面|镜头|构图|光线|摄影|写实|海报|插画|人物|角色|场景|背景|风格|色彩|材质)/
];

const qualityNegativePatterns = [
  /\b(?:giveaway|airdrop|discount|coupon|sale|join my|newsletter|course|tutorial|download|discord|telegram|patreon|gumroad|buy now)\b/i,
  /\b(?:prompt\s+in\s+(?:comments?|reply|thread)|comment\s+for\s+prompt|rt\s+for\s+prompt)\b/i,
  /(?:提示词|咒语).{0,16}(?:评论区|回复|转发)/,
  /(?:评论区|回复|转发).{0,16}(?:提示词|咒语)/,
  /\b(?:http|www\.|pic\.twitter\.com)\b/i,
  /access_token|backend-api|rate-limit|stack trace|error:/i
];

const hardSafetyRules = [
  {
    key: "politics_policy",
    patterns: [
      /\b(?:politics|political|government|president|prime minister|minister|election|vote|campaign|parliament|congress|senate|democrat|republican|communist party|public policy|government policy|foreign policy|policy reform|propaganda|protest|riot|revolution|sanction|border dispute|territorial dispute)\b/i,
      /(?:政治|政策|政府|总统|主席|首相|总理|部长|选举|投票|竞选|政党|国会|议会|参议院|众议院|民主党|共和党|共产党|社会主义|民族主义|宣传海报|抗议|游行|暴乱|革命|制裁|领土争端|边境冲突|外交)/
    ]
  },
  {
    key: "religion",
    patterns: [
      /\b(?:religion|religious|christian|christianity|jesus|christ|church|catholic|protestant|orthodox|islam|muslim|allah|quran|mosque|hindu|buddhist|buddha|jewish|judaism|torah|synagogue|sikh|atheist)\b/i,
      /(?:宗教|基督|耶稣|教堂|天主教|新教|东正教|伊斯兰|穆斯林|真主|古兰经|清真寺|印度教|佛教|佛祖|寺庙|犹太|犹太教|道教|锡克|神像|信徒|无神论)/
    ]
  },
  {
    key: "racial_ethnic_discrimination",
    patterns: [
      /\b(?:racist|racism|racial hate|ethnic hate|ethnic cleansing|white supremacy|black supremacy|master race|inferior race|subhuman race)\b/i,
      /(?:种族歧视|民族歧视|种族仇恨|种族清洗|劣等民族|劣等种族|高等种族|白人至上|黑人至上|黑鬼|白皮猪|黄皮猴子|支那|倭寇|棒子|阿三|蛮夷)/,
      /(?:黑人|白人|亚洲人|犹太人|穆斯林|少数族裔|外族|移民|难民).{0,18}(?:低等|劣等|肮脏|恶心|骗子|懒惰|该死|滚出|驱逐|清除|消灭|仇恨|歧视)/,
      /(?:低等|劣等|肮脏|恶心|骗子|懒惰|该死|滚出|驱逐|清除|消灭|仇恨|歧视).{0,18}(?:黑人|白人|亚洲人|犹太人|穆斯林|少数族裔|外族|移民|难民)/
    ]
  },
  {
    key: "regional_discrimination",
    patterns: [
      /(?:地域歧视|地域黑)/,
      /(?:河南人|东北人|上海人|北京人|广东人|农村人|乡下人|外地人|本地人|南方人|北方人).{0,18}(?:低等|劣等|肮脏|恶心|骗子|小偷|懒惰|该死|滚出|驱逐|排斥|仇恨|歧视)/,
      /(?:低等|劣等|肮脏|恶心|骗子|小偷|懒惰|该死|滚出|驱逐|排斥|仇恨|歧视).{0,18}(?:河南人|东北人|上海人|北京人|广东人|农村人|乡下人|外地人|本地人|南方人|北方人)/
    ]
  },
  {
    key: "gender_sexual_orientation_discrimination",
    patterns: [
      /\b(?:sexist|misogyny|misandry|homophobia|transphobia)\b/i,
      /\b(?:women|men|girls|boys|female|male|gay|lesbian|transgender|lgbtq?)\b.{0,40}\b(?:inferior|subhuman|stupid|disgusting|should be banned|should be deported|should be killed|do not deserve)\b/i,
      /\b(?:inferior|subhuman|stupid|disgusting|ban|deport|kill|hate)\b.{0,40}\b(?:women|men|girls|boys|female|male|gay|lesbian|transgender|lgbtq?)\b/i,
      /(?:性别歧视|厌女|仇男|恐同|跨性别歧视|女权婊|母狗|贱女人|男人婆|娘炮)/,
      /(?:女人|男人|男性|女性|女孩|男孩|同性恋|跨性别|LGBT).{0,18}(?:低等|劣等|肮脏|恶心|变态|愚蠢|该死|滚出|驱逐|清除|消灭|仇恨|歧视)/i,
      /(?:低等|劣等|肮脏|恶心|变态|愚蠢|该死|滚出|驱逐|清除|消灭|仇恨|歧视).{0,18}(?:女人|男人|男性|女性|女孩|男孩|同性恋|跨性别|LGBT)/i
    ]
  }
];

function safetyGate(originalPrompt, cleanedPrompt = "") {
  const text = `${String(originalPrompt || "")}\n${String(cleanedPrompt || "")}`;
  const categories = [];
  for (const rule of hardSafetyRules) {
    if (rule.patterns.some((pattern) => pattern.test(text))) {
      categories.push(rule.key);
    }
  }
  return {
    blocked: categories.length > 0,
    categories,
    reasons: categories.map((category) => `safety_block:${category}`)
  };
}

function imageCountFromRow(row) {
  if (Array.isArray(row.image_urls) && row.image_urls.filter(Boolean).length) {
    return new Set(row.image_urls.filter(Boolean)).size;
  }
  return row.image_url ? 1 : 0;
}

function classifyAutoReview(row) {
  const originalPrompt = String(row.prompt || "");
  const cleanedPrompt = cleanPromptText(originalPrompt);
  const text = cleanedPrompt || originalPrompt.trim();
  const safety = safetyGate(originalPrompt, cleanedPrompt);
  const reasons = [];
  let score = 0;
  if (safety.blocked) {
    return {
      action: "reject",
      score: -100,
      reasons: safety.reasons,
      safetyCategories: safety.categories,
      cleanedPrompt: text,
      promptChanged: cleanedPrompt !== originalPrompt.trim(),
      originalLength: originalPrompt.trim().length,
      cleanedLength: text.length
    };
  }

  const imageCount = imageCountFromRow(row);
  if (imageCount > 0) {
    score += 3;
    reasons.push(`has_images:${imageCount}`);
  } else {
    score -= 6;
    reasons.push("no_image");
  }

  const length = text.length;
  if (length >= 120) {
    score += 3;
    reasons.push("rich_prompt");
  } else if (length >= 60) {
    score += 1;
    reasons.push("usable_length");
  } else {
    score -= 4;
    reasons.push("too_short");
  }

  const positiveHits = qualityPositivePatterns.filter((pattern) => pattern.test(text)).length;
  score += positiveHits * 2;
  if (positiveHits) reasons.push(`visual_signals:${positiveHits}`);

  const negativeHits = qualityNegativePatterns.filter((pattern) => pattern.test(originalPrompt) || pattern.test(cleanedPrompt)).length;
  score -= negativeHits * 3;
  if (negativeHits) reasons.push(`noise_signals:${negativeHits}`);

  if (looksEncodingDamaged(text)) {
    score -= 8;
    reasons.push("encoding_suspect");
  }

  const urlCount = (originalPrompt.match(/(?:https?:\/\/|www\.)/gi) || []).length;
  if (urlCount) reasons.push(`removed_links:${urlCount}`);

  const alphaMatches = text.match(/[A-Za-z]/g) || [];
  const punctuationMatches = text.match(/[{}[\]|<>]/g) || [];
  const punctuationRatio = punctuationMatches.length / Math.max(text.length, 1);
  if (punctuationRatio > 0.08) {
    score -= 2;
    reasons.push("high_symbol_noise");
  }

  if (alphaMatches.length < 12 && !/[\u4e00-\u9fff]/.test(text)) {
    score -= 3;
    reasons.push("low_text_signal");
  }

  const promptChanged = cleanedPrompt !== originalPrompt.trim();
  const reject = score < 2 || !text || text.length < 45 || imageCount === 0 || looksEncodingDamaged(text);
  return {
    action: reject ? "reject" : "approve",
    score,
    reasons,
    safetyCategories: [],
    cleanedPrompt: text,
    promptChanged,
    originalLength: originalPrompt.trim().length,
    cleanedLength: text.length
  };
}

async function autoReviewPendingPrompts(options = {}) {
  const client = await pool.connect();
  try {
    const reviewer = options.reviewer || "auto";
    const limit = Math.min(10000, Math.max(1, Math.floor(Number(options.limit || 100))));
    const search = String(options.search || "").trim();
    const sourcePlatform = String(options.sourcePlatform || "").trim();
    const startedAt = options.startedAt ? new Date(options.startedAt) : null;
    const endedAt = options.endedAt ? new Date(options.endedAt) : null;
    const order = options.order === "oldest" ? "oldest" : "latest";
    const values = [];
    const clauses = ["review_status = 'pending'"];

    if (search) {
      values.push(`%${search}%`);
      clauses.push(`(
        title ILIKE $${values.length}
        OR prompt ILIKE $${values.length}
        OR prompt_preview ILIKE $${values.length}
        OR category ILIKE $${values.length}
        OR source_handle ILIKE $${values.length}
      )`);
    }
    if (sourcePlatform) {
      values.push(sourcePlatform);
      clauses.push(`source_platform = $${values.length}`);
    }
    if (startedAt && !Number.isNaN(startedAt.getTime())) {
      values.push(startedAt.toISOString());
      clauses.push(`scraped_at >= $${values.length}`);
    }
    if (endedAt && !Number.isNaN(endedAt.getTime())) {
      values.push(endedAt.toISOString());
      clauses.push(`scraped_at <= $${values.length}`);
    }
    values.push(limit);

    const sortDirection = order === "oldest" ? "ASC" : "DESC";
    const candidates = await pool.query(
      `SELECT *
       FROM raw_prompt_templates
       WHERE ${clauses.join(" AND ")}
       ORDER BY scraped_at ${sortDirection}, id ${sortDirection}
       LIMIT $${values.length}`,
      values
    );

    const summary = {
      scanned: candidates.rowCount,
      approved: 0,
      duplicate: 0,
      rejected: 0,
      cleaned: 0,
      failed: 0,
      samples: []
    };

    for (const row of candidates.rows) {
      try {
        await client.query("BEGIN");
        const locked = await client.query("SELECT * FROM raw_prompt_templates WHERE id = $1 FOR UPDATE", [row.id]);
        if (!locked.rowCount || locked.rows[0].review_status !== "pending") {
          await client.query("ROLLBACK");
          continue;
        }
        const currentReview = classifyAutoReview(locked.rows[0]);
        const prompt = currentReview.cleanedPrompt;
        if (prompt !== locked.rows[0].prompt) summary.cleaned += 1;

        const autoReviewJson = {
          action: currentReview.action,
          score: currentReview.score,
          reasons: currentReview.reasons,
          safetyCategories: currentReview.safetyCategories || [],
          promptChanged: currentReview.promptChanged,
          originalLength: currentReview.originalLength,
          cleanedLength: currentReview.cleanedLength,
          reviewer,
          reviewedAt: new Date().toISOString(),
          version: 1
        };

        if (currentReview.action === "approve") {
          await client.query(
            `UPDATE raw_prompt_templates
             SET prompt = $2,
                 prompt_preview = $3,
                 metadata = jsonb_set(metadata, '{autoReview}', $4::jsonb, true)
             WHERE id = $1`,
            [row.id, prompt, previewFromPrompt(prompt), JSON.stringify(autoReviewJson)]
          );
          const approved = await approveRawPromptWithClient(client, row.id, reviewer);
          if (approved.duplicate) summary.duplicate += 1;
          else summary.approved += 1;
        } else {
          await client.query(
            `UPDATE raw_prompt_templates
             SET prompt = $2,
                 prompt_preview = $3,
                 review_status = 'rejected',
                 reviewed_by = $4,
                 reviewed_at = now(),
                 reject_reason = $5,
                 approved_template_id = NULL,
                 metadata = jsonb_set(metadata, '{autoReview}', $6::jsonb, true)
             WHERE id = $1`,
            [
              row.id,
              prompt,
              previewFromPrompt(prompt),
              reviewer,
              currentReview.reasons.join(", ").slice(0, 500),
              JSON.stringify(autoReviewJson)
            ]
          );
          summary.rejected += 1;
        }
        await client.query("COMMIT");
        if (summary.samples.length < 12) {
          summary.samples.push({
            id: row.id,
            action: currentReview.action,
            score: currentReview.score,
            reasons: currentReview.reasons,
            title: row.title || previewFromPrompt(prompt)
          });
        }
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        summary.failed += 1;
        console.error(`Auto review failed for raw prompt ${row.id}:`, error);
      }
    }

    return summary;
  } finally {
    client.release();
  }
}

async function approveRawPromptWithClient(client, id, reviewer) {
  const approval = await client.query(
    `WITH src AS (
       SELECT * FROM raw_prompt_templates WHERE id = $1
     ),
     inserted AS (
       INSERT INTO approved_prompt_templates
        (raw_prompt_id, creator_id, source_platform, source_handle, source_url, source_tweet_id,
         title, original_image_url, original_image_urls, image_url, image_urls, image_alt,
         prompt, prompt_preview, category, styles, scenes, metadata, source_published_at, approved_by)
       SELECT
        id, creator_id, source_platform, source_handle, source_url, source_tweet_id,
        title, original_image_url, original_image_urls, image_url, image_urls, image_alt,
        prompt, prompt_preview, category, styles, scenes, metadata, source_published_at, $2
       FROM src
       ON CONFLICT (prompt_hash) DO NOTHING
       RETURNING id, false AS duplicate
     )
     SELECT id, duplicate FROM inserted
     UNION ALL
     SELECT approved_prompt_templates.id, true AS duplicate
     FROM approved_prompt_templates, src
     WHERE approved_prompt_templates.prompt_hash = src.prompt_hash
        OR (
          src.source_url IS NOT NULL
          AND src.source_url <> ''
         AND approved_prompt_templates.source_url = src.source_url
         AND approved_prompt_templates.prompt_hash = src.prompt_hash
     )
     LIMIT 1`,
    [id, reviewer]
  );

  const approvedId = approval.rows[0]?.id;
  const duplicate = approval.rows[0]?.duplicate === true;
  await client.query(
    `UPDATE raw_prompt_templates
     SET review_status = $2,
         reviewed_by = $3,
         reviewed_at = now(),
         reject_reason = NULL,
         approved_template_id = $4
     WHERE id = $1`,
    [id, duplicate ? "duplicate" : "approved", reviewer, approvedId || null]
  );
  if (approvedId) {
    await client.query(
      `INSERT INTO approved_prompt_syncs
         (approved_prompt_id, target_system, target_prompt_id, target_slug, sync_status, sync_payload)
       VALUES (
         $1::bigint,
         $2,
         $3,
         $4,
         'pending',
         jsonb_build_object('source', 'auto-approval', 'reviewer', $5)
       )
       ON CONFLICT (approved_prompt_id, target_system) DO UPDATE
       SET sync_status = 'pending',
           sync_error = NULL,
           updated_at = now()`,
      [
        approvedId,
        awesomeTargetSystem,
        targetPromptIdForApproved(approvedId),
        targetSlugForApproved(approvedId),
        reviewer
      ]
    );
    await queuePromptSyncEvent(client, {
      approvedPromptId: approvedId,
      rawPromptId: id,
      eventType: "upsert",
      createdBy: reviewer,
      snapshot: {
        reason: duplicate ? "duplicate_approved_prompt_seen" : "approved",
        rawPromptId: id,
        approvedPromptId: approvedId,
        reviewer
      }
    });
  }
  return { approvedId, duplicate };
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return `pbkdf2_sha256$120000$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const [method, iterationsText, salt, expectedHash] = String(storedHash || "").split("$");
  if (method !== "pbkdf2_sha256" || !salt || !expectedHash) return false;
  const iterations = Number(iterationsText);
  if (!Number.isFinite(iterations)) return false;
  const actual = pbkdf2Sync(String(password), salt, iterations, Buffer.from(expectedHash, "hex").length, "sha256");
  const expected = Buffer.from(expectedHash, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function parseCookies(header = "") {
  return Object.fromEntries(
    String(header)
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) return [part, ""];
        return [decodeURIComponent(part.slice(0, index)), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionMaxAgeMs / 1000)}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    displayName: user.display_name || user.username
  };
}

function imageCacheKey(url) {
  return createHash("sha256").update(url).digest("hex");
}

function parseImageUrl(value) {
  const url = new URL(String(value || ""));
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("IMAGE_URL_PROTOCOL");
  if (!allowedImageHosts.has(url.hostname.toLowerCase())) throw new Error("IMAGE_URL_HOST");
  return url;
}

function normalizeContentType(contentType) {
  return String(contentType || "").split(";")[0].trim().toLowerCase();
}

function inferImageContentType(url) {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

function timestampForFile(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}

async function readScrapeCounts() {
  const [raw, creators, approved] = await Promise.all([
    pool.query(
      `SELECT
        count(*)::int AS raw_total,
        count(*) FILTER (WHERE source_platform = 'x')::int AS x_total,
        count(*) FILTER (WHERE source_platform = 'doingfb')::int AS doingfb_total,
        count(*) FILTER (WHERE review_status = 'pending')::int AS pending_total,
        count(*) FILTER (WHERE image_url LIKE 'https://useaifor.me/prompt-images/%')::int AS cloud_images
       FROM raw_prompt_templates`
    ),
    pool.query("SELECT count(*)::int AS count FROM twitter_creators"),
    pool.query("SELECT count(*)::int AS count FROM approved_prompt_templates")
  ]);
  return {
    rawTotal: raw.rows[0]?.raw_total || 0,
    xTotal: raw.rows[0]?.x_total || 0,
    doingfbTotal: raw.rows[0]?.doingfb_total || 0,
    pendingTotal: raw.rows[0]?.pending_total || 0,
    cloudImages: raw.rows[0]?.cloud_images || 0,
    creators: creators.rows[0]?.count || 0,
    approved: approved.rows[0]?.count || 0
  };
}

async function ensureAuthTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT,
      password_hash TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS app_sessions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS prompt_categories (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      slug TEXT,
      description TEXT,
      aliases TEXT[] NOT NULL DEFAULT '{}',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      sync_key TEXT,
      target_category_name TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      sync_revision BIGINT NOT NULL DEFAULT 0,
      last_synced_at TIMESTAMPTZ,
      sync_error TEXT,
      sync_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS prompt_category_sync_events (
      id BIGSERIAL PRIMARY KEY,
      category_id BIGINT REFERENCES prompt_categories(id) ON DELETE SET NULL,
      target_system TEXT NOT NULL DEFAULT 'awesome-image2-web',
      event_type TEXT NOT NULL,
      old_name TEXT,
      new_name TEXT NOT NULL,
      old_target_category_name TEXT,
      new_target_category_name TEXT NOT NULL,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      sync_error TEXT,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS approved_prompt_syncs (
      id BIGSERIAL PRIMARY KEY,
      approved_prompt_id BIGINT NOT NULL REFERENCES approved_prompt_templates(id) ON DELETE CASCADE,
      target_system TEXT NOT NULL DEFAULT 'awesome-image2-web',
      target_prompt_id TEXT,
      target_slug TEXT,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      sync_error TEXT,
      sync_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      last_synced_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (approved_prompt_id, target_system),
      UNIQUE (target_system, target_prompt_id)
    );

    CREATE TABLE IF NOT EXISTS prompt_sync_events (
      id BIGSERIAL PRIMARY KEY,
      target_system TEXT NOT NULL DEFAULT 'awesome-image2-web',
      event_type TEXT NOT NULL,
      approved_prompt_id BIGINT,
      raw_prompt_id BIGINT,
      target_prompt_id TEXT NOT NULL,
      target_slug TEXT,
      snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      sync_status TEXT NOT NULL DEFAULT 'pending',
      sync_error TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      event_key TEXT UNIQUE,
      created_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      processed_at TIMESTAMPTZ
    );

    ALTER TABLE prompt_categories
      ADD COLUMN IF NOT EXISTS slug TEXT,
      ADD COLUMN IF NOT EXISTS description TEXT,
      ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS sync_key TEXT,
      ADD COLUMN IF NOT EXISTS target_category_name TEXT,
      ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS sync_revision BIGINT NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS sync_error TEXT,
      ADD COLUMN IF NOT EXISTS sync_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

    UPDATE prompt_categories
    SET sync_key = 'category:' || id::text
    WHERE sync_key IS NULL OR sync_key = '';

    UPDATE prompt_categories
    SET slug = 'category-' || id::text
    WHERE slug IS NULL OR slug = '';

    UPDATE prompt_categories
    SET target_category_name = name
    WHERE target_category_name IS NULL OR target_category_name = '';

    ALTER TABLE prompt_categories
      ALTER COLUMN slug SET NOT NULL,
      ALTER COLUMN sync_key SET NOT NULL,
      ALTER COLUMN target_category_name SET NOT NULL;

    CREATE INDEX IF NOT EXISTS idx_app_sessions_expires_at ON app_sessions(expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_categories_sync_key ON prompt_categories(sync_key);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_categories_slug ON prompt_categories(slug);
    CREATE INDEX IF NOT EXISTS idx_prompt_categories_sync_status ON prompt_categories(sync_status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_prompt_category_sync_events_status ON prompt_category_sync_events(target_system, sync_status, created_at);
    CREATE INDEX IF NOT EXISTS idx_approved_prompt_syncs_status ON approved_prompt_syncs(target_system, sync_status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_prompt_sync_events_status ON prompt_sync_events(target_system, sync_status, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_prompt_sync_events_target_prompt ON prompt_sync_events(target_system, target_prompt_id);
  `);

  for (const [index, category] of defaultCategoryOptions.entries()) {
    await pool.query(
      `INSERT INTO prompt_categories (name, slug, aliases, sync_key, target_category_name, sort_order)
       VALUES ($1, $2, $3, $4, $1, $5)
       ON CONFLICT (name) DO UPDATE
       SET slug = COALESCE(prompt_categories.slug, EXCLUDED.slug),
           aliases = EXCLUDED.aliases,
           target_category_name = COALESCE(prompt_categories.target_category_name, EXCLUDED.target_category_name),
           sort_order = CASE
             WHEN prompt_categories.sort_order = 0 THEN EXCLUDED.sort_order
             ELSE prompt_categories.sort_order
           END,
           updated_at = now()`,
      [
        category.value,
        category.slug || slugFromCategoryName(category.value, `category-seed-${index + 1}`),
        category.aliases,
        `category:seed:${index + 1}`,
        (index + 1) * 10
      ]
    );
  }

  await pool.query(
    `INSERT INTO approved_prompt_syncs (approved_prompt_id, target_system, target_prompt_id, target_slug)
     SELECT id, $1, 'iac_prompt_' || id::text, 'image-auto-' || id::text
     FROM approved_prompt_templates
     ON CONFLICT (approved_prompt_id, target_system) DO NOTHING`,
    [awesomeTargetSystem]
  );

  await pool.query(
    `INSERT INTO prompt_sync_events
       (target_system, event_type, approved_prompt_id, raw_prompt_id, target_prompt_id, target_slug, snapshot, event_key, created_by)
     SELECT
       $1,
       'upsert',
       approved.id,
       approved.raw_prompt_id,
       COALESCE(sync.target_prompt_id, 'iac_prompt_' || approved.id::text),
       COALESCE(sync.target_slug, 'image-auto-' || approved.id::text),
       jsonb_build_object(
         'reason', 'bootstrap',
         'approvedPromptId', approved.id,
         'promptHash', approved.prompt_hash,
         'category', approved.category
       ),
       $1 || ':bootstrap:approved:' || approved.id::text,
       'system'
     FROM approved_prompt_templates approved
     LEFT JOIN approved_prompt_syncs sync
       ON sync.approved_prompt_id = approved.id
      AND sync.target_system = $1
     ON CONFLICT (event_key) DO NOTHING`,
    [awesomeTargetSystem]
  );

  const defaultUsers = ["yuqi", "jeto", "gugg", "felix"];
  for (const username of defaultUsers) {
    await pool.query(
      `INSERT INTO app_users (username, display_name, password_hash)
       VALUES ($1, $1, $2)
       ON CONFLICT (username) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           updated_at = now()`,
      [username, hashPassword("Aa123123")]
    );
  }
  await pool.query("DELETE FROM app_sessions WHERE expires_at <= now()");
  await loadCategoriesFromDb();
}

async function getSessionUser(req) {
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies[sessionCookieName];
  if (!token) return null;
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const result = await pool.query(
    `SELECT u.id, u.username, u.display_name
     FROM app_sessions s
     JOIN app_users u ON u.id = s.user_id
     WHERE s.token_hash = $1
       AND s.expires_at > now()
       AND u.is_active = TRUE
     LIMIT 1`,
    [tokenHash]
  );
  return result.rows[0] || null;
}

async function requireAuth(req, res, next) {
  try {
    const user = await getSessionUser(req);
    if (!user) {
      if (req.path.startsWith("/api/")) {
        res.status(401).json({ ok: false, error: "UNAUTHORIZED" });
      } else {
        res.redirect("/login.html");
      }
      return;
    }
    req.user = user;
    next();
  } catch (error) {
    next(error);
  }
}

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const username = String(req.body?.username || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!username || !password) {
      res.status(400).json({ ok: false, error: "USERNAME_PASSWORD_REQUIRED" });
      return;
    }
    const result = await pool.query(
      "SELECT id, username, display_name, password_hash FROM app_users WHERE username = $1 AND is_active = TRUE LIMIT 1",
      [username]
    );
    const user = result.rows[0];
    if (!user || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ ok: false, error: "用户名或密码错误" });
      return;
    }
    const token = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await pool.query(
      "INSERT INTO app_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3 || ' milliseconds')::interval)",
      [user.id, tokenHash, sessionMaxAgeMs]
    );
    await pool.query("UPDATE app_users SET last_login_at = now(), updated_at = now() WHERE id = $1", [user.id]);
    setSessionCookie(res, token);
    res.json({ ok: true, user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", async (req, res, next) => {
  try {
    const token = parseCookies(req.headers.cookie || "")[sessionCookieName];
    if (token) {
      const tokenHash = createHash("sha256").update(token).digest("hex");
      await pool.query("DELETE FROM app_sessions WHERE token_hash = $1", [tokenHash]);
    }
    clearSessionCookie(res);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/auth/me", requireAuth, (req, res) => {
  res.json({ ok: true, user: publicUser(req.user) });
});

app.get("/", requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/login.html", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.get("/login.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.js"));
});

app.get("/styles.css", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "styles.css"));
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/auth/")) {
    next();
    return;
  }
  requireAuth(req, res, next);
});
app.use(express.static(path.join(__dirname, "public")));

const scrapeRun = {
  status: "idle",
  runId: null,
  trigger: "manual",
  scheduleId: null,
  scheduleEndAt: null,
  startedAt: null,
  endedAt: null,
  before: null,
  finalCounts: null,
  finalDelta: null,
  autoReview: null,
  requestedStop: false,
  logPath: null,
  tasks: {},
  logs: []
};

const doingfbRun = {
  status: "idle",
  runId: null,
  startedAt: null,
  endedAt: null,
  before: null,
  finalCounts: null,
  finalDelta: null,
  autoReview: null,
  requestedStop: false,
  logPath: null,
  task: null,
  logs: []
};

const awesomeSyncRun = {
  status: "idle",
  runId: null,
  trigger: "manual",
  mode: "pending",
  requestedBy: null,
  startedAt: null,
  endedAt: null,
  pid: null,
  before: null,
  counts: null,
  summary: null,
  queuedAll: 0,
  error: null,
  logPath: null,
  logs: [],
  _child: null,
  _stdoutBuffer: "",
  _stderrBuffer: "",
  _stdoutText: "",
  _stderrText: ""
};

const doingfbBatchReviewState = {
  lastCursor: 0,
  running: false
};

let scrapeSchedules = [];
let scrapeHistory = [];
let scheduleTimer = null;
let scheduleTickRunning = false;

async function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`Failed to read ${filePath}:`, error.message);
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function normalizeScheduleTime(value) {
  const match = String(value || "").trim().match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? `${match[1]}:${match[2]}` : null;
}

function scheduleMinutes(value) {
  const time = normalizeScheduleTime(value);
  if (!time) return null;
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function addMinutesToScheduleTime(value, minutesToAdd) {
  const minutes = scheduleMinutes(value);
  if (minutes === null) return null;
  const next = (minutes + minutesToAdd + 24 * 60) % (24 * 60);
  return `${String(Math.floor(next / 60)).padStart(2, "0")}:${String(next % 60).padStart(2, "0")}`;
}

function normalizeSchedule(item) {
  const startTime = normalizeScheduleTime(item?.startTime || item?.time);
  if (!startTime) return null;
  const endTime = normalizeScheduleTime(item?.endTime) || addMinutesToScheduleTime(startTime, 60);
  if (!endTime || endTime === startTime) return null;
  const now = new Date().toISOString();
  return {
    ...item,
    time: startTime,
    startTime,
    endTime,
    label: String(item?.label || "").trim().slice(0, 80) || `每天 ${startTime}-${endTime}`,
    enabled: item?.enabled !== false,
    createdAt: item?.createdAt || now,
    updatedAt: item?.updatedAt || now,
    lastRunDate: item?.lastRunDate || null,
    lastRunAt: item?.lastRunAt || null,
    lastSkipAt: item?.lastSkipAt || null,
    lastSkipReason: item?.lastSkipReason || null
  };
}

function sortSchedules() {
  scrapeSchedules.sort((a, b) => {
    const start = String(a.startTime || a.time || "").localeCompare(String(b.startTime || b.time || ""));
    return start || String(a.endTime || "").localeCompare(String(b.endTime || ""));
  });
}

function scheduleEndDate(schedule, startedAt) {
  const start = scheduleMinutes(schedule?.startTime || schedule?.time);
  const end = scheduleMinutes(schedule?.endTime);
  if (start === null || end === null) return null;
  const startDate = new Date(startedAt || Date.now());
  if (Number.isNaN(startDate.getTime())) return null;
  const zoned = zonedParts(startDate, schedulerTimeZone);
  const endUtc = zonedTimeToUtcDate(
    zoned.year,
    zoned.month,
    zoned.day,
    Math.floor(end / 60),
    end % 60,
    schedulerTimeZone
  );
  const startBoundary = zonedTimeToUtcDate(
    zoned.year,
    zoned.month,
    zoned.day,
    Math.floor(start / 60),
    start % 60,
    schedulerTimeZone
  );
  if (endUtc <= startBoundary) endUtc.setUTCDate(endUtc.getUTCDate() + 1);
  return endUtc;
}

function isScheduleStartDue(schedule, now, dateKey) {
  const start = scheduleMinutes(schedule?.startTime || schedule?.time);
  const end = scheduleMinutes(schedule?.endTime);
  const current = scheduleMinutes(currentTimeKey(now));
  if (!schedule?.enabled || start === null || end === null || current === null) return false;
  if (schedule.lastRunDate === dateKey) return false;
  if (start < end) return current >= start && current < end;
  return current >= start;
}

function isScrapeActive() {
  return ["running", "paused", "stopping", "reviewing"].includes(scrapeRun.status);
}

function isDoingfbActive() {
  return ["running", "stopping", "reviewing"].includes(doingfbRun.status);
}

function todayKey(date = new Date()) {
  const parts = zonedParts(date, schedulerTimeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function currentTimeKey(date = new Date()) {
  const parts = zonedParts(date, schedulerTimeZone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}

function zonedParts(date = new Date(), timeZone = schedulerTimeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const value = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return {
    year: value.year,
    month: value.month,
    day: value.day,
    hour: value.hour === 24 ? 0 : value.hour,
    minute: value.minute,
    second: value.second
  };
}

function timeZoneOffsetMs(utcDate, timeZone = schedulerTimeZone) {
  const parts = zonedParts(utcDate, timeZone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  return asUtc - utcDate.getTime();
}

function zonedTimeToUtcDate(year, month, day, hour, minute, timeZone = schedulerTimeZone) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const offset = timeZoneOffsetMs(guess, timeZone);
  return new Date(guess.getTime() - offset);
}

async function loadSchedulerState() {
  const rawSchedules = await readJsonFile(schedulesPath, []);
  scrapeSchedules = rawSchedules.map(normalizeSchedule).filter(Boolean);
  sortSchedules();
  scrapeHistory = await readJsonFile(historyPath, []);
  if (JSON.stringify(rawSchedules) !== JSON.stringify(scrapeSchedules)) {
    await saveSchedules();
  }
}

async function saveSchedules() {
  await writeJsonFile(schedulesPath, scrapeSchedules);
}

async function saveHistory() {
  scrapeHistory = scrapeHistory.slice(0, 80);
  await writeJsonFile(historyPath, scrapeHistory);
}

function isAwesomeSyncActive() {
  return awesomeSyncRun.status === "running";
}

function addAwesomeSyncLog(line) {
  const text = String(line || "").trimEnd();
  if (!text) return;
  const entry = `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${text}`;
  awesomeSyncRun.logs.push(entry);
  if (awesomeSyncRun.logs.length > 120) awesomeSyncRun.logs.splice(0, awesomeSyncRun.logs.length - 120);
  if (awesomeSyncRun.logPath) {
    fs.mkdir(path.dirname(awesomeSyncRun.logPath), { recursive: true })
      .then(() => fs.appendFile(awesomeSyncRun.logPath, `${entry}\n`, "utf8"))
      .catch((error) => console.warn("Failed to write awesome sync log:", error.message));
  }
}

async function readAwesomeSyncCounts() {
  const [promptEvents, categoryEvents, promptSyncs] = await Promise.all([
    pool.query(
      `SELECT sync_status, count(*)::int AS count
       FROM prompt_sync_events
       WHERE target_system = $1
       GROUP BY sync_status`,
      [awesomeTargetSystem]
    ),
    pool.query(
      `SELECT sync_status, count(*)::int AS count
       FROM prompt_category_sync_events
       WHERE target_system = $1
       GROUP BY sync_status`,
      [awesomeTargetSystem]
    ),
    pool.query(
      `SELECT sync_status, count(*)::int AS count
       FROM approved_prompt_syncs
       WHERE target_system = $1
       GROUP BY sync_status`,
      [awesomeTargetSystem]
    )
  ]);
  const eventCounts = Object.fromEntries(promptEvents.rows.map((row) => [row.sync_status, row.count]));
  const categoryCounts = Object.fromEntries(categoryEvents.rows.map((row) => [row.sync_status, row.count]));
  const approvedCounts = Object.fromEntries(promptSyncs.rows.map((row) => [row.sync_status, row.count]));
  return {
    promptEvents: eventCounts,
    categoryEvents: categoryCounts,
    approvedSyncs: approvedCounts,
    pendingTotal:
      (eventCounts.pending || 0) +
      (eventCounts.failed || 0) +
      (categoryCounts.pending || 0) +
      (categoryCounts.failed || 0)
  };
}

function resetAwesomeSyncRun(options = {}, before = null) {
  awesomeSyncRun.status = "running";
  awesomeSyncRun.runId = timestampForFile();
  awesomeSyncRun.trigger = options.trigger || "manual";
  awesomeSyncRun.mode = options.mode || "pending";
  awesomeSyncRun.requestedBy = options.requestedBy || null;
  awesomeSyncRun.startedAt = new Date().toISOString();
  awesomeSyncRun.endedAt = null;
  awesomeSyncRun.pid = null;
  awesomeSyncRun.before = before;
  awesomeSyncRun.counts = null;
  awesomeSyncRun.summary = null;
  awesomeSyncRun.queuedAll = 0;
  awesomeSyncRun.error = null;
  awesomeSyncRun.logPath = path.join(logsDir, `awesome-sync-${awesomeSyncRun.runId}.log`);
  awesomeSyncRun.logs = [];
  awesomeSyncRun._child = null;
  awesomeSyncRun._stdoutBuffer = "";
  awesomeSyncRun._stderrBuffer = "";
  awesomeSyncRun._stdoutText = "";
  awesomeSyncRun._stderrText = "";
}

async function queueAllApprovedForAwesomeSync(createdBy = "system") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO approved_prompt_syncs
         (approved_prompt_id, target_system, target_prompt_id, target_slug, sync_status)
       SELECT id, $1, 'iac_prompt_' || id::text, 'image-auto-' || id::text, 'pending'
       FROM approved_prompt_templates
       ON CONFLICT (approved_prompt_id, target_system) DO UPDATE
       SET sync_status = 'pending',
           sync_error = NULL,
           target_prompt_id = COALESCE(approved_prompt_syncs.target_prompt_id, EXCLUDED.target_prompt_id),
           target_slug = COALESCE(approved_prompt_syncs.target_slug, EXCLUDED.target_slug),
           updated_at = now()`,
      [awesomeTargetSystem]
    );
    const rows = await client.query(
      `SELECT
         approved.id,
         approved.raw_prompt_id,
         approved.prompt_hash,
         approved.category,
         COALESCE(sync.target_prompt_id, 'iac_prompt_' || approved.id::text) AS target_prompt_id,
         COALESCE(sync.target_slug, 'image-auto-' || approved.id::text) AS target_slug
       FROM approved_prompt_templates approved
       LEFT JOIN approved_prompt_syncs sync
         ON sync.approved_prompt_id = approved.id
        AND sync.target_system = $1`,
      [awesomeTargetSystem]
    );
    let queued = 0;
    for (const row of rows.rows) {
      const event = await client.query(
        `INSERT INTO prompt_sync_events
           (target_system, event_type, approved_prompt_id, raw_prompt_id, target_prompt_id,
            target_slug, snapshot, created_by)
         VALUES ($1, 'upsert', $2, $3, $4, $5, $6::jsonb, $7::text)
         ON CONFLICT (event_key) DO NOTHING
         RETURNING id`,
        [
          awesomeTargetSystem,
          row.id,
          row.raw_prompt_id,
          row.target_prompt_id,
          row.target_slug,
          JSON.stringify({
            reason: "manual_requeue_all",
            approvedPromptId: row.id,
            promptHash: row.prompt_hash,
            category: row.category,
            requestedBy: createdBy
          }),
          createdBy
        ]
      );
      if (event.rowCount) queued += 1;
    }
    await client.query("COMMIT");
    return queued;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function handleAwesomeSyncOutput(chunk, streamName) {
  const text = chunk.toString("utf8");
  if (streamName === "stdout") awesomeSyncRun._stdoutText += text;
  else awesomeSyncRun._stderrText += text;
  const field = streamName === "stderr" ? "_stderrBuffer" : "_stdoutBuffer";
  awesomeSyncRun[field] += text;
  const lines = awesomeSyncRun[field].split(/\r?\n/);
  awesomeSyncRun[field] = lines.pop() || "";
  for (const line of lines) {
    if (line.trim()) addAwesomeSyncLog(`[${streamName}] ${line}`);
  }
}

function parseAwesomeSyncSummary() {
  const text = awesomeSyncRun._stdoutText.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const start = text.lastIndexOf("{");
    if (start >= 0) {
      try {
        return JSON.parse(text.slice(start));
      } catch {}
    }
    return { raw: text.slice(-2000) };
  }
}

async function finishAwesomeSyncRun(code) {
  for (const streamName of ["stdout", "stderr"]) {
    const field = streamName === "stderr" ? "_stderrBuffer" : "_stdoutBuffer";
    if (awesomeSyncRun[field]) handleAwesomeSyncOutput("\n", streamName);
  }
  awesomeSyncRun.endedAt = new Date().toISOString();
  awesomeSyncRun.pid = null;
  awesomeSyncRun._child = null;
  awesomeSyncRun.summary = parseAwesomeSyncSummary();
  awesomeSyncRun.counts = await readAwesomeSyncCounts().catch(() => null);
  if (code === 0) {
    awesomeSyncRun.status = "completed";
    addAwesomeSyncLog("awesome-image2 同步完成");
    const pendingEvents =
      (awesomeSyncRun.counts?.promptEvents?.pending || 0) +
      (awesomeSyncRun.counts?.categoryEvents?.pending || 0);
    if (pendingEvents > 0) {
      addAwesomeSyncLog(`检测到仍有 ${pendingEvents} 条待同步事件，准备自动续跑`);
      setTimeout(() => {
        startAwesomeSyncRun({ trigger: "auto-continue", requestedBy: "system" }).catch((error) => {
          addAwesomeSyncLog(`自动续跑失败：${error.message}`);
          console.error("Awesome sync auto-continue failed:", error);
        });
      }, 1000);
    }
  } else {
    awesomeSyncRun.status = "error";
    awesomeSyncRun.error = awesomeSyncRun._stderrText.trim().slice(-1000) || `SYNC_EXIT_${code}`;
    addAwesomeSyncLog(`awesome-image2 同步失败：${awesomeSyncRun.error}`);
  }
}

async function startAwesomeSyncRun(options = {}) {
  if (isAwesomeSyncActive()) {
    addAwesomeSyncLog(`已有同步任务运行中，跳过 ${options.trigger || "manual"} 触发`);
    return { started: false, reason: "SYNC_ALREADY_RUNNING", status: await publicAwesomeSyncStatus() };
  }

  const before = await readAwesomeSyncCounts().catch(() => null);
  resetAwesomeSyncRun(options, before);
  try {
    if (options.mode === "requeue-all") {
      awesomeSyncRun.queuedAll = await queueAllApprovedForAwesomeSync(options.requestedBy || "manual");
      addAwesomeSyncLog(`已将 ${awesomeSyncRun.queuedAll} 条已通过提示词重新加入同步队列`);
    }
  } catch (error) {
    awesomeSyncRun.status = "error";
    awesomeSyncRun.error = error.message;
    awesomeSyncRun.endedAt = new Date().toISOString();
    addAwesomeSyncLog(`同步排队失败：${error.message}`);
    throw error;
  }

  const args = [path.join(__dirname, "scripts", "sync-awesome-image2.js"), "--limit", String(awesomeSyncBatchSize)];
  if (options.all) args.push("--all");
  const child = spawn(process.execPath, args, {
    cwd: __dirname,
    env: { ...process.env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  awesomeSyncRun._child = child;
  awesomeSyncRun.pid = child.pid;
  addAwesomeSyncLog(`awesome-image2 同步已启动，PID ${child.pid}，模式 ${awesomeSyncRun.mode}`);
  child.stdout.on("data", (chunk) => handleAwesomeSyncOutput(chunk, "stdout"));
  child.stderr.on("data", (chunk) => handleAwesomeSyncOutput(chunk, "stderr"));
  child.on("error", (error) => {
    awesomeSyncRun.status = "error";
    awesomeSyncRun.error = error.message;
    awesomeSyncRun.endedAt = new Date().toISOString();
    awesomeSyncRun._child = null;
    addAwesomeSyncLog(`awesome-image2 同步启动失败：${error.message}`);
  });
  child.on("close", (code) => {
    finishAwesomeSyncRun(code).catch((error) => {
      awesomeSyncRun.status = "error";
      awesomeSyncRun.error = error.message;
      console.error("Failed to finalize awesome sync:", error);
    });
  });
  return { started: true, status: await publicAwesomeSyncStatus() };
}

function autoStartAwesomeSync(options = {}) {
  startAwesomeSyncRun({ ...options, mode: options.mode || "pending" }).catch((error) => {
    addAwesomeSyncLog(`自动同步触发失败：${error.message}`);
    console.error("Auto awesome sync failed:", error);
  });
}

async function publicAwesomeSyncStatus() {
  const counts = await readAwesomeSyncCounts();
  const beforePending = awesomeSyncRun.before?.pendingTotal || counts.pendingTotal;
  const pendingNow = counts.pendingTotal;
  const progress =
    awesomeSyncRun.status === "running"
      ? beforePending > 0
        ? Math.max(0, Math.min(99, Math.round(((beforePending - pendingNow) / beforePending) * 100)))
        : 10
      : awesomeSyncRun.status === "idle"
        ? 0
        : 100;
  return {
    ok: true,
    status: awesomeSyncRun.status,
    runId: awesomeSyncRun.runId,
    trigger: awesomeSyncRun.trigger,
    mode: awesomeSyncRun.mode,
    requestedBy: awesomeSyncRun.requestedBy,
    startedAt: awesomeSyncRun.startedAt,
    endedAt: awesomeSyncRun.endedAt,
    pid: awesomeSyncRun.pid,
    queuedAll: awesomeSyncRun.queuedAll,
    progress,
    before: awesomeSyncRun.before,
    counts,
    summary: awesomeSyncRun.summary,
    error: awesomeSyncRun.error,
    logs: awesomeSyncRun.logs.slice(-50),
    logPath: awesomeSyncRun.logPath
  };
}

function taskTemplate(name, label) {
  return {
    name,
    label,
    pid: null,
    status: "idle",
    current: 0,
    total: 0,
    phase: "",
    subject: "",
    fetched: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    lastLine: "",
    exitCode: null,
    startedAt: null,
    endedAt: null,
    _child: null,
    _stdoutBuffer: "",
    _stderrBuffer: "",
    _seenSteps: new Set()
  };
}

function resetScrapeRun(beforeCounts, options = {}) {
  scrapeRun.status = "running";
  scrapeRun.runId = timestampForFile();
  scrapeRun.trigger = options.trigger || "manual";
  scrapeRun.scheduleId = options.scheduleId || null;
  scrapeRun.scheduleEndAt = options.scheduleEndAt || null;
  scrapeRun.startedAt = new Date().toISOString();
  scrapeRun.endedAt = null;
  scrapeRun.before = beforeCounts;
  scrapeRun.finalCounts = null;
  scrapeRun.finalDelta = null;
  scrapeRun.autoReview = null;
  scrapeRun.requestedStop = false;
  scrapeRun.logPath = path.join(logsDir, `scrape-ui-${scrapeRun.runId}.log`);
  scrapeRun.logs = [];
  scrapeRun.tasks = {
    collect: taskTemplate("collect", "提示词"),
    discover: taskTemplate("discover", "博主")
  };
}

function publicTask(task) {
  return {
    name: task.name,
    label: task.label,
    pid: task.pid,
    status: task.status,
    current: task.current,
    total: task.total,
    phase: task.phase,
    subject: task.subject,
    fetched: task.fetched,
    inserted: task.inserted,
    updated: task.updated,
    skipped: task.skipped,
    errors: task.errors,
    lastLine: task.lastLine,
    exitCode: task.exitCode,
    startedAt: task.startedAt,
    endedAt: task.endedAt
  };
}

function doingfbTaskTemplate() {
  return taskTemplate("doingfb", "DoingFB");
}

function resetDoingfbRun(beforeCounts) {
  doingfbRun.status = "running";
  doingfbRun.runId = timestampForFile();
  doingfbRun.startedAt = new Date().toISOString();
  doingfbRun.endedAt = null;
  doingfbRun.before = beforeCounts;
  doingfbRun.finalCounts = null;
  doingfbRun.finalDelta = null;
  doingfbRun.autoReview = null;
  doingfbRun.requestedStop = false;
  doingfbRun.logPath = path.join(logsDir, `doingfb-ui-${doingfbRun.runId}.log`);
  doingfbRun.logs = [];
  doingfbRun.task = doingfbTaskTemplate();
  doingfbBatchReviewState.lastCursor = 0;
  doingfbBatchReviewState.running = false;
}

function doingfbProgress() {
  const task = doingfbRun.task;
  if (!task) return 0;
  if (["completed", "stopped"].includes(task.status)) return 100;
  if (task.status === "failed") return task.total ? Math.round((task.current / task.total) * 100) : 100;
  return task.total ? Math.round((Math.min(task.current, task.total) / task.total) * 100) : 0;
}

function addDoingfbLog(line) {
  const text = String(line || "").trimEnd();
  if (!text) return;
  const entry = `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${text}`;
  doingfbRun.logs.push(entry);
  if (doingfbRun.logs.length > 120) doingfbRun.logs.splice(0, doingfbRun.logs.length - 120);
  if (doingfbRun.logPath) {
    fs.mkdir(path.dirname(doingfbRun.logPath), { recursive: true })
      .then(() => fs.appendFile(doingfbRun.logPath, `${entry}\n`, "utf8"))
      .catch((error) => console.warn("Failed to write DoingFB log:", error.message));
  }
}

function parseDoingfbTaskLine(task, line) {
  const progress = line.match(
    /^DOINGFB_PROGRESS\s+current=(\d+)\s+total=(\d+)\s+fetched=(\d+)\s+inserted=(\d+)\s+skipped=(\d+)\s+errors=(\d+)\s+subject=(.*)$/i
  );
  if (progress) {
    const [, current, total, fetched, inserted, skipped, errors, subject] = progress;
    task.current = Number(current);
    task.total = Number(total);
    task.fetched = Number(fetched);
    task.inserted = Number(inserted);
    task.skipped = Number(skipped);
    task.errors = Number(errors);
    task.subject = subject || "";
    task.phase = "分页采集";
    return;
  }
  if (/DOINGFB_ERROR|error=/i.test(line) || /^Error:/i.test(line)) task.errors += 1;
}

function handleDoingfbOutput(task, chunk, streamName) {
  const field = streamName === "stderr" ? "_stderrBuffer" : "_stdoutBuffer";
  task[field] += chunk.toString("utf8");
  const lines = task[field].split(/\r?\n/);
  task[field] = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    task.lastLine = line;
    parseDoingfbTaskLine(task, line);
    addDoingfbLog(`[DoingFB] ${line}`);
    if (/^DOINGFB_PROGRESS\s+/i.test(line)) {
      reviewDoingfbBatch().catch((error) => {
        addDoingfbLog(`DoingFB 批次初审触发失败：${error.message}`);
        console.error("DoingFB batch review trigger failed:", error);
      });
    }
  }
}

async function reviewDoingfbBatch(force = false) {
  if (doingfbBatchReviewState.running) return null;
  if (!doingfbRun.startedAt) return null;
  const task = doingfbRun.task;
  const cursor = Number(task?.fetched || 0);
  if (!force && cursor <= doingfbBatchReviewState.lastCursor) return null;

  doingfbBatchReviewState.running = true;
  doingfbBatchReviewState.lastCursor = Math.max(doingfbBatchReviewState.lastCursor, cursor);
  addDoingfbLog(`开始自动初审 DoingFB 批次：已抓取 ${cursor || "-"}`);
  try {
    const summary = await autoReviewPendingPrompts({
      reviewer: "auto:doingfb",
      limit: 1000,
      sourcePlatform: "doingfb",
      startedAt: doingfbRun.startedAt,
      endedAt: new Date().toISOString(),
      order: "oldest"
    });
    doingfbRun.autoReview = {
      scanned: (doingfbRun.autoReview?.scanned || 0) + summary.scanned,
      approved: (doingfbRun.autoReview?.approved || 0) + summary.approved,
      duplicate: (doingfbRun.autoReview?.duplicate || 0) + summary.duplicate,
      rejected: (doingfbRun.autoReview?.rejected || 0) + summary.rejected,
      cleaned: (doingfbRun.autoReview?.cleaned || 0) + summary.cleaned,
      failed: (doingfbRun.autoReview?.failed || 0) + summary.failed,
      lastBatch: summary,
      updatedAt: new Date().toISOString()
    };
    addDoingfbLog(
      `DoingFB 批次初审完成：扫描 ${summary.scanned}，通过 ${summary.approved}，重复 ${summary.duplicate}，驳回 ${summary.rejected}，清理 ${summary.cleaned}，失败 ${summary.failed}`
    );
    if ((summary.approved || 0) + (summary.duplicate || 0) > 0) {
      addDoingfbLog("DoingFB 批次通过数据已入队，触发 awesome-image2 同步");
      autoStartAwesomeSync({ trigger: "doingfb-auto-review", requestedBy: "auto:doingfb" });
    }
    return summary;
  } finally {
    doingfbBatchReviewState.running = false;
  }
}

async function completeDoingfbRun(task = doingfbRun.task) {
  if (doingfbRun.endedAt) return;
  const taskEndedAt = new Date().toISOString();
  let finalStatus;
  if (doingfbRun.requestedStop) finalStatus = "stopped";
  else if (task?.status === "failed") finalStatus = "error";
  else finalStatus = "completed";

  let autoReviewSummary = null;
  if (finalStatus === "completed" && doingfbRun.startedAt) {
    doingfbRun.status = "reviewing";
    addDoingfbLog("开始自动初审本轮 DoingFB 剩余提示词");
    try {
      autoReviewSummary = await reviewDoingfbBatch(true);
      addDoingfbLog(
        `自动初审累计：扫描 ${doingfbRun.autoReview?.scanned || 0}，通过 ${doingfbRun.autoReview?.approved || 0}，重复 ${doingfbRun.autoReview?.duplicate || 0}，驳回 ${doingfbRun.autoReview?.rejected || 0}，清理 ${doingfbRun.autoReview?.cleaned || 0}，失败 ${doingfbRun.autoReview?.failed || 0}`
      );
    } catch (error) {
      autoReviewSummary = { error: error.message };
      addDoingfbLog(`自动初审失败：${error.message}`);
      console.error("Auto review after DoingFB scrape failed:", error);
    }
  }

  doingfbRun.endedAt = new Date().toISOString();
  doingfbRun.status = finalStatus;
  const counts = await readScrapeCounts().catch(() => null);
  doingfbRun.finalCounts = counts;
  doingfbRun.autoReview = doingfbRun.autoReview || autoReviewSummary;
  doingfbRun.finalDelta = counts && doingfbRun.before
    ? {
        raw: counts.rawTotal - doingfbRun.before.rawTotal,
        doingfb: counts.doingfbTotal - doingfbRun.before.doingfbTotal,
        creators: counts.creators - doingfbRun.before.creators,
        cloudImages: counts.cloudImages - doingfbRun.before.cloudImages,
        approved: counts.approved - doingfbRun.before.approved
      }
    : null;
  addDoingfbLog(`DoingFB 采集${doingfbRun.status === "completed" ? "完成" : doingfbRun.status === "stopped" ? "已停止" : "异常结束"}`);
}

function spawnDoingfbTask(env) {
  const task = doingfbRun.task;
  task.status = "running";
  task.startedAt = new Date().toISOString();
  const child = spawn(process.execPath, [path.join(__dirname, "scripts", "scrape-doingfb.js")], {
    cwd: __dirname,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  task._child = child;
  task.pid = child.pid;
  addDoingfbLog(`DoingFB 采集已启动，PID ${child.pid}`);
  child.stdout.on("data", (chunk) => handleDoingfbOutput(task, chunk, "stdout"));
  child.stderr.on("data", (chunk) => handleDoingfbOutput(task, chunk, "stderr"));
  child.on("error", (error) => {
    task.status = "failed";
    task.errors += 1;
    task.lastLine = error.message;
    task.endedAt = new Date().toISOString();
    addDoingfbLog(`DoingFB 启动失败：${error.message}`);
    completeDoingfbRun(task).catch((completeError) => console.error("Failed to finalize DoingFB run:", completeError));
  });
  child.on("close", (code) => {
    for (const streamName of ["stdout", "stderr"]) {
      const field = streamName === "stderr" ? "_stderrBuffer" : "_stdoutBuffer";
      if (task[field]) handleDoingfbOutput(task, "\n", streamName);
    }
    task.exitCode = code;
    task.endedAt = new Date().toISOString();
    if (doingfbRun.requestedStop) task.status = "stopped";
    else task.status = code === 0 ? "completed" : "failed";
    task._child = null;
    addDoingfbLog(`DoingFB 进程结束，退出码 ${code}`);
    completeDoingfbRun(task).catch((error) => console.error("Failed to finalize DoingFB run:", error));
  });
}

async function publicDoingfbStatus() {
  const counts = await readScrapeCounts();
  const before = doingfbRun.before || counts;
  return {
    ok: true,
    status: doingfbRun.status,
    runId: doingfbRun.runId,
    startedAt: doingfbRun.startedAt,
    endedAt: doingfbRun.endedAt,
    autoReview: doingfbRun.autoReview,
    progress: doingfbProgress(),
    before,
    counts,
    delta: {
      raw: counts.rawTotal - before.rawTotal,
      doingfb: counts.doingfbTotal - before.doingfbTotal,
      creators: counts.creators - before.creators,
      cloudImages: counts.cloudImages - before.cloudImages,
      approved: counts.approved - before.approved
    },
    task: doingfbRun.task ? publicTask(doingfbRun.task) : null,
    logs: doingfbRun.logs.slice(-40),
    logPath: doingfbRun.logPath
  };
}

async function startDoingfbRun(options = {}) {
  if (isDoingfbActive()) {
    const error = new Error("DOINGFB_ALREADY_RUNNING");
    error.statusCode = 409;
    throw error;
  }
  const before = await readScrapeCounts();
  resetDoingfbRun(before);
  addDoingfbLog("DoingFB 手动采集任务已启动");
  spawnDoingfbTask({
    ARCHIVE_IMAGES: "1",
    DOINGFB_MAX_ITEMS: String(Math.max(0, Number(options.maxItems || process.env.UI_DOINGFB_MAX_ITEMS || 0))),
    DOINGFB_DELAY_MS: process.env.UI_DOINGFB_DELAY_MS || "250",
    DOINGFB_REQUEST_TIMEOUT_MS: process.env.UI_DOINGFB_REQUEST_TIMEOUT_MS || "30000",
    IMAGE_ARCHIVE_BATCH_SIZE: process.env.UI_IMAGE_ARCHIVE_BATCH_SIZE || "10"
  });
}

async function stopDoingfbRun(message = "正在停止 DoingFB 采集任务") {
  if (!isDoingfbActive()) return false;
  if (doingfbRun.status === "stopping") return true;
  doingfbRun.requestedStop = true;
  doingfbRun.status = "stopping";
  addDoingfbLog(message);
  const task = doingfbRun.task;
  if (task?._child && ["running", "paused"].includes(task.status)) {
    await controlProcessTree(task.pid, "resume").catch(() => {});
    await controlProcessTree(task.pid, "stop").catch(() => {});
    task.status = "stopped";
  }
  completeDoingfbRun(task).catch((error) => console.error("Failed to finalize DoingFB stop:", error));
  return true;
}

function scrapeProgress() {
  const tasks = Object.values(scrapeRun.tasks || {});
  if (!tasks.length) return 0;
  const values = tasks.map((task) => {
    if (["completed", "stopped"].includes(task.status)) return 1;
    if (task.status === "failed") return task.total ? task.current / task.total : 1;
    return task.total ? Math.min(1, task.current / task.total) : 0;
  });
  return Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100);
}

function addScrapeLog(line) {
  const text = String(line || "").trimEnd();
  if (!text) return;
  const entry = `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${text}`;
  scrapeRun.logs.push(entry);
  if (scrapeRun.logs.length > 120) scrapeRun.logs.splice(0, scrapeRun.logs.length - 120);
  if (scrapeRun.logPath) {
    fs.mkdir(path.dirname(scrapeRun.logPath), { recursive: true })
      .then(() => fs.appendFile(scrapeRun.logPath, `${entry}\n`, "utf8"))
      .catch((error) => console.warn("Failed to write scrape log:", error.message));
  }
}

function parseTaskLine(task, line) {
  const collect = line.match(/^\[(\d+)\/(\d+)]\s+([^:]+):\s+fetched=(\d+)\s+inserted=(\d+)\s+skipped=(\d+)/);
  if (task.name === "collect" && collect) {
    const [, current, total, subject, fetched, inserted, skipped] = collect;
    const stepKey = `${current}/${total}`;
    task.current = Number(current);
    task.total = Number(total);
    task.subject = subject;
    task.fetched += Number(fetched);
    if (!task._seenSteps.has(stepKey)) {
      task.inserted += Number(inserted);
      task.skipped += Number(skipped);
      task._seenSteps.add(stepKey);
    }
    return;
  }

  const discover = line.match(/^\[(search|seed)\s+(\d+)\/(\d+)]\s+([^:]+):.*candidates=(\d+)\s+inserted=(\d+)\s+updated=(\d+)\s+skipped=(\d+)/);
  if (task.name === "discover" && discover) {
    const [, phase, current, total, subject, candidates, inserted, updated, skipped] = discover;
    const phaseOffset = phase === "seed" ? 12 : 0;
    const stepKey = `${phase}:${current}/${total}`;
    task.phase = phase === "seed" ? "种子扩展" : "关键词搜索";
    task.current = phaseOffset + Number(current);
    task.total = phase === "seed" ? phaseOffset + Number(total) : Math.max(12, Number(total));
    task.subject = subject;
    task.fetched += Number(candidates);
    if (!task._seenSteps.has(stepKey)) {
      task.inserted += Number(inserted);
      task.updated += Number(updated);
      task.skipped += Number(skipped);
      task._seenSteps.add(stepKey);
    }
    return;
  }

  if (/error=/i.test(line) || /^Error:/i.test(line)) task.errors += 1;
}

function handleTaskOutput(task, chunk, streamName) {
  const field = streamName === "stderr" ? "_stderrBuffer" : "_stdoutBuffer";
  task[field] += chunk.toString("utf8");
  const lines = task[field].split(/\r?\n/);
  task[field] = lines.pop() || "";
  for (const line of lines) {
    if (!line.trim()) continue;
    task.lastLine = line;
    parseTaskLine(task, line);
    addScrapeLog(`[${task.label}] ${line}`);
  }
}

function finalizeScrapeIfDone() {
  const tasks = Object.values(scrapeRun.tasks || {});
  if (!tasks.length || !["running", "paused", "stopping"].includes(scrapeRun.status)) return;
  const done = tasks.every((task) => ["completed", "failed", "stopped"].includes(task.status));
  if (!done) return;
  completeScrapeRun(tasks).catch((error) => {
    console.error("Failed to finalize scrape run:", error);
  });
}

async function completeScrapeRun(tasks = Object.values(scrapeRun.tasks || {})) {
  if (scrapeRun.endedAt) return;
  const taskEndedAt = new Date().toISOString();
  let finalStatus;
  if (scrapeRun.requestedStop) finalStatus = "stopped";
  else if (tasks.some((task) => task.status === "failed")) finalStatus = "error";
  else finalStatus = "completed";
  let autoReviewSummary = null;
  if (finalStatus === "completed" && scrapeRun.startedAt) {
    scrapeRun.status = "reviewing";
    addScrapeLog("开始自动初审本轮新增提示词");
    try {
      autoReviewSummary = await autoReviewPendingPrompts({
        reviewer: "auto:scrape",
        limit: 1000,
        startedAt: scrapeRun.startedAt,
        endedAt: taskEndedAt,
        order: "oldest"
      });
      if ((autoReviewSummary.approved || 0) + (autoReviewSummary.duplicate || 0) > 0) {
        addScrapeLog("采集后自动审核已入队，触发 awesome-image2 同步");
        autoStartAwesomeSync({ trigger: "scrape-auto-review", requestedBy: "auto:scrape" });
      }
      addScrapeLog(
        `自动初审完成：扫描 ${autoReviewSummary.scanned}，通过 ${autoReviewSummary.approved}，重复 ${autoReviewSummary.duplicate}，驳回 ${autoReviewSummary.rejected}，清洗 ${autoReviewSummary.cleaned}，失败 ${autoReviewSummary.failed}`
      );
    } catch (error) {
      autoReviewSummary = { error: error.message };
      addScrapeLog(`自动初审失败：${error.message}`);
      console.error("Auto review after scrape failed:", error);
    }
  }
  scrapeRun.endedAt = new Date().toISOString();
  scrapeRun.status = finalStatus;
  const counts = await readScrapeCounts().catch(() => null);
  scrapeRun.finalCounts = counts;
  scrapeRun.autoReview = autoReviewSummary;
  scrapeRun.finalDelta = counts && scrapeRun.before
    ? {
        raw: counts.rawTotal - scrapeRun.before.rawTotal,
        x: counts.xTotal - scrapeRun.before.xTotal,
        creators: counts.creators - scrapeRun.before.creators,
        cloudImages: counts.cloudImages - scrapeRun.before.cloudImages
      }
    : null;
  addScrapeLog(`采集任务${scrapeRun.status === "completed" ? "完成" : scrapeRun.status === "stopped" ? "已停止" : "异常结束"}`);
  scrapeHistory.unshift({
    runId: scrapeRun.runId,
    trigger: scrapeRun.trigger,
    scheduleId: scrapeRun.scheduleId,
    scheduleEndAt: scrapeRun.scheduleEndAt,
    status: scrapeRun.status,
    startedAt: scrapeRun.startedAt,
    endedAt: scrapeRun.endedAt,
    before: scrapeRun.before,
    counts,
    delta: scrapeRun.finalDelta,
    autoReview: autoReviewSummary,
    tasks: Object.fromEntries(Object.entries(scrapeRun.tasks || {}).map(([name, task]) => [name, publicTask(task)])),
    logs: scrapeRun.logs.slice(-80),
    logPath: scrapeRun.logPath
  });
  await saveHistory().catch((error) => console.warn("Failed to save scrape history:", error.message));
}

function spawnScrapeTask(name, label, scriptName, env) {
  const task = scrapeRun.tasks[name];
  task.status = "running";
  task.startedAt = new Date().toISOString();
  const child = spawn(process.execPath, [path.join(__dirname, "scripts", scriptName)], {
    cwd: __dirname,
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  task._child = child;
  task.pid = child.pid;
  addScrapeLog(`[${label}] 已启动 PID ${child.pid}`);
  child.stdout.on("data", (chunk) => handleTaskOutput(task, chunk, "stdout"));
  child.stderr.on("data", (chunk) => handleTaskOutput(task, chunk, "stderr"));
  child.on("error", (error) => {
    task.status = "failed";
    task.errors += 1;
    task.lastLine = error.message;
    task.endedAt = new Date().toISOString();
    addScrapeLog(`[${label}] 启动失败：${error.message}`);
    finalizeScrapeIfDone();
  });
  child.on("close", (code) => {
    for (const streamName of ["stdout", "stderr"]) {
      const field = streamName === "stderr" ? "_stderrBuffer" : "_stdoutBuffer";
      if (task[field]) handleTaskOutput(task, "\n", streamName);
    }
    task.exitCode = code;
    task.endedAt = new Date().toISOString();
    if (scrapeRun.requestedStop) task.status = "stopped";
    else task.status = code === 0 ? "completed" : "failed";
    task._child = null;
    addScrapeLog(`[${label}] 结束，退出码 ${code}`);
    finalizeScrapeIfDone();
  });
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString("utf8"));
      } else {
        reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `PowerShell exited with ${code}`));
      }
    });
  });
}

async function controlProcessTree(pid, action) {
  if (!pid) return;
  if (process.platform !== "win32") {
    const signal = action === "pause" ? "SIGSTOP" : action === "resume" ? "SIGCONT" : "SIGTERM";
    try {
      process.kill(pid, signal);
    } catch {}
    return;
  }
  const cmdlet = action === "pause" ? "Suspend-Process" : action === "resume" ? "Resume-Process" : "Stop-Process -Force";
  const script = `
    $ErrorActionPreference='SilentlyContinue'
    $ids = New-Object System.Collections.Generic.List[int]
    function Add-Tree([int]$id) {
      if ($ids.Contains($id)) { return }
      $ids.Add($id)
      Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $id } | ForEach-Object { Add-Tree ([int]$_.ProcessId) }
    }
    Add-Tree ${Number(pid)}
    $ids | Sort-Object -Descending | ForEach-Object { ${cmdlet} -Id $_ }
  `;
  await runPowerShell(script);
}

async function publicScrapeStatus() {
  const counts = await readScrapeCounts();
  const before = scrapeRun.before || counts;
  return {
    ok: true,
    status: scrapeRun.status,
    runId: scrapeRun.runId,
    trigger: scrapeRun.trigger,
    scheduleId: scrapeRun.scheduleId,
    scheduleEndAt: scrapeRun.scheduleEndAt,
    startedAt: scrapeRun.startedAt,
    endedAt: scrapeRun.endedAt,
    autoReview: scrapeRun.autoReview,
    progress: scrapeProgress(),
    before,
    counts,
    delta: {
      raw: counts.rawTotal - before.rawTotal,
      x: counts.xTotal - before.xTotal,
      creators: counts.creators - before.creators,
      cloudImages: counts.cloudImages - before.cloudImages
    },
    tasks: Object.fromEntries(Object.entries(scrapeRun.tasks || {}).map(([name, task]) => [name, publicTask(task)])),
    logs: scrapeRun.logs.slice(-40),
    logPath: scrapeRun.logPath
  };
}

async function startScrapeRun(options = {}) {
  if (isScrapeActive()) {
    const error = new Error("SCRAPE_ALREADY_RUNNING");
    error.statusCode = 409;
    throw error;
  }
  const before = await readScrapeCounts();
  resetScrapeRun(before, options);
  addScrapeLog(options.trigger === "schedule" ? "定时采集任务已启动" : "采集任务已启动");
  spawnScrapeTask("collect", "提示词", "scrape-twitter-rss.js", {
    ARCHIVE_IMAGES: "1",
    MAX_CREATORS: process.env.UI_SCRAPE_MAX_CREATORS || "500",
    MAX_ITEMS_PER_CREATOR: process.env.UI_SCRAPE_MAX_ITEMS_PER_CREATOR || "25",
    SCRAPE_DELAY_MS: process.env.UI_SCRAPE_DELAY_MS || "800",
    REQUEST_TIMEOUT_MS: process.env.UI_SCRAPE_REQUEST_TIMEOUT_MS || "18000",
    IMAGE_ARCHIVE_BATCH_SIZE: process.env.UI_IMAGE_ARCHIVE_BATCH_SIZE || "10",
    NITTER_BASES: process.env.UI_NITTER_BASES || "https://nitter.net,https://rss.xcancel.com"
  });
  spawnScrapeTask("discover", "博主", "discover-twitter-creators.js", {
    DISCOVERY_MODE: process.env.UI_DISCOVERY_MODE || "search,seeds",
    NITTER_SEARCH_BASES: process.env.UI_NITTER_SEARCH_BASES || "https://nitter.net,https://rss.xcancel.com,https://xcancel.com",
    REQUEST_TIMEOUT_MS: process.env.UI_SCRAPE_REQUEST_TIMEOUT_MS || "18000",
    DISCOVERY_DELAY_MS: process.env.UI_DISCOVERY_DELAY_MS || "900"
  });
}

async function stopScrapeRun(message = "正在停止采集任务") {
  if (!isScrapeActive()) return false;
  if (scrapeRun.status === "stopping") return true;
  scrapeRun.requestedStop = true;
  scrapeRun.status = "stopping";
  addScrapeLog(message);
  const tasks = Object.values(scrapeRun.tasks).filter((task) => task._child && ["running", "paused"].includes(task.status));
  await Promise.all(tasks.map((task) => controlProcessTree(task.pid, "resume").catch(() => {})));
  await Promise.all(tasks.map((task) => controlProcessTree(task.pid, "stop").catch(() => {})));
  for (const task of tasks) task.status = "stopped";
  finalizeScrapeIfDone();
  return true;
}

async function checkSchedules() {
  if (scheduleTickRunning) return;
  scheduleTickRunning = true;
  try {
    const now = new Date();
    const dateKey = todayKey(now);
    if (isScrapeActive() && scrapeRun.trigger === "schedule" && scrapeRun.scheduleEndAt) {
      const endAt = new Date(scrapeRun.scheduleEndAt);
      if (!Number.isNaN(endAt.getTime()) && now >= endAt) {
        await stopScrapeRun("定时采集窗口已结束，正在停止采集任务");
      }
    }
    for (const schedule of scrapeSchedules) {
      if (!isScheduleStartDue(schedule, now, dateKey)) continue;
      if (isScrapeActive()) {
        schedule.lastSkipAt = now.toISOString();
        schedule.lastSkipReason = "采集任务正在运行";
        await saveSchedules();
        continue;
      }
      schedule.lastRunDate = dateKey;
      schedule.lastRunAt = now.toISOString();
      await saveSchedules();
      const endAt = scheduleEndDate(schedule, now);
      await startScrapeRun({ trigger: "schedule", scheduleId: schedule.id, scheduleEndAt: endAt?.toISOString() || null });
      addScrapeLog(`采集窗口 ${schedule.startTime}-${schedule.endTime}，到点自动停止`);
      break;
    }
  } catch (error) {
    console.error("Schedule check failed:", error);
  } finally {
    scheduleTickRunning = false;
  }
}

function startScheduler() {
  if (scheduleTimer) clearInterval(scheduleTimer);
  scheduleTimer = setInterval(() => {
    checkSchedules().catch((error) => console.error("Schedule tick failed:", error));
  }, 30 * 1000);
  checkSchedules().catch((error) => console.error("Initial schedule check failed:", error));
}

function isImageContent(contentType, url) {
  const normalized = normalizeContentType(contentType);
  return normalized.startsWith("image/") || inferImageContentType(url).startsWith("image/");
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function hasLocalProxy() {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port: 7890 });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(350);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function runCurl(args, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === "win32" ? "curl.exe" : "curl", args, {
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"]
    });
    const stderr = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("IMAGE_CURL_TIMEOUT"));
    }, timeoutMs);
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(Buffer.concat(stderr).toString("utf8").trim() || `IMAGE_CURL_${code}`));
    });
  });
}

function parseCurlHeaders(headerText) {
  const blocks = String(headerText || "")
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter(Boolean);
  const last = blocks.at(-1) || "";
  const status = Number(last.match(/^HTTP\/\S+\s+(\d+)/i)?.[1] || 0);
  const contentType =
    last
      .split(/\r?\n/)
      .find((line) => /^content-type:/i.test(line))
      ?.split(":")
      .slice(1)
      .join(":")
      .trim() || "";
  return { status, contentType };
}

async function fetchImageWithCurl(url) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "prompt-image-"));
  const bodyPath = path.join(tempDir, "body.bin");
  const headerPath = path.join(tempDir, "headers.txt");
  try {
    const args = [
      "--location",
      "--silent",
      "--show-error",
      "--connect-timeout",
      "8",
      "--max-time",
      "35",
      "--retry",
      "1",
      "--user-agent",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      "--header",
      "Accept: image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "--dump-header",
      headerPath,
      "--output",
      bodyPath
    ];
    const explicitProxy = process.env.IMAGE_PROXY_URL || "";
    if (explicitProxy) {
      args.unshift("--proxy", explicitProxy);
    } else if (!process.env.HTTP_PROXY && !process.env.HTTPS_PROXY && (await hasLocalProxy())) {
      args.unshift("--proxy", "http://127.0.0.1:7890");
    }
    args.push(url);

    await runCurl(args);
    const [headers, body] = await Promise.all([fs.readFile(headerPath, "utf8"), fs.readFile(bodyPath)]);
    const { status, contentType } = parseCurlHeaders(headers);
    if (status < 200 || status >= 300) throw new Error(`IMAGE_HTTP_${status || "UNKNOWN"}`);
    if (body.length > maxImageBytes) throw new Error("IMAGE_TOO_LARGE");
    const finalContentType = normalizeContentType(contentType) || inferImageContentType(url);
    if (!isImageContent(finalContentType, url)) throw new Error("IMAGE_CONTENT_TYPE");
    return { body, contentType: finalContentType };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function fetchRemoteImage(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
        Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
      }
    });
    if (!response.ok) throw new Error(`IMAGE_HTTP_${response.status}`);
    const contentType = normalizeContentType(response.headers.get("content-type")) || inferImageContentType(url);
    if (!isImageContent(contentType, url)) throw new Error("IMAGE_CONTENT_TYPE");
    const body = Buffer.from(await response.arrayBuffer());
    if (body.length > maxImageBytes) throw new Error("IMAGE_TOO_LARGE");
    return { body, contentType };
  } catch (error) {
    console.warn("Direct image fetch failed, trying curl:", error.message);
    return fetchImageWithCurl(url);
  }
}

async function loadImage(url) {
  await fs.mkdir(imageCacheDir, { recursive: true });
  const key = imageCacheKey(url);
  const bodyPath = path.join(imageCacheDir, `${key}.bin`);
  const metaPath = path.join(imageCacheDir, `${key}.json`);

  if ((await fileExists(bodyPath)) && (await fileExists(metaPath))) {
    const [body, meta] = await Promise.all([fs.readFile(bodyPath), fs.readFile(metaPath, "utf8")]);
    const parsed = JSON.parse(meta);
    return { body, contentType: parsed.contentType || inferImageContentType(url), cached: true };
  }

  const fetched = await fetchRemoteImage(url);
  await Promise.all([
    fs.writeFile(bodyPath, fetched.body),
    fs.writeFile(
      metaPath,
      JSON.stringify({ sourceUrl: url, contentType: fetched.contentType, cachedAt: new Date().toISOString() }, null, 2)
    )
  ]);
  return { ...fetched, cached: false };
}

function splitTextForTranslate(text, maxLength = 1400) {
  const paragraphs = String(text || "").split(/(\n{2,})/);
  const chunks = [];
  let current = "";
  for (const part of paragraphs) {
    if (part.length > maxLength) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let index = 0; index < part.length; index += maxLength) {
        chunks.push(part.slice(index, index + maxLength));
      }
      continue;
    }
    if ((current + part).length > maxLength) {
      chunks.push(current);
      current = part;
    } else {
      current += part;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function translateChunk(text) {
  const url = new URL("https://translate.googleapis.com/translate_a/single");
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "auto");
  url.searchParams.set("tl", "zh-CN");
  url.searchParams.append("dt", "t");
  url.searchParams.set("q", text);

  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36"
    }
  });
  if (!response.ok) throw new Error(`TRANSLATE_HTTP_${response.status}`);
  const data = await response.json();
  return Array.isArray(data?.[0]) ? data[0].map((item) => item?.[0] || "").join("") : "";
}

async function translateChunkWithMyMemory(text) {
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", text);
  url.searchParams.set("langpair", "en|zh-CN");

  const response = await fetch(url, {
    signal: AbortSignal.timeout(12000),
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36",
      Accept: "application/json"
    }
  });
  if (!response.ok) throw new Error(`MYMEMORY_HTTP_${response.status}`);
  const data = await response.json();
  if (data?.responseStatus && data.responseStatus !== 200) {
    throw new Error(`MYMEMORY_STATUS_${data.responseStatus}`);
  }
  const translatedText = data?.responseData?.translatedText;
  if (typeof translatedText !== "string") throw new Error("MYMEMORY_EMPTY_RESPONSE");
  return translatedText;
}

async function translateTextChunk(text) {
  try {
    return await translateChunk(text);
  } catch (error) {
    console.warn("Google translate failed, falling back to MyMemory:", error.message);
    const chunks = splitTextForTranslate(text, 450);
    const translated = [];
    for (const chunk of chunks) {
      translated.push(await translateChunkWithMyMemory(chunk));
    }
    return translated.join("");
  }
}

app.get("/api/health", async (_req, res, next) => {
  try {
    const result = await pool.query("SELECT now() AS now");
    res.json({ ok: true, now: result.rows[0].now });
  } catch (error) {
    next(error);
  }
});

app.get("/api/image", async (req, res) => {
  try {
    const url = parseImageUrl(req.query.url);
    const image = await loadImage(url.toString());
    res.setHeader("Content-Type", image.contentType);
    res.setHeader("Cache-Control", "public, max-age=604800, immutable");
    res.setHeader("X-Image-Cache", image.cached ? "HIT" : "MISS");
    res.send(image.body);
  } catch (error) {
    console.error("Image proxy failed:", error.message);
    res.status(502).json({ ok: false, error: "IMAGE_UNAVAILABLE" });
  }
});

app.get("/api/stats", async (_req, res, next) => {
  try {
    const [raw, approved, creators] = await Promise.all([
      pool.query("SELECT review_status, count(*)::int AS count FROM raw_prompt_templates GROUP BY review_status"),
      pool.query("SELECT count(*)::int AS count FROM approved_prompt_templates"),
      pool.query("SELECT count(*)::int AS count FROM twitter_creators")
    ]);
    res.json({
      raw: Object.fromEntries(raw.rows.map((row) => [row.review_status, row.count])),
      approved: approved.rows[0].count,
      creators: creators.rows[0].count
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/categories", async (_req, res, next) => {
  try {
    res.json({ ok: true, categories: await loadCategoriesFromDb() });
  } catch (error) {
    next(error);
  }
});

app.post("/api/categories", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const reviewer = req.user?.username || "unknown";
    const name = cleanCategoryName(req.body?.name);
    if (!name) {
      res.status(400).json({ ok: false, error: "CATEGORY_NAME_REQUIRED" });
      return;
    }
    await client.query("BEGIN");
    const maxOrder = await client.query("SELECT COALESCE(max(sort_order), 0)::int AS sort_order FROM prompt_categories");
    const provisionalSyncKey = `category:new:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const provisionalSlug = `category-new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const result = await client.query(
      `INSERT INTO prompt_categories (name, slug, aliases, sync_key, target_category_name, sync_status, sync_revision, sort_order)
       VALUES ($1, $2, '{}', $3, $1, 'pending', 1, $4)
       RETURNING id`,
      [name, provisionalSlug, provisionalSyncKey, (maxOrder.rows[0]?.sort_order || 0) + 10]
    );
    const categoryId = result.rows[0].id;
    await client.query(
      `UPDATE prompt_categories
       SET sync_key = $2,
           slug = $4
       WHERE id = $1 AND sync_key = $3`,
      [categoryId, `category:${categoryId}`, provisionalSyncKey, slugFromCategoryName(name, `category-${categoryId}`)]
    );
    await queueCategorySyncEvent(client, {
      categoryId,
      eventType: "create",
      newName: name,
      newTargetCategoryName: name,
      createdBy: reviewer
    });
    const category = await client.query(
      `SELECT id, name, slug, description, aliases, is_active, target_category_name, sync_status, sync_revision,
              last_synced_at, sync_error, sort_order
       FROM prompt_categories
       WHERE id = $1`,
      [categoryId]
    );
    await client.query("COMMIT");
    autoStartAwesomeSync({ trigger: "category-create", requestedBy: reviewer });
    res.json({ ok: true, item: publicCategory(category.rows[0]), categories: await loadCategoriesFromDb() });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") {
      res.status(409).json({ ok: false, error: "CATEGORY_EXISTS" });
      return;
    }
    next(error);
  } finally {
    client.release();
  }
});

app.patch("/api/categories/:id", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    const name = cleanCategoryName(req.body?.name);
    if (!Number.isFinite(id) || !name) {
      res.status(400).json({ ok: false, error: "INVALID_CATEGORY" });
      return;
    }
    await client.query("BEGIN");
    const current = await client.query(
      "SELECT id, name, slug, description, aliases, is_active, target_category_name, sync_status, sync_revision, last_synced_at, sync_error, sort_order FROM prompt_categories WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (!current.rowCount) {
      await client.query("ROLLBACK");
      res.status(404).json({ ok: false, error: "CATEGORY_NOT_FOUND" });
      return;
    }
    const oldName = current.rows[0].name;
    const aliases = current.rows[0].aliases || [];
    const oldTargetCategoryName = current.rows[0].target_category_name || oldName;
    if (oldName === name) {
      await client.query("ROLLBACK");
      res.json({ ok: true, item: publicCategory(current.rows[0]), updatedRaw: 0, updatedApproved: 0, categories: await loadCategoriesFromDb() });
      return;
    }
    const matchValues = [...new Set([oldName, ...aliases])];
    const nextAliases = [...new Set([oldName, ...aliases].filter((item) => item && item !== name))];
    const updated = await client.query(
      `UPDATE prompt_categories
       SET name = $2,
           aliases = $3,
           target_category_name = $2,
           sync_status = 'pending',
           sync_revision = sync_revision + 1,
           sync_error = NULL,
           updated_at = now()
       WHERE id = $1
       RETURNING id, name, slug, description, aliases, is_active, target_category_name, sync_status, sync_revision,
                 last_synced_at, sync_error, sort_order`,
      [id, name, nextAliases]
    );
    const raw = await client.query("UPDATE raw_prompt_templates SET category = $2 WHERE category = ANY($1::text[])", [matchValues, name]);
    const approved = await client.query(
      "UPDATE approved_prompt_templates SET category = $2 WHERE category = ANY($1::text[]) RETURNING id",
      [matchValues, name]
    );
    const queued = await queueApprovedPromptSyncsByCategoryNames(client, [name]);
    const queuedEvents = await queuePromptSyncEventsForApprovedIds(
      client,
      approved.rows.map((row) => row.id),
      "category_update",
      req.user?.username || "unknown",
      { reason: "category_renamed", oldName, newName: name }
    );
    await queueCategorySyncEvent(client, {
      categoryId: id,
      eventType: "rename",
      oldName,
      newName: name,
      oldTargetCategoryName,
      newTargetCategoryName: name,
      payload: { updatedRaw: raw.rowCount, updatedApproved: approved.rowCount, queuedPrompts: queued, queuedEvents },
      createdBy: req.user?.username || "unknown"
    });
    await client.query("COMMIT");
    autoStartAwesomeSync({ trigger: "category-rename", requestedBy: req.user?.username || "unknown" });
    res.json({
      ok: true,
      item: publicCategory(updated.rows[0]),
      updatedRaw: raw.rowCount,
      updatedApproved: approved.rowCount,
      categories: await loadCategoriesFromDb()
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505") {
      res.status(409).json({ ok: false, error: "CATEGORY_EXISTS" });
      return;
    }
    next(error);
  } finally {
    client.release();
  }
});

app.get("/api/creators", async (req, res, next) => {
  try {
    const search = String(req.query.search || "").trim();
    const limit = cleanLimit(req.query.limit);
    const offset = cleanOffset(req.query.offset);
    const values = [];
    const clauses = [];
    if (search) {
      values.push(`%${search}%`);
      clauses.push(`(
        handle ILIKE $${values.length}
        OR COALESCE(display_name, '') ILIKE $${values.length}
        OR COALESCE(bio, '') ILIKE $${values.length}
        OR COALESCE(discovery_query, '') ILIKE $${values.length}
      )`);
    }
    values.push(limit, offset);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT
        id, handle, profile_url, display_name, bio, avatar_url,
        source_case_count, status_link_count, discovery_score, discovery_source,
        discovery_query, monitor_enabled, last_scraped_at, last_scrape_status,
        last_scrape_error, first_discovered_at, last_discovered_at, last_seen_at,
        created_at, updated_at,
        count(*) OVER()::int AS total
       FROM twitter_creators
       ${where}
       ORDER BY monitor_enabled DESC, discovery_score DESC, source_case_count DESC,
                status_link_count DESC, last_seen_at DESC NULLS LAST, id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    res.json({ ok: true, items: result.rows, total: result.rows[0]?.total || 0, limit, offset });
  } catch (error) {
    next(error);
  }
});

app.get("/api/approved-prompts", async (req, res, next) => {
  try {
    const search = String(req.query.search || "").trim();
    const category = String(req.query.category || "all").trim();
    const limit = cleanLimit(req.query.limit);
    const offset = cleanOffset(req.query.offset);
    const values = [];
    const clauses = [];
    if (category && category !== "all") {
      values.push(categoryValues(category));
      clauses.push(`category = ANY($${values.length}::text[])`);
    }
    if (search) {
      values.push(`%${search}%`);
      clauses.push(`(
        title ILIKE $${values.length}
        OR prompt ILIKE $${values.length}
        OR prompt_preview ILIKE $${values.length}
        OR category ILIKE $${values.length}
        OR source_handle ILIKE $${values.length}
      )`);
    }
    values.push(limit, offset);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT
        id, raw_prompt_id, creator_id, source_platform, source_handle, source_url,
        source_tweet_id, title, original_image_url, original_image_urls,
        image_url, image_urls, image_alt, prompt, prompt_preview, category, styles,
        scenes, metadata, approved_by, approved_at, source_published_at,
        count(*) OVER()::int AS total
       FROM approved_prompt_templates
       ${where}
       ORDER BY approved_at DESC, id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    res.json({ ok: true, items: result.rows, total: result.rows[0]?.total || 0, limit, offset });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/approved-prompts/category", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const reviewer = req.user?.username || "unknown";
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
    const category = String(req.body?.category || "").trim();
    if (!ids.length) {
      res.status(400).json({ ok: false, error: "IDS_REQUIRED" });
      return;
    }
    if (!isValidCategory(category)) {
      res.status(400).json({ ok: false, error: "INVALID_CATEGORY" });
      return;
    }
    await client.query("BEGIN");
    const result = await client.query(
      `UPDATE approved_prompt_templates
       SET category = $2,
           metadata = jsonb_set(
             jsonb_set(metadata, '{categoryEditedAt}', to_jsonb(now()::text), true),
             '{categoryEditedBy}',
             to_jsonb($3::text),
             true
           )
       WHERE id = ANY($1::bigint[])
       RETURNING id`,
      [ids, category, reviewer]
    );
    const updatedIds = result.rows.map((row) => row.id);
    const queued = await queueApprovedPromptSyncs(client, updatedIds);
    const queuedEvents = await queuePromptSyncEventsForApprovedIds(client, updatedIds, "category_update", reviewer, {
      reason: "approved_prompt_category_bulk_edit",
      category
    });
    await client.query("COMMIT");
    if (updatedIds.length) {
      autoStartAwesomeSync({ trigger: "approved-category-edit", requestedBy: reviewer });
    }
    res.json({ ok: true, updated: result.rowCount, queued, queuedEvents, ids: updatedIds });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

app.post("/api/approved-prompts/:id/reject", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ ok: false, error: "INVALID_ID" });
      return;
    }
    const reviewer = req.user?.username || "unknown";
    const reason = String(req.body?.reason || "approved_prompt_rejected").slice(0, 500);
    await client.query("BEGIN");
    const approved = await client.query("SELECT * FROM approved_prompt_templates WHERE id = $1 FOR UPDATE", [id]);
    if (!approved.rowCount) {
      await client.query("ROLLBACK");
      res.status(404).json({ ok: false, error: "NOT_FOUND" });
      return;
    }
    const row = approved.rows[0];
    await client.query(
      `UPDATE raw_prompt_templates
       SET review_status = 'rejected',
           reviewed_by = $2,
           reviewed_at = now(),
           reject_reason = $3,
           approved_template_id = NULL,
           metadata = jsonb_set(
             jsonb_set(metadata, '{approvedRejectBy}', to_jsonb($2::text), true),
             '{approvedRejectAt}',
             to_jsonb(now()::text),
             true
           )
       WHERE approved_template_id = $1
          OR id = $4`,
      [id, reviewer, reason, row.raw_prompt_id || 0]
    );
    await queueRejectSyncForApprovedRow(client, row, reviewer, reason);
    await client.query("DELETE FROM approved_prompt_templates WHERE id = $1", [id]);
    await client.query("COMMIT");
    autoStartAwesomeSync({ trigger: "approved-reject", requestedBy: reviewer });
    res.json({ ok: true, id, rawPromptId: row.raw_prompt_id || null });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

app.get("/api/awesome-sync/status", async (_req, res, next) => {
  try {
    res.json(await publicAwesomeSyncStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/awesome-sync/start", async (req, res, next) => {
  try {
    const reviewer = req.user?.username || "unknown";
    const mode = req.body?.mode === "requeue-all" ? "requeue-all" : "pending";
    await startAwesomeSyncRun({ trigger: "manual", mode, requestedBy: reviewer });
    res.json(await publicAwesomeSyncStatus());
  } catch (error) {
    next(error);
  }
});

app.get("/api/scrape/status", async (_req, res, next) => {
  try {
    res.json(await publicScrapeStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/scrape/start", async (_req, res, next) => {
  try {
    await startScrapeRun({ trigger: "manual" });
    res.json(await publicScrapeStatus());
  } catch (error) {
    if (error.statusCode) {
      res.status(error.statusCode).json({ ok: false, error: error.message });
      return;
    }
    next(error);
  }
});

app.get("/api/doingfb/status", async (_req, res, next) => {
  try {
    res.json(await publicDoingfbStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/doingfb/start", async (req, res, next) => {
  try {
    await startDoingfbRun({ maxItems: req.body?.maxItems });
    res.json(await publicDoingfbStatus());
  } catch (error) {
    if (error.statusCode) {
      res.status(error.statusCode).json({ ok: false, error: error.message });
      return;
    }
    next(error);
  }
});

app.post("/api/doingfb/stop", async (_req, res, next) => {
  try {
    if (!isDoingfbActive()) {
      res.status(409).json({ ok: false, error: "DOINGFB_NOT_ACTIVE" });
      return;
    }
    await stopDoingfbRun();
    res.json(await publicDoingfbStatus());
  } catch (error) {
    next(error);
  }
});

app.get("/api/scrape/schedules", (_req, res) => {
  const now = new Date();
  res.json({
    ok: true,
    timeZone: schedulerTimeZone,
    currentDate: todayKey(now),
    currentTime: currentTimeKey(now),
    items: scrapeSchedules
  });
});

app.post("/api/scrape/schedules", async (req, res, next) => {
  try {
    const startTime = normalizeScheduleTime(req.body?.startTime || req.body?.time);
    const endTime = normalizeScheduleTime(req.body?.endTime);
    if (!startTime || !endTime || startTime === endTime) {
      res.status(400).json({ ok: false, error: "INVALID_TIME" });
      return;
    }
    const label = String(req.body?.label || "").trim().slice(0, 80) || `每天 ${startTime}-${endTime}`;
    const schedule = {
      id: createHash("md5").update(`${startTime}|${endTime}|${Date.now()}|${Math.random()}`).digest("hex").slice(0, 12),
      label,
      time: startTime,
      startTime,
      endTime,
      enabled: req.body?.enabled !== false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastRunDate: null,
      lastRunAt: null,
      lastSkipAt: null,
      lastSkipReason: null
    };
    scrapeSchedules.push(schedule);
    sortSchedules();
    await saveSchedules();
    res.json({ ok: true, item: schedule, items: scrapeSchedules });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/scrape/schedules/:id", async (req, res, next) => {
  try {
    const schedule = scrapeSchedules.find((item) => item.id === req.params.id);
    if (!schedule) {
      res.status(404).json({ ok: false, error: "SCHEDULE_NOT_FOUND" });
      return;
    }
    if (req.body?.time !== undefined || req.body?.startTime !== undefined || req.body?.endTime !== undefined) {
      const startTime = normalizeScheduleTime(req.body?.startTime ?? req.body?.time ?? schedule.startTime ?? schedule.time);
      const endTime = normalizeScheduleTime(req.body?.endTime ?? schedule.endTime);
      if (!startTime || !endTime || startTime === endTime) {
        res.status(400).json({ ok: false, error: "INVALID_TIME" });
        return;
      }
      schedule.time = startTime;
      schedule.startTime = startTime;
      schedule.endTime = endTime;
      schedule.lastRunDate = null;
    }
    if (req.body?.label !== undefined) {
      schedule.label = String(req.body.label || "").trim().slice(0, 80) || `每天 ${schedule.startTime || schedule.time}-${schedule.endTime}`;
    }
    if (req.body?.enabled !== undefined) schedule.enabled = Boolean(req.body.enabled);
    schedule.updatedAt = new Date().toISOString();
    sortSchedules();
    await saveSchedules();
    res.json({ ok: true, item: schedule, items: scrapeSchedules });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/scrape/schedules/:id", async (req, res, next) => {
  try {
    const before = scrapeSchedules.length;
    scrapeSchedules = scrapeSchedules.filter((item) => item.id !== req.params.id);
    if (scrapeSchedules.length === before) {
      res.status(404).json({ ok: false, error: "SCHEDULE_NOT_FOUND" });
      return;
    }
    await saveSchedules();
    res.json({ ok: true, items: scrapeSchedules });
  } catch (error) {
    next(error);
  }
});

app.get("/api/scrape/history", (_req, res) => {
  res.json({ ok: true, items: scrapeHistory.slice(0, 40) });
});

app.post("/api/scrape/pause", async (_req, res, next) => {
  try {
    if (scrapeRun.status !== "running") {
      res.status(409).json({ ok: false, error: "SCRAPE_NOT_RUNNING" });
      return;
    }
    const tasks = Object.values(scrapeRun.tasks).filter((task) => task._child && task.status === "running");
    await Promise.all(tasks.map((task) => controlProcessTree(task.pid, "pause")));
    for (const task of tasks) task.status = "paused";
    scrapeRun.status = "paused";
    addScrapeLog("采集任务已暂停");
    res.json(await publicScrapeStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/scrape/resume", async (_req, res, next) => {
  try {
    if (scrapeRun.status !== "paused") {
      res.status(409).json({ ok: false, error: "SCRAPE_NOT_PAUSED" });
      return;
    }
    const tasks = Object.values(scrapeRun.tasks).filter((task) => task._child && task.status === "paused");
    await Promise.all(tasks.map((task) => controlProcessTree(task.pid, "resume")));
    for (const task of tasks) task.status = "running";
    scrapeRun.status = "running";
    addScrapeLog("采集任务已继续");
    res.json(await publicScrapeStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/scrape/stop", async (_req, res, next) => {
  try {
    if (!isScrapeActive()) {
      res.status(409).json({ ok: false, error: "SCRAPE_NOT_ACTIVE" });
      return;
    }
    await stopScrapeRun("正在停止采集任务");
    res.json(await publicScrapeStatus());
  } catch (error) {
    next(error);
  }
});

app.post("/api/translate", async (req, res, next) => {
  try {
    const text = String(req.body?.text || "").trim();
    if (!text) {
      res.status(400).json({ ok: false, error: "TEXT_REQUIRED" });
      return;
    }
    if (text.length > 20000) {
      res.status(400).json({ ok: false, error: "TEXT_TOO_LONG" });
      return;
    }

    const chunks = splitTextForTranslate(text);
    const translated = [];
    for (const chunk of chunks) {
      translated.push(await translateTextChunk(chunk));
    }
    res.json({ ok: true, translation: translated.join("") });
  } catch (error) {
    console.error("Translate failed:", error);
    res.status(502).json({ ok: false, error: "TRANSLATE_UNAVAILABLE" });
  }
});

app.get("/api/raw-prompts", async (req, res, next) => {
  try {
    const status = String(req.query.status || "pending");
    const search = String(req.query.search || "").trim();
    const limit = cleanLimit(req.query.limit);
    const offset = cleanOffset(req.query.offset);
    const values = [];
    const clauses = [];

    if (status !== "all") {
      values.push(status);
      clauses.push(`review_status = $${values.length}`);
    }
    if (search) {
      values.push(`%${search}%`);
      clauses.push(`(
        title ILIKE $${values.length}
        OR prompt ILIKE $${values.length}
        OR prompt_preview ILIKE $${values.length}
        OR category ILIKE $${values.length}
        OR source_handle ILIKE $${values.length}
      )`);
    }

    values.push(limit, offset);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const result = await pool.query(
      `SELECT
        id, source_handle, source_url, source_tweet_id, title, original_image_url, original_image_urls,
        image_url, image_urls, image_alt,
        prompt, prompt_preview, category, styles, scenes, review_status, reviewed_by,
        reviewed_at, reject_reason, approved_template_id, prompt_hash, scraped_at,
        count(*) OVER()::int AS total
       FROM raw_prompt_templates
       ${where}
       ORDER BY scraped_at DESC, id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    res.json({
      items: result.rows,
      total: result.rows[0]?.total || 0,
      limit,
      offset
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/raw-prompts/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ ok: false, error: "INVALID_ID" });
      return;
    }

    const prompt = cleanPromptText(req.body?.prompt || "");
    if (!prompt) {
      res.status(400).json({ ok: false, error: "PROMPT_REQUIRED" });
      return;
    }
    if (looksEncodingDamaged(prompt)) {
      res.status(400).json({ ok: false, error: "PROMPT_ENCODING_SUSPECT" });
      return;
    }

    const result = await pool.query(
      `UPDATE raw_prompt_templates
       SET prompt = $2,
           prompt_preview = $3,
           metadata = jsonb_set(
             jsonb_set(metadata, '{editedPrompt}', to_jsonb($2::text), true),
             '{editedAt}',
             to_jsonb(now()::text),
             true
           )
       WHERE id = $1
       RETURNING id, prompt, prompt_preview, prompt_hash`,
      [id, prompt, previewFromPrompt(prompt)]
    );

    if (!result.rowCount) {
      res.status(404).json({ ok: false, error: "NOT_FOUND" });
      return;
    }

    res.json({ ok: true, item: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

app.post("/api/raw-prompts/auto-review", async (req, res, next) => {
  try {
    const reviewer = req.user?.username || "unknown";
    const summary = await autoReviewPendingPrompts({
      reviewer: `auto:${reviewer}`,
      limit: req.body?.limit || 100,
      search: req.body?.search || "",
      sourcePlatform: req.body?.sourcePlatform || "",
      order: "latest"
    });
    if ((summary.approved || 0) + (summary.duplicate || 0) > 0) {
      autoStartAwesomeSync({ trigger: "manual-auto-review", requestedBy: reviewer });
    }
    res.json({ ok: true, ...summary });
  } catch (error) {
    next(error);
  }
});

app.post("/api/raw-prompts/:id/approve", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ ok: false, error: "INVALID_ID" });
      return;
    }
    const reviewer = req.user?.username || "unknown";

    await client.query("BEGIN");
    const raw = await client.query("SELECT * FROM raw_prompt_templates WHERE id = $1 FOR UPDATE", [id]);
    if (!raw.rowCount) {
      await client.query("ROLLBACK");
      res.status(404).json({ ok: false, error: "NOT_FOUND" });
      return;
    }
    const cleanedPrompt = cleanPromptText(raw.rows[0].prompt);
    if (!cleanedPrompt || looksEncodingDamaged(cleanedPrompt)) {
      await client.query("ROLLBACK");
      res.status(400).json({ ok: false, error: "PROMPT_QUALITY_FAILED" });
      return;
    }
    const safety = safetyGate(raw.rows[0].prompt, cleanedPrompt);
    if (safety.blocked) {
      await client.query(
        `UPDATE raw_prompt_templates
         SET prompt = $2,
             prompt_preview = $3,
             review_status = 'rejected',
             reviewed_by = $4,
             reviewed_at = now(),
             reject_reason = $5,
             approved_template_id = NULL,
             metadata = jsonb_set(
               metadata,
               '{safetyReview}',
               $6::jsonb,
               true
             )
         WHERE id = $1`,
        [
          id,
          cleanedPrompt,
          previewFromPrompt(cleanedPrompt),
          reviewer,
          safety.reasons.join(", ").slice(0, 500),
          JSON.stringify({
            blocked: true,
            categories: safety.categories,
            reasons: safety.reasons,
            reviewer,
            reviewedAt: new Date().toISOString(),
            source: "manual_approve_gate",
            version: 1
          })
        ]
      );
      await client.query("COMMIT");
      res.status(422).json({ ok: false, error: "PROMPT_SAFETY_BLOCKED", categories: safety.categories });
      return;
    }
    if (cleanedPrompt !== raw.rows[0].prompt) {
      await client.query(
        `UPDATE raw_prompt_templates
         SET prompt = $2,
             prompt_preview = $3,
             metadata = jsonb_set(
               jsonb_set(metadata, '{cleanedPromptBy}', to_jsonb($4::text), true),
               '{cleanedPromptAt}',
               to_jsonb(now()::text),
               true
             )
         WHERE id = $1`,
        [id, cleanedPrompt, previewFromPrompt(cleanedPrompt), reviewer]
      );
    }

    const { approvedId, duplicate } = await approveRawPromptWithClient(client, id, reviewer);
    await client.query("COMMIT");
    if (approvedId) {
      autoStartAwesomeSync({ trigger: "manual-approve", requestedBy: reviewer });
    }
    res.json({ ok: true, approvedTemplateId: approvedId, duplicate });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

app.post("/api/raw-prompts/:id/reject", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ ok: false, error: "INVALID_ID" });
      return;
    }
    const reviewer = req.user?.username || "unknown";
    const reason = String(req.body?.reason || "").slice(0, 500);
    await client.query("BEGIN");
    const raw = await client.query("SELECT * FROM raw_prompt_templates WHERE id = $1 FOR UPDATE", [id]);
    if (!raw.rowCount) {
      await client.query("ROLLBACK");
      res.status(404).json({ ok: false, error: "NOT_FOUND" });
      return;
    }
    const approvedTemplateId = raw.rows[0].approved_template_id;
    if (approvedTemplateId) {
      const approved = await client.query("SELECT * FROM approved_prompt_templates WHERE id = $1 FOR UPDATE", [approvedTemplateId]);
      if (approved.rowCount && String(approved.rows[0].raw_prompt_id || "") === String(id)) {
        await queueRejectSyncForApprovedRow(
          client,
          approved.rows[0],
          reviewer,
          reason || "raw_prompt_rejected"
        );
        await client.query("DELETE FROM approved_prompt_templates WHERE id = $1", [approvedTemplateId]);
      }
    }
    const result = await client.query(
      `UPDATE raw_prompt_templates
       SET review_status = 'rejected',
           reviewed_by = $2,
           reviewed_at = now(),
           reject_reason = $3,
           approved_template_id = NULL
       WHERE id = $1
       RETURNING id`,
      [id, reviewer, reason || null]
    );
    await client.query("COMMIT");
    if (approvedTemplateId) {
      autoStartAwesomeSync({ trigger: "raw-reject", requestedBy: reviewer });
    }
    res.json({ ok: result.rowCount === 1 });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

app.post("/api/raw-prompts/:id/pending", async (req, res, next) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      res.status(400).json({ ok: false, error: "INVALID_ID" });
      return;
    }
    const reviewer = req.user?.username || "unknown";
    await client.query("BEGIN");
    const raw = await client.query("SELECT * FROM raw_prompt_templates WHERE id = $1 FOR UPDATE", [id]);
    if (!raw.rowCount) {
      await client.query("ROLLBACK");
      res.status(404).json({ ok: false, error: "NOT_FOUND" });
      return;
    }
    const approvedTemplateId = raw.rows[0].approved_template_id;
    if (approvedTemplateId) {
      const approved = await client.query("SELECT * FROM approved_prompt_templates WHERE id = $1 FOR UPDATE", [approvedTemplateId]);
      if (approved.rowCount && String(approved.rows[0].raw_prompt_id || "") === String(id)) {
        await queueRejectSyncForApprovedRow(client, approved.rows[0], reviewer, "raw_prompt_returned_to_pending");
        await client.query("DELETE FROM approved_prompt_templates WHERE id = $1", [approvedTemplateId]);
      }
    }
    const result = await client.query(
      `UPDATE raw_prompt_templates
       SET review_status = 'pending',
           reviewed_by = NULL,
           reviewed_at = NULL,
           reject_reason = NULL,
           approved_template_id = NULL
       WHERE id = $1
       RETURNING id`,
      [id]
    );
    await client.query("COMMIT");
    if (approvedTemplateId) {
      autoStartAwesomeSync({ trigger: "raw-return-pending", requestedBy: reviewer });
    }
    res.json({ ok: result.rowCount === 1 });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ ok: false, error: "SERVER_ERROR" });
});

await ensureAuthTables();
await loadSchedulerState();
startScheduler();

app.listen(port, () => {
  console.log(`Prompt review app running at http://localhost:${port}`);
});
