-- AEO Visibility Tracker — initial Supabase schema
-- Safe to re-run: uses IF NOT EXISTS

-- 1. Scans Table (core results)
CREATE TABLE IF NOT EXISTS scans (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  brand text NOT NULL,
  url text,
  industry text,
  platform text,
  visibility_pct numeric,
  prompts_tracked integer,
  prompts_mentioned integer,
  competitors jsonb,
  scanned_at timestamptz,
  used_dynamic_prompts boolean,
  raw_results jsonb,
  competitors_raw text,
  scoring_version text,
  score_ci_low numeric,
  score_ci_high numeric,
  stability text,
  mention_rate_pct numeric
);

-- 2. Brand Prompts Table (persistent prompt caching)
CREATE TABLE IF NOT EXISTS brand_prompts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand text NOT NULL,
  text text NOT NULL,
  intent_tier text NOT NULL,
  topic text,
  weight numeric DEFAULT 1.0,
  enabled boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'brand_prompts_brand_text_idx'
  ) THEN
    ALTER TABLE brand_prompts
      ADD CONSTRAINT brand_prompts_brand_text_idx UNIQUE (brand, text);
  END IF;
END $$;

-- 3. Scan Jobs Table (async pipeline tracking)
CREATE TABLE IF NOT EXISTS scan_jobs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand text NOT NULL,
  url text,
  industry text,
  competitors text,
  status text NOT NULL,
  progress_pct integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  result_id uuid REFERENCES scans(id) ON DELETE SET NULL,
  error_message text,
  run_record jsonb
);

-- Enable RLS and allow anon access (matches client-side Supabase usage)
ALTER TABLE scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE scan_jobs ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'scans' AND policyname = 'Allow anon all on scans'
  ) THEN
    CREATE POLICY "Allow anon all on scans" ON scans FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'brand_prompts' AND policyname = 'Allow anon all on brand_prompts'
  ) THEN
    CREATE POLICY "Allow anon all on brand_prompts" ON brand_prompts FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'scan_jobs' AND policyname = 'Allow anon all on scan_jobs'
  ) THEN
    CREATE POLICY "Allow anon all on scan_jobs" ON scan_jobs FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;