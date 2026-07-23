-- Agent Content OS — schema (plan: docs/plans/2026-07-23-agent-content-os.md)
-- Safe to re-run: uses IF NOT EXISTS

-- 1. Pipeline jobs (mirrors scan_jobs)
CREATE TABLE IF NOT EXISTS content_jobs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand text NOT NULL,
  playbook text NOT NULL,             -- 'geo_article' | 'linkedin_post'
  status text NOT NULL,               -- pending|coordinating|researching|benchmarking|drafting|reviewing|awaiting_approval|approved|rejected|failed
  progress_pct integer DEFAULT 0,
  input jsonb,                        -- gap row / topic / brand profile
  item_id uuid,                       -- FK set once the item exists
  error_message text,
  cost_total numeric DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- 2. The content itself, with full provenance
CREATE TABLE IF NOT EXISTS content_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  job_id uuid REFERENCES content_jobs(id) ON DELETE SET NULL,
  brand text NOT NULL,
  playbook text NOT NULL,
  title text,
  body_md text,                       -- current draft (markdown)
  research_pack jsonb,                -- sources, stats, quotes, angles
  benchmark_notes jsonb,              -- what wins in this category/channel
  rubric jsonb,                       -- reviewer scores + verdict + violations
  revision integer DEFAULT 0,
  revisions jsonb DEFAULT '[]',       -- prior drafts + critiques
  target_queries jsonb,               -- geo_article: queries this aims to win
  status text DEFAULT 'draft',        -- draft|awaiting_approval|approved|changes_requested|rejected
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 3. Human feedback events (the raw signal)
CREATE TABLE IF NOT EXISTS content_feedback (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  item_id uuid REFERENCES content_items(id) ON DELETE CASCADE,
  brand text NOT NULL,
  verdict text NOT NULL,              -- approved|changes_requested|rejected
  comment text,
  created_at timestamptz DEFAULT now()
);

-- 4. Brand briefs (the write-once context every step inherits)
CREATE TABLE IF NOT EXISTS brand_briefs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand text NOT NULL UNIQUE,
  brief jsonb NOT NULL,               -- one_liner, vertical, personas, priority_topics, money_pages, competitors, tone_rules, platforms, win_definition
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- 5. Distilled lessons (the self-learning store)
CREATE TABLE IF NOT EXISTS content_lessons (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand text NOT NULL,
  playbook text NOT NULL,
  lesson text NOT NULL,               -- one imperative rule, <200 chars
  source_feedback_id uuid REFERENCES content_feedback(id) ON DELETE SET NULL,
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

-- Content jobs FK to items (set after both tables exist; item_id declared plain
-- above so re-runs on a partial schema don't fail on ordering)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'content_jobs_item_id_fkey'
  ) THEN
    ALTER TABLE content_jobs
      ADD CONSTRAINT content_jobs_item_id_fkey
      FOREIGN KEY (item_id) REFERENCES content_items(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Enable RLS and allow anon access (same single-operator model as 001)
ALTER TABLE content_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_lessons ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'content_jobs' AND policyname = 'Allow anon all on content_jobs'
  ) THEN
    CREATE POLICY "Allow anon all on content_jobs" ON content_jobs FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'content_items' AND policyname = 'Allow anon all on content_items'
  ) THEN
    CREATE POLICY "Allow anon all on content_items" ON content_items FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'content_feedback' AND policyname = 'Allow anon all on content_feedback'
  ) THEN
    CREATE POLICY "Allow anon all on content_feedback" ON content_feedback FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'brand_briefs' AND policyname = 'Allow anon all on brand_briefs'
  ) THEN
    CREATE POLICY "Allow anon all on brand_briefs" ON brand_briefs FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'content_lessons' AND policyname = 'Allow anon all on content_lessons'
  ) THEN
    CREATE POLICY "Allow anon all on content_lessons" ON content_lessons FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;
