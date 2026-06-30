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
  aliases TEXT[] NOT NULL DEFAULT '{}',
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

DROP INDEX IF EXISTS idx_approved_prompt_templates_source_url_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_approved_prompt_templates_source_url_prompt_unique
  ON approved_prompt_templates(source_url, prompt_hash)
  WHERE source_url IS NOT NULL AND source_url <> '';

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
