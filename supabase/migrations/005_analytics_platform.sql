-- Analytics platform foundation — normalized per-prompt/per-citation schema,
-- daily rollups, scan scheduling, and topics (plan: docs/plans/plan.md §4 P0.1).
-- Safe to re-run: uses IF NOT EXISTS / idempotent column adds + guarded policies.

-- One row per prompt × engine per scan.
-- brand columns EVERYWHERE store resolveBrandKey() output (domain-first key),
-- never the typed display name — display name lives on scans/scan_jobs (D7).
CREATE TABLE IF NOT EXISTS prompt_results (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id uuid NOT NULL,                -- scan_jobs.id — chunks write against this
  scan_id uuid REFERENCES scans(id) ON DELETE CASCADE,  -- stamped at finalize (D3)
  brand text NOT NULL,                 -- resolveBrandKey() output, not display name
  prompt_id uuid,
  query text NOT NULL,
  engine text NOT NULL,                -- aio | chatgpt | perplexity
  answered boolean,
  mentioned boolean,
  brand_cited boolean,
  position numeric,                    -- in-answer position (defined in P1.1); null if unlisted
  sentiment int,                       -- 0-100 (mapping defined in P1.1); null when not mentioned
  intent text,
  is_branded_query boolean DEFAULT false,
  answer_text text,
  raw jsonb,                           -- engine extras (organic rank, refs, errors)
  created_at timestamptz DEFAULT now(),
  UNIQUE (job_id, engine, query)       -- chunk idempotency: re-runs upsert, never duplicate (D5)
);
CREATE INDEX IF NOT EXISTS prompt_results_brand_idx ON prompt_results (brand, created_at);
CREATE INDEX IF NOT EXISTS prompt_results_scan_idx ON prompt_results (scan_id);

-- Per-answer brand mentions: you AND every tracked rival (symmetric scoring)
CREATE TABLE IF NOT EXISTS result_brands (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  result_id uuid REFERENCES prompt_results(id) ON DELETE CASCADE,
  scan_id uuid,
  brand text NOT NULL,                 -- tenant key (resolveBrandKey), not display name
  name text NOT NULL,                  -- the mentioned brand (display)
  is_self boolean DEFAULT false,
  mentioned boolean,
  position numeric,
  sentiment int
);
CREATE INDEX IF NOT EXISTS result_brands_scan_idx ON result_brands (scan_id, name);

-- One row per cited URL per result
CREATE TABLE IF NOT EXISTS citations (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  result_id uuid REFERENCES prompt_results(id) ON DELETE CASCADE,
  job_id uuid,
  scan_id uuid,
  brand text NOT NULL,                 -- resolveBrandKey() output, not display name
  engine text,
  url text NOT NULL,
  domain text NOT NULL,
  rank int,                            -- order in the engine's reference list
  content_type text,                   -- listicle|comparison|product|social|forum|article|homepage|category|alternative|other
  domain_type text,                    -- editorial|corporate|reference|competitor|ugc|social|institutional|owned
  citation_class text,                 -- earned|owned|social
  is_self boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS citations_brand_domain_idx ON citations (brand, domain);
CREATE INDEX IF NOT EXISTS citations_scan_idx ON citations (scan_id);

-- Daily rollups powering every trend chart
CREATE TABLE IF NOT EXISTS brand_metrics_daily (
  brand text NOT NULL,                 -- resolveBrandKey() output, not display name
  date date NOT NULL,
  engine text NOT NULL DEFAULT 'all',
  visibility_pct numeric,
  sov_pct numeric,
  sentiment_avg numeric,
  position_avg numeric,
  citation_share_pct numeric,
  prompts_total int,
  prompts_answered int,
  prompts_mentioned int,
  scan_id uuid,
  prompt_set_id text,                  -- contract-mandated "prompt list changed" marker (D14)
  PRIMARY KEY (brand, date, engine)
);

-- Recurring cadence + per-brand prompt target (replaces global PROMPT_TARGET slice, D10)
CREATE TABLE IF NOT EXISTS scan_schedules (
  brand text PRIMARY KEY,              -- resolveBrandKey() output, not display name
  display_name text,
  cadence text NOT NULL DEFAULT '72h', -- 72h | daily | weekly | off
  enabled boolean DEFAULT true,
  engines text,
  geo text DEFAULT 'in',
  prompt_target int DEFAULT 30,        -- raised on suggested-prompt approval (additive tiers)
  last_run_at timestamptz,
  next_run_at timestamptz,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS topics (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand text NOT NULL,                 -- resolveBrandKey() output, not display name
  name text NOT NULL,
  UNIQUE (brand, name)
);

ALTER TABLE brand_prompts ADD COLUMN IF NOT EXISTS topic_id uuid;
ALTER TABLE brand_prompts ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';  -- active|suggested|archived
ALTER TABLE brand_prompts ADD COLUMN IF NOT EXISTS search_volume_band int;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS checkpoint jsonb;
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;          -- rescue staleness (D8)
-- content_jobs also gets a heartbeat: P0.0's db/content.js writes heartbeat_at on
-- every create/update. Without this column every content create/update throws
-- "column does not exist" and the whole Agent Content OS 500s on a real DB
-- (reviewer D1 — the P0.0 code and this migration were authored by separate agents).
ALTER TABLE content_jobs ADD COLUMN IF NOT EXISTS heartbeat_at timestamptz;

-- Rescue (heartbeat staleness scan) + scheduler tick (next_run_at) hot paths (reviewer D8).
CREATE INDEX IF NOT EXISTS scan_jobs_heartbeat_idx ON scan_jobs (heartbeat_at);
CREATE INDEX IF NOT EXISTS scan_schedules_next_run_idx ON scan_schedules (next_run_at) WHERE enabled;

-- RLS: house style until auth lands — every new table gets ENABLE ROW LEVEL
-- SECURITY + an "Allow anon all" policy, matching 001:107-138 / 004 (D6).
ALTER TABLE prompt_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE result_brands ENABLE ROW LEVEL SECURITY;
ALTER TABLE citations ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_metrics_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE topics ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'prompt_results' AND policyname = 'Allow anon all on prompt_results'
  ) THEN
    CREATE POLICY "Allow anon all on prompt_results" ON prompt_results FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'result_brands' AND policyname = 'Allow anon all on result_brands'
  ) THEN
    CREATE POLICY "Allow anon all on result_brands" ON result_brands FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'citations' AND policyname = 'Allow anon all on citations'
  ) THEN
    CREATE POLICY "Allow anon all on citations" ON citations FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'brand_metrics_daily' AND policyname = 'Allow anon all on brand_metrics_daily'
  ) THEN
    CREATE POLICY "Allow anon all on brand_metrics_daily" ON brand_metrics_daily FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'scan_schedules' AND policyname = 'Allow anon all on scan_schedules'
  ) THEN
    CREATE POLICY "Allow anon all on scan_schedules" ON scan_schedules FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'topics' AND policyname = 'Allow anon all on topics'
  ) THEN
    CREATE POLICY "Allow anon all on topics" ON topics FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;
