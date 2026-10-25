-- Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
--   src/db/project-context.schema.ts
-- Modified for Perceev. See THIRD_PARTY_NOTICES.md.
-- F07: project memory. Additive. Writes only through apply_project_context_ops (service role).
CREATE OR REPLACE FUNCTION public.f07_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE TABLE IF NOT EXISTS public.project_context_sections (
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^(business_overview|current_goal|positioning|writing_preferences|custom:[a-z0-9]+(-[a-z0-9]+)*)$'
                           AND length(key) <= 67),
  title text CHECK (title IS NULL OR length(title) BETWEEN 1 AND 120),
  content text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  updated_by text NOT NULL CHECK (updated_by IN ('user','assistant','system')),
  updated_by_user uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (brand_key, key),
  CHECK (title IS NULL OR key LIKE 'custom:%')
);
COMMENT ON TABLE public.project_context_sections IS 'F07 prose memory: typed sections or custom:<slug>. Port of OpenSEO project_context_sections.';

CREATE TABLE IF NOT EXISTS public.project_competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  domain text NOT NULL CHECK (domain = lower(domain) AND length(domain) BETWEEN 3 AND 255
    AND domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' AND domain !~ '^www\.'),
  name text CHECK (name IS NULL OR length(name) BETWEEN 1 AND 120),
  notes text CHECK (notes IS NULL OR length(notes) <= 500),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','setup_research','assistant','brief_import')),
  source_url text CHECK (source_url IS NULL OR length(source_url) <= 2048),
  updated_by text NOT NULL CHECK (updated_by IN ('user','assistant','system')),
  updated_by_user uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_key, domain)
);
COMMENT ON COLUMN public.project_competitors.source_url IS 'Page actually read when setup research proposed this competitor (F08). Declared list only; never used by scan roster extraction.';
-- Replace the earlier dotted-decimal-only definition on reapply. URL parsers
-- also treat numeric shorthand, leading-zero octal and 0x hexadecimal labels
-- as IPv4 hosts (for example, 127.1 and 0x7f.1).
ALTER TABLE public.project_competitors DROP CONSTRAINT IF EXISTS project_competitors_no_ipv4;
ALTER TABLE public.project_competitors ADD CONSTRAINT project_competitors_no_ipv4
  CHECK (domain !~ '^(0x[0-9a-f]+|[0-9]+)(\.(0x[0-9a-f]+|[0-9]+))*$');
COMMENT ON CONSTRAINT project_competitors_no_ipv4 ON public.project_competitors IS
  'Rejects canonical and non-canonical numeric IPv4 host forms recognized by URL parsers: dotted decimal, shorthand, octal and hexadecimal.';

CREATE TABLE IF NOT EXISTS public.project_key_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  url text NOT NULL CHECK (length(url) BETWEEN 9 AND 2048 AND url ~ '^https://' AND position('#' in url) = 0),
  role text NOT NULL DEFAULT 'other' CHECK (role IN ('hub','spoke','money','other')),
  topic text CHECK (topic IS NULL OR length(topic) BETWEEN 1 AND 200),
  notes text CHECK (notes IS NULL OR length(notes) <= 500),
  updated_by text NOT NULL CHECK (updated_by IN ('user','assistant','system')),
  updated_by_user uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand_key, url)
);
COMMENT ON TABLE public.project_key_pages IS 'Curated shortlist of pages that matter (hub, spoke, money), not a page inventory.';

CREATE TABLE IF NOT EXISTS public.project_research_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  entry_date date NOT NULL DEFAULT ((now() AT TIME ZONE 'UTC')::date),
  kind text NOT NULL DEFAULT 'note' CHECK (kind = 'note' OR kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  research_key text CHECK (research_key IS NULL OR length(research_key) BETWEEN 1 AND 300),
  summary text NOT NULL CHECK (length(summary) BETWEEN 1 AND 1000),
  spend_usd numeric(12,6) CHECK (spend_usd IS NULL OR spend_usd >= 0),
  job_id uuid,
  created_by text NOT NULL CHECK (created_by IN ('user','assistant','system')),
  created_by_user uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON COLUMN public.project_research_log.kind IS 'Registered spend feature that bought the research (e.g. platform.selftest), or note.';
COMMENT ON COLUMN public.project_research_log.research_key IS 'Normalised input (keyword, domain) so a repeat purchase within 90 days can be detected.';
CREATE INDEX IF NOT EXISTS project_research_log_recent_idx ON public.project_research_log (brand_key, created_at DESC);
CREATE INDEX IF NOT EXISTS project_research_log_lookup_idx
  ON public.project_research_log (brand_key, kind, research_key, created_at DESC) WHERE research_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS project_research_log_retention_idx
  ON public.project_research_log (entry_date, id);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.project_research_log'::regclass AND conname = 'project_research_log_job_id_fkey'
  ) THEN
    ALTER TABLE public.project_research_log ADD CONSTRAINT project_research_log_job_id_fkey
      FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE SET NULL;
  END IF;
END $$;
COMMENT ON COLUMN public.project_research_log.job_id IS 'Optional originating job; cleared when the job row is deleted.';

CREATE TABLE IF NOT EXISTS public.project_memory_state (
  brand_key text PRIMARY KEY REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  brief_import_checked_at timestamptz,
  brief_imported boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN public.project_memory_state.brief_import_checked_at IS 'When one GET claimed a brief import attempt; release clears this after failure unless imported.';
COMMENT ON COLUMN public.project_memory_state.brief_imported IS 'True only after brief import writes complete; committed imports are never claimed or released again.';

DROP TRIGGER IF EXISTS project_context_sections_touch ON public.project_context_sections;
CREATE TRIGGER project_context_sections_touch BEFORE UPDATE ON public.project_context_sections
  FOR EACH ROW EXECUTE FUNCTION public.f07_touch_updated_at();
DROP TRIGGER IF EXISTS project_competitors_touch ON public.project_competitors;
CREATE TRIGGER project_competitors_touch BEFORE UPDATE ON public.project_competitors
  FOR EACH ROW EXECUTE FUNCTION public.f07_touch_updated_at();
DROP TRIGGER IF EXISTS project_key_pages_touch ON public.project_key_pages;
CREATE TRIGGER project_key_pages_touch BEFORE UPDATE ON public.project_key_pages
  FOR EACH ROW EXECUTE FUNCTION public.f07_touch_updated_at();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['project_context_sections','project_competitors','project_key_pages',
                           'project_research_log','project_memory_state'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS f07_member_read ON public.%I', t);
    EXECUTE format('CREATE POLICY f07_member_read ON public.%I FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key))', t);
  END LOOP;
END $$;

-- Applies an already-resolved batch (src/lib/projectContext/contextUpdateOps.ts) in one transaction.
-- Accepts 1–60 already-resolved operations; the wire API remains capped at 1–50 updates.
-- Caps are re-checked after all ops; any violation raises and rolls the whole batch back.
CREATE OR REPLACE FUNCTION public.apply_project_context_ops(p_brand text, p_ops jsonb, p_author text, p_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE op jsonb; r jsonb; v_kind text; v_applied integer := 0; v_own_host text;
  v_today date := (now() AT TIME ZONE 'UTC')::date;
BEGIN
  IF p_author IS NULL OR p_author NOT IN ('user','assistant','system') THEN RAISE EXCEPTION 'project_memory_invalid:author'; END IF;
  IF jsonb_typeof(p_ops) IS DISTINCT FROM 'array' OR jsonb_array_length(p_ops) NOT BETWEEN 1 AND 60 THEN
    RAISE EXCEPTION 'project_memory_invalid:ops'; END IF;
  IF NOT EXISTS (SELECT 1 FROM customer_brands WHERE brand_key = p_brand AND is_active) THEN
    RAISE EXCEPTION 'project_memory_invalid:brand'; END IF;
  SELECT lower(regexp_replace(website_host, '^www\.', '', 'i')) INTO v_own_host
    FROM customer_brands WHERE brand_key = p_brand;
  -- An actor who is no longer a member is dropped to NULL, not refused: background jobs
  -- (F13 keywords.metrics_refresh, F15 rank_tracking.metrics) append research-log entries as
  -- "user" with the id of whoever started them, and an offboarded teammate must not fail a job step.
  IF p_actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customer_brand_memberships WHERE brand_key = p_brand AND user_id = p_actor) THEN
    p_actor := NULL; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('f07:memory:' || p_brand));
  FOR op IN SELECT value FROM jsonb_array_elements(p_ops) LOOP
    v_kind := op->>'kind';
    IF v_kind = 'upsert_section' THEN
      INSERT INTO project_context_sections(brand_key, key, title, content, updated_by, updated_by_user)
      VALUES (p_brand, op->>'key', op->>'title', op->>'content', p_author, p_actor)
      ON CONFLICT (brand_key, key) DO UPDATE SET title = coalesce(excluded.title, project_context_sections.title),
        content = excluded.content, updated_by = excluded.updated_by, updated_by_user = excluded.updated_by_user;
    ELSIF v_kind = 'insert_section_if_missing' THEN
      INSERT INTO project_context_sections(brand_key, key, title, content, updated_by, updated_by_user)
      VALUES (p_brand, op->>'key', op->>'title', op->>'content', p_author, p_actor) ON CONFLICT DO NOTHING;
    ELSIF v_kind = 'delete_section' THEN
      DELETE FROM project_context_sections WHERE brand_key = p_brand AND key = op->>'key';
    ELSIF v_kind IN ('upsert_competitors','insert_competitors_if_none') THEN
      IF v_kind = 'upsert_competitors' OR NOT EXISTS (SELECT 1 FROM project_competitors WHERE brand_key = p_brand) THEN
        FOR r IN SELECT value FROM jsonb_array_elements(op->'rows') LOOP
          IF lower(r->>'domain') = v_own_host THEN RAISE EXCEPTION 'project_memory_invalid:own_competitor'; END IF;
          INSERT INTO project_competitors(brand_key, domain, name, notes, source, source_url, updated_by, updated_by_user)
          VALUES (p_brand, r->>'domain', r->>'name', r->>'notes', coalesce(r->>'source','manual'), r->>'source_url', p_author, p_actor)
          ON CONFLICT (brand_key, domain) DO UPDATE SET name = coalesce(excluded.name, project_competitors.name),
            notes = coalesce(excluded.notes, project_competitors.notes),
            source_url = coalesce(excluded.source_url, project_competitors.source_url),
            updated_by = excluded.updated_by, updated_by_user = excluded.updated_by_user;
        END LOOP;
      END IF;
    ELSIF v_kind = 'delete_competitors' THEN
      DELETE FROM project_competitors WHERE brand_key = p_brand
        AND domain IN (SELECT jsonb_array_elements_text(op->'domains'));
    ELSIF v_kind = 'upsert_key_pages' THEN
      FOR r IN SELECT value FROM jsonb_array_elements(op->'rows') LOOP
        INSERT INTO project_key_pages(brand_key, url, role, topic, notes, updated_by, updated_by_user)
        VALUES (p_brand, r->>'url', coalesce(r->>'role','other'), r->>'topic', r->>'notes', p_author, p_actor)
        ON CONFLICT (brand_key, url) DO UPDATE SET
          role = CASE WHEN r->>'role' IS NULL THEN project_key_pages.role ELSE excluded.role END,
          topic = coalesce(excluded.topic, project_key_pages.topic),
          notes = coalesce(excluded.notes, project_key_pages.notes),
          updated_by = excluded.updated_by, updated_by_user = excluded.updated_by_user;
      END LOOP;
    ELSIF v_kind = 'delete_key_pages' THEN
      DELETE FROM project_key_pages WHERE brand_key = p_brand AND url IN (SELECT jsonb_array_elements_text(op->'urls'));
    ELSIF v_kind = 'append_research_log' THEN
      INSERT INTO project_research_log(brand_key, entry_date, kind, research_key, summary, spend_usd, job_id, created_by, created_by_user)
      VALUES (p_brand, v_today, coalesce(op->>'research_kind','note'), op->>'research_key', op->>'summary',
              (op->>'spend_usd')::numeric, (op->>'job_id')::uuid, p_author, p_actor);
      DELETE FROM project_research_log WHERE brand_key = p_brand AND entry_date < v_today - 90;
    ELSIF v_kind = 'delete_research_log' THEN
      DELETE FROM project_research_log WHERE brand_key = p_brand
        AND id IN (SELECT (jsonb_array_elements_text(op->'ids'))::uuid);
    ELSE
      RAISE EXCEPTION 'project_memory_invalid:kind';
    END IF;
    v_applied := v_applied + 1;
  END LOOP;
  IF (SELECT count(*) FROM project_context_sections WHERE brand_key = p_brand AND key LIKE 'custom:%') > 20 THEN
    RAISE EXCEPTION 'project_memory_cap:custom_sections'; END IF;
  IF (SELECT count(*) FROM project_competitors WHERE brand_key = p_brand) > 100 THEN
    RAISE EXCEPTION 'project_memory_cap:competitors'; END IF;
  IF (SELECT count(*) FROM project_key_pages WHERE brand_key = p_brand) > 100 THEN
    RAISE EXCEPTION 'project_memory_cap:key_pages'; END IF;
  RETURN jsonb_build_object('applied', v_applied);
END $$;

CREATE OR REPLACE FUNCTION public.claim_project_brief_import(p_brand text) RETURNS boolean
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v boolean;
BEGIN
  INSERT INTO project_memory_state(brand_key) VALUES (p_brand) ON CONFLICT DO NOTHING;
  UPDATE project_memory_state SET brief_import_checked_at = now()
   WHERE brand_key = p_brand AND brief_import_checked_at IS NULL AND NOT brief_imported RETURNING true INTO v;
  RETURN coalesce(v, false);
END $$;

CREATE OR REPLACE FUNCTION public.release_project_brief_import_claim(p_brand text) RETURNS boolean
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v boolean;
BEGIN
  UPDATE project_memory_state SET brief_import_checked_at = NULL
   WHERE brand_key = p_brand AND brief_imported = false AND brief_import_checked_at IS NOT NULL
   RETURNING true INTO v;
  RETURN coalesce(v, false);
END $$;

CREATE OR REPLACE FUNCTION public.prune_project_research_log(p_before date, p_limit integer DEFAULT 5000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  WITH old AS (SELECT id FROM project_research_log WHERE entry_date < p_before ORDER BY entry_date, id LIMIT p_limit)
  DELETE FROM project_research_log l USING old WHERE l.id = old.id;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;

REVOKE ALL ON FUNCTION public.apply_project_context_ops(text,jsonb,text,uuid),
  public.claim_project_brief_import(text), public.release_project_brief_import_claim(text),
  public.prune_project_research_log(date,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_project_context_ops(text,jsonb,text,uuid),
  public.claim_project_brief_import(text), public.release_project_brief_import_claim(text),
  public.prune_project_research_log(date,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
