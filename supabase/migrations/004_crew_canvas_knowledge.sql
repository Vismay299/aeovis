-- Agent OS v3 — composable crew pipelines + knowledge blocks
-- Safe to re-run: uses IF NOT EXISTS / idempotent column adds.

-- Custom pipeline per agent (ordered block slugs; null = default crew for base)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='content_agents' AND column_name='pipeline') THEN
    ALTER TABLE content_agents ADD COLUMN pipeline jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='content_agents' AND column_name='block_config') THEN
    ALTER TABLE content_agents ADD COLUMN block_config jsonb DEFAULT '{}';
  END IF;
END $$;

-- Knowledge blocks: the stackable context layer every agent inherits.
CREATE TABLE IF NOT EXISTS knowledge_blocks (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  brand text NOT NULL,
  type text NOT NULL,                 -- url | snippet | banned_claims | glossary
  title text NOT NULL,
  content text,                       -- extracted/pasted text (bounded at write)
  source_url text,
  active boolean DEFAULT true,
  sort_order integer DEFAULT 0,       -- drag order = precedence on conflict
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE knowledge_blocks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'knowledge_blocks' AND policyname = 'Allow anon all on knowledge_blocks'
  ) THEN
    CREATE POLICY "Allow anon all on knowledge_blocks" ON knowledge_blocks FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END $$;
