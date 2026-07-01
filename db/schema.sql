CREATE TABLE IF NOT EXISTS twitter_creators (
  id BIGSERIAL PRIMARY KEY,
  handle TEXT NOT NULL,
  handle_normalized TEXT GENERATED ALWAYS AS (lower(trim(leading '@' from handle))) STORED,
  profile_url TEXT NOT NULL,
  display_name TEXT,
  bio TEXT,
  avatar_url TEXT,
  source_case_count INTEGER NOT NULL DEFAULT 0,
  status_link_count INTEGER NOT NULL DEFAULT 0,
  latest_case_id INTEGER,
  latest_case_title TEXT,
  sample_case_ids INTEGER[] NOT NULL DEFAULT '{}',
  monitor_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  discovery_source TEXT,
  discovery_query TEXT,
  discovery_score INTEGER NOT NULL DEFAULT 0,
  discovery_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_discovered_at TIMESTAMPTZ,
  last_discovered_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  last_scraped_at TIMESTAMPTZ,
  last_scrape_status TEXT,
  last_scrape_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (handle_normalized)
);

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

CREATE TABLE IF NOT EXISTS raw_prompt_templates (
  id BIGSERIAL PRIMARY KEY,
  creator_id BIGINT REFERENCES twitter_creators(id) ON DELETE SET NULL,
  source_platform TEXT NOT NULL DEFAULT 'x',
  source_handle TEXT NOT NULL,
  source_url TEXT,
  source_tweet_id TEXT,
  external_case_id TEXT UNIQUE,
  title TEXT,
  original_image_url TEXT,
  original_image_urls TEXT[] NOT NULL DEFAULT '{}',
  image_url TEXT,
  image_urls TEXT[] NOT NULL DEFAULT '{}',
  image_alt TEXT,
  prompt TEXT NOT NULL,
  prompt_preview TEXT NOT NULL,
  category TEXT NOT NULL,
  styles TEXT[] NOT NULL DEFAULT '{}',
  scenes TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_published_at TIMESTAMPTZ,
  scraped_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  review_status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at TIMESTAMPTZ,
  reject_reason TEXT,
  approved_template_id BIGINT,
  prompt_hash TEXT GENERATED ALWAYS AS (md5(coalesce(prompt, ''))) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT raw_prompt_templates_review_status_check
    CHECK (review_status IN ('pending', 'approved', 'rejected', 'duplicate'))
);

CREATE TABLE IF NOT EXISTS approved_prompt_templates (
  id BIGSERIAL PRIMARY KEY,
  raw_prompt_id BIGINT REFERENCES raw_prompt_templates(id) ON DELETE SET NULL,
  creator_id BIGINT REFERENCES twitter_creators(id) ON DELETE SET NULL,
  source_platform TEXT NOT NULL DEFAULT 'x',
  source_handle TEXT NOT NULL,
  source_url TEXT,
  source_tweet_id TEXT,
  title TEXT,
  original_image_url TEXT,
  original_image_urls TEXT[] NOT NULL DEFAULT '{}',
  image_url TEXT,
  image_urls TEXT[] NOT NULL DEFAULT '{}',
  image_alt TEXT,
  prompt TEXT NOT NULL,
  prompt_preview TEXT NOT NULL,
  category TEXT NOT NULL,
  styles TEXT[] NOT NULL DEFAULT '{}',
  scenes TEXT[] NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_published_at TIMESTAMPTZ,
  approved_by TEXT,
  approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  prompt_hash TEXT GENERATED ALWAYS AS (md5(coalesce(prompt, ''))) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (prompt_hash)
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
  processed_at TIMESTAMPTZ,
  CONSTRAINT prompt_category_sync_events_type_check
    CHECK (event_type IN ('create', 'rename', 'update')),
  CONSTRAINT prompt_category_sync_events_status_check
    CHECK (sync_status IN ('pending', 'synced', 'failed', 'skipped'))
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
  UNIQUE (target_system, target_prompt_id),
  CONSTRAINT approved_prompt_syncs_status_check
    CHECK (sync_status IN ('pending', 'synced', 'failed', 'skipped'))
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
  processed_at TIMESTAMPTZ,
  CONSTRAINT prompt_sync_events_type_check
    CHECK (event_type IN ('upsert', 'category_update', 'reject', 'delete')),
  CONSTRAINT prompt_sync_events_status_check
    CHECK (sync_status IN ('pending', 'synced', 'failed', 'skipped'))
);

ALTER TABLE twitter_creators
  ADD COLUMN IF NOT EXISTS discovery_source TEXT,
  ADD COLUMN IF NOT EXISTS discovery_query TEXT,
  ADD COLUMN IF NOT EXISTS discovery_score INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discovery_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS first_discovered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_discovered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_scraped_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_scrape_status TEXT,
  ADD COLUMN IF NOT EXISTS last_scrape_error TEXT;

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

ALTER TABLE raw_prompt_templates
  ADD COLUMN IF NOT EXISTS source_published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS original_image_url TEXT,
  ADD COLUMN IF NOT EXISTS original_image_urls TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS image_urls TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE approved_prompt_templates
  ADD COLUMN IF NOT EXISTS source_published_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS original_image_url TEXT,
  ADD COLUMN IF NOT EXISTS original_image_urls TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS image_urls TEXT[] NOT NULL DEFAULT '{}';

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

DO $$
BEGIN
  ALTER TABLE prompt_categories
    ADD CONSTRAINT prompt_categories_sync_status_check
    CHECK (sync_status IN ('pending', 'synced', 'failed', 'skipped'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

UPDATE raw_prompt_templates
SET original_image_url = image_url
WHERE original_image_url IS NULL
  AND image_url IS NOT NULL
  AND image_url <> '';

UPDATE raw_prompt_templates
SET original_image_urls = image_urls
WHERE cardinality(original_image_urls) = 0
  AND cardinality(image_urls) > 0;

UPDATE approved_prompt_templates
SET original_image_url = image_url
WHERE original_image_url IS NULL
  AND image_url IS NOT NULL
  AND image_url <> '';

UPDATE approved_prompt_templates
SET original_image_urls = image_urls
WHERE cardinality(original_image_urls) = 0
  AND cardinality(image_urls) > 0;

UPDATE raw_prompt_templates
SET image_urls = ARRAY[image_url]
WHERE image_url IS NOT NULL
  AND image_url <> ''
  AND cardinality(image_urls) = 0;

UPDATE approved_prompt_templates
SET image_urls = ARRAY[image_url]
WHERE image_url IS NOT NULL
  AND image_url <> ''
  AND cardinality(image_urls) = 0;

CREATE INDEX IF NOT EXISTS idx_raw_prompt_templates_status
  ON raw_prompt_templates(review_status, scraped_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_raw_prompt_templates_creator
  ON raw_prompt_templates(creator_id);

CREATE INDEX IF NOT EXISTS idx_raw_prompt_templates_source_tweet
  ON raw_prompt_templates(source_tweet_id);

DROP INDEX IF EXISTS idx_raw_prompt_templates_source_tweet_unique;
DROP INDEX IF EXISTS idx_raw_prompt_templates_source_url_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_prompt_templates_source_tweet_prompt_unique
  ON raw_prompt_templates(source_platform, source_tweet_id, prompt_hash)
  WHERE source_tweet_id IS NOT NULL AND source_tweet_id <> '';

CREATE INDEX IF NOT EXISTS idx_approved_prompt_templates_category
  ON approved_prompt_templates(category);

CREATE INDEX IF NOT EXISTS idx_app_sessions_expires_at
  ON app_sessions(expires_at);

CREATE INDEX IF NOT EXISTS idx_prompt_categories_sort_order
  ON prompt_categories(sort_order, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_categories_sync_key
  ON prompt_categories(sync_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_categories_slug
  ON prompt_categories(slug);

CREATE INDEX IF NOT EXISTS idx_prompt_categories_sync_status
  ON prompt_categories(sync_status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_prompt_category_sync_events_status
  ON prompt_category_sync_events(target_system, sync_status, created_at);

CREATE INDEX IF NOT EXISTS idx_approved_prompt_syncs_status
  ON approved_prompt_syncs(target_system, sync_status, updated_at);

CREATE INDEX IF NOT EXISTS idx_prompt_sync_events_status
  ON prompt_sync_events(target_system, sync_status, created_at, id);

CREATE INDEX IF NOT EXISTS idx_prompt_sync_events_target_prompt
  ON prompt_sync_events(target_system, target_prompt_id);

DROP INDEX IF EXISTS idx_approved_prompt_templates_source_url_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_approved_prompt_templates_source_url_prompt_unique
  ON approved_prompt_templates(source_url, prompt_hash)
  WHERE source_url IS NOT NULL AND source_url <> '';

INSERT INTO approved_prompt_syncs (approved_prompt_id, target_system, target_prompt_id, target_slug)
SELECT id, 'awesome-image2-web', 'iac_prompt_' || id::text, 'image-auto-' || id::text
FROM approved_prompt_templates
ON CONFLICT (approved_prompt_id, target_system) DO NOTHING;

INSERT INTO prompt_sync_events
  (target_system, event_type, approved_prompt_id, raw_prompt_id, target_prompt_id, target_slug, snapshot, event_key, created_by)
SELECT
  'awesome-image2-web',
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
  'awesome-image2-web:bootstrap:approved:' || approved.id::text,
  'system'
FROM approved_prompt_templates approved
LEFT JOIN approved_prompt_syncs sync
  ON sync.approved_prompt_id = approved.id
 AND sync.target_system = 'awesome-image2-web'
ON CONFLICT (event_key) DO NOTHING;

CREATE OR REPLACE VIEW awesome_image2_prompt_export AS
SELECT
  approved.id AS approved_prompt_id,
  approved.raw_prompt_id,
  COALESCE(sync.target_prompt_id, 'iac_prompt_' || approved.id::text) AS target_prompt_id,
  COALESCE(sync.target_slug, 'image-auto-' || approved.id::text) AS target_slug,
  COALESCE(NULLIF(approved.title, ''), NULLIF(approved.prompt_preview, ''), 'Prompt ' || approved.id::text) AS title,
  COALESCE(NULLIF(approved.prompt_preview, ''), COALESCE(NULLIF(approved.title, ''), 'Prompt ' || approved.id::text)) AS description,
  approved.prompt AS positive_prompt,
  NULLIF(approved.metadata ->> 'negativePrompt', '') AS negative_prompt,
  COALESCE(category.target_category_name, approved.category) AS category,
  ARRAY(
    SELECT DISTINCT tag
    FROM unnest(COALESCE(approved.styles, '{}'::text[]) || COALESCE(approved.scenes, '{}'::text[])) AS tag
    WHERE tag IS NOT NULL AND tag <> ''
  ) AS tags,
  COALESCE(NULLIF(approved.metadata ->> 'model', ''), 'gpt-image-2') AS model,
  COALESCE(NULLIF(approved.metadata ->> 'ratio', ''), 'auto') AS ratio,
  NULLIF(approved.metadata ->> 'quality', '') AS quality,
  10::integer AS cost_credits,
  CASE
    WHEN cardinality(approved.image_urls) > 0 THEN approved.image_urls
    WHEN approved.image_url IS NOT NULL AND approved.image_url <> '' THEN ARRAY[approved.image_url]
    ELSE '{}'::text[]
  END AS image_urls,
  approved.source_platform,
  approved.source_handle,
  approved.source_url,
  approved.approved_by,
  approved.approved_at,
  sync.sync_status,
  sync.last_synced_at
FROM approved_prompt_templates approved
LEFT JOIN LATERAL (
  SELECT target_category_name
  FROM prompt_categories
  WHERE name = approved.category OR approved.category = ANY(aliases)
  ORDER BY CASE WHEN name = approved.category THEN 0 ELSE 1 END, sort_order, id
  LIMIT 1
) category ON true
LEFT JOIN approved_prompt_syncs sync
  ON sync.approved_prompt_id = approved.id
 AND sync.target_system = 'awesome-image2-web';

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_twitter_creators_updated_at ON twitter_creators;
CREATE TRIGGER set_twitter_creators_updated_at
BEFORE UPDATE ON twitter_creators
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_raw_prompt_templates_updated_at ON raw_prompt_templates;
CREATE TRIGGER set_raw_prompt_templates_updated_at
BEFORE UPDATE ON raw_prompt_templates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_approved_prompt_templates_updated_at ON approved_prompt_templates;
CREATE TRIGGER set_approved_prompt_templates_updated_at
BEFORE UPDATE ON approved_prompt_templates
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS set_approved_prompt_syncs_updated_at ON approved_prompt_syncs;
CREATE TRIGGER set_approved_prompt_syncs_updated_at
BEFORE UPDATE ON approved_prompt_syncs
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
