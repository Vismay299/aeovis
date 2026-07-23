-- Agent Content OS v2 — custom agents + live agent trace
-- Safe to re-run: uses IF NOT EXISTS / idempotent column adds.

-- Custom agents (configurable content operators, per brand)
CREATE TABLE IF NOT EXISTS content_agents (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand text NOT NULL,
  name text NOT NULL,
  slug text NOT NULL,
  emoji text,
  color text,
  description text,
  base text NOT NULL,                 -- 'geo_article' | 'linkedin_post' (pipeline mechanics)
  format text NOT NULL,               -- article|listicle|comparison|faq|how_to|linkedin_post|thread
  channel text,                       -- website|blog|linkedin|x|newsletter|other
  length_hint text,
  design_rules jsonb DEFAULT '[]',
  format_config jsonb DEFAULT '{}',
  custom_instructions text,
  rubric_emphasis jsonb DEFAULT '{}',
  targeting jsonb DEFAULT '{}',
  is_builtin boolean DEFAULT false,
  active boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Agent columns on jobs + items (snapshot the agent config at run time so
-- later edits never retroactively change a produced item's provenance).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='content_jobs' AND column_name='agent_id') THEN
    ALTER TABLE content_jobs ADD COLUMN agent_id uuid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='content_jobs' AND column_name='agent_snapshot') THEN
    ALTER TABLE content_jobs ADD COLUMN agent_snapshot jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='content_jobs' AND column_name='agent_trace') THEN
    ALTER TABLE content_jobs ADD COLUMN agent_trace jsonb DEFAULT '[]';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='content_items' AND column_name='agent_id') THEN
    ALTER TABLE content_items ADD COLUMN agent_id uuid;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='content_items' AND column_name='agent_snapshot') THEN
    ALTER TABLE content_items ADD COLUMN agent_snapshot jsonb;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'content_agents_brand_slug_idx'
  ) THEN
    ALTER TABLE content_agents
      ADD CONSTRAINT content_agents_brand_slug_idx UNIQUE (brand, slug);
  END IF;
END $$;

ALTER TABLE content_agents ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'content_agents' AND policyname = 'Allow anon all on content_agents'
  ) THEN
    CREATE POLICY "Allow anon all on content_agents" ON content_agents FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;
