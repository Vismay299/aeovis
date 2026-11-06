-- F08: stable per-question identity under R14 panels. Additive; R14 functions unchanged.
CREATE OR REPLACE FUNCTION public.normalize_question_text(p text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT SET search_path = pg_catalog AS $$
  SELECT lower(btrim(regexp_replace(p, '\s+', ' ', 'g')))
$$;
COMMENT ON FUNCTION public.normalize_question_text(text) IS 'Case-insensitive question identity. Mirrors normalizeQuestionText() in src/lib/questions/workspaceQuestions.ts.';

CREATE TABLE IF NOT EXISTS public.workspace_question_settings (
  brand_key text PRIMARY KEY REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  revision bigint NOT NULL DEFAULT 0,
  persona text CHECK (persona IS NULL OR length(persona) BETWEEN 1 AND 500),
  country text NOT NULL DEFAULT 'in' CHECK (country ~ '^[a-z]{2}$'),
  language text NOT NULL DEFAULT 'en' CHECK (language ~ '^[a-z]{2,3}(-[a-z0-9]{2,8})?$'),
  research_keywords text[] NOT NULL DEFAULT '{}' CHECK (cardinality(research_keywords) <= 45),
  setup_job_id uuid,
  setup_saved_job_id uuid,
  setup_saved_at timestamptz,
  backfilled_at timestamptz,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON COLUMN public.workspace_question_settings.revision IS 'Bumped by every working-set write; clients send it back as expectedRevision.';

CREATE TABLE IF NOT EXISTS public.workspace_questions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  text text NOT NULL CHECK (length(text) BETWEEN 2 AND 1500),
  text_normalized text GENERATED ALWAYS AS (public.normalize_question_text(text)) STORED,
  topic text NOT NULL DEFAULT 'General' CHECK (length(topic) BETWEEN 1 AND 120),
  origin text NOT NULL CHECK (origin IN ('ai_setup','ai_generate','prompt_research','promptgen','manual','import')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','archived')),
  branded boolean NOT NULL DEFAULT false,
  cohort text NOT NULL DEFAULT 'core' CHECK (cohort IN ('core')),
  replaced_by uuid REFERENCES public.workspace_questions(id) ON DELETE SET NULL,
  duplicate_reason text CHECK (duplicate_reason IS NULL OR length(duplicate_reason) BETWEEN 1 AND 300),
  source_ref jsonb CHECK (source_ref IS NULL OR (jsonb_typeof(source_ref) = 'object' AND pg_column_size(source_ref) < 4096)),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CHECK (replaced_by IS NULL OR replaced_by <> id),
  UNIQUE (brand_key, text_normalized)
);
COMMENT ON COLUMN public.workspace_questions.branded IS 'Names the workspace brand: asked as a diagnostic, never in the headline.';
COMMENT ON COLUMN public.workspace_questions.cohort IS 'core = curated set. Reserved for a later rolling cohort (locked-core idea); only core exists today.';
COMMENT ON COLUMN public.workspace_questions.replaced_by IS 'Set when an edit archived this wording; points at the new wording.';
CREATE INDEX IF NOT EXISTS workspace_questions_brand_status_idx ON public.workspace_questions (brand_key, status, topic);

CREATE TABLE IF NOT EXISTS public.workspace_question_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  question_id uuid REFERENCES public.workspace_questions(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event IN ('created','revived','archived','paused','resumed','topic_changed','replaced',
                                       'duplicate_reason','approved')),
  detail jsonb CHECK (detail IS NULL OR pg_column_size(detail) < 2048),
  revision bigint NOT NULL,
  actor uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workspace_question_events_brand_idx ON public.workspace_question_events (brand_key, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_question_events_question_idx ON public.workspace_question_events (question_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.f08_question_row_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.text IS DISTINCT FROM OLD.text THEN RAISE EXCEPTION 'question_text_immutable'; END IF;
    IF NEW.brand_key IS DISTINCT FROM OLD.brand_key THEN RAISE EXCEPTION 'question_brand_immutable'; END IF;
    NEW.updated_at := now();
  END IF;
  IF NEW.status = 'archived' THEN NEW.archived_at := coalesce(NEW.archived_at, now()); ELSE NEW.archived_at := NULL; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS workspace_questions_rules ON public.workspace_questions;
CREATE TRIGGER workspace_questions_rules BEFORE INSERT OR UPDATE ON public.workspace_questions
  FOR EACH ROW EXECUTE FUNCTION public.f08_question_row_rules();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_question_settings','workspace_questions','workspace_question_events'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS f08_member_read ON public.%I', t);
    EXECUTE format('CREATE POLICY f08_member_read ON public.%I FOR SELECT TO authenticated USING (public.customer_can_access_brand(brand_key))', t);
  END LOOP;
END $$;

-- Raises when adding p_questions unarchived questions and p_topics new topics would pass 100 / 30.
CREATE OR REPLACE FUNCTION public.f08_assert_room(p_brand text, p_questions integer, p_topics integer) RETURNS void
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_q integer; v_t integer;
BEGIN
  SELECT count(*), count(DISTINCT lower(topic)) INTO v_q, v_t FROM workspace_questions WHERE brand_key = p_brand AND status <> 'archived';
  IF v_q + p_questions > 100 THEN RAISE EXCEPTION 'question_cap:questions'; END IF;
  IF v_t + p_topics > 30 THEN RAISE EXCEPTION 'question_cap:topics'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.f08_bump_revision(p_brand text, p_actor uuid) RETURNS bigint
LANGUAGE sql SET search_path = public AS $$
  INSERT INTO workspace_question_settings(brand_key, revision, updated_by) VALUES (p_brand, 1, p_actor)
  ON CONFLICT (brand_key) DO UPDATE SET revision = workspace_question_settings.revision + 1, updated_at = now(),
    updated_by = coalesce(excluded.updated_by, workspace_question_settings.updated_by)
  RETURNING revision;
$$;

-- Single-question add used by F11 ("Track this question"), F22 tools and imports. No revision check.
CREATE OR REPLACE FUNCTION public.add_workspace_question(p_brand text, p_text text, p_topic text, p_origin text,
  p_status text DEFAULT 'active', p_branded boolean DEFAULT false, p_source_ref jsonb DEFAULT NULL, p_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE q workspace_questions; v_rev bigint; v_topic text := coalesce(nullif(btrim(p_topic), ''), 'General');
  v_new_topic integer;
BEGIN
  IF p_status NOT IN ('active','paused','archived') THEN RAISE EXCEPTION 'question_invalid:status'; END IF;
  IF p_actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customer_brand_memberships WHERE brand_key = p_brand AND user_id = p_actor) THEN
    RAISE EXCEPTION 'question_invalid:actor'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('f08:questions:' || p_brand));
  SELECT CASE WHEN EXISTS (SELECT 1 FROM workspace_questions WHERE brand_key = p_brand AND status <> 'archived'
                             AND lower(topic) = lower(v_topic)) THEN 0 ELSE 1 END INTO v_new_topic;
  SELECT * INTO q FROM workspace_questions WHERE brand_key = p_brand AND text_normalized = normalize_question_text(p_text) FOR UPDATE;
  IF FOUND THEN
    IF q.status = 'archived' AND p_status <> 'archived' THEN
      PERFORM f08_assert_room(p_brand, 1, v_new_topic);
      UPDATE workspace_questions SET status = p_status, topic = v_topic WHERE id = q.id RETURNING * INTO q;
      v_rev := f08_bump_revision(p_brand, p_actor);
      INSERT INTO workspace_question_events(brand_key, question_id, event, detail, revision, actor)
        VALUES (p_brand, q.id, 'revived', jsonb_build_object('origin', p_origin), v_rev, p_actor);
      RETURN jsonb_build_object('id', q.id, 'status', q.status, 'created', false, 'revived', true, 'revision', v_rev);
    END IF;
    RETURN jsonb_build_object('id', q.id, 'status', q.status, 'created', false, 'revived', false,
      'revision', (SELECT revision FROM workspace_question_settings WHERE brand_key = p_brand));
  END IF;
  IF p_status <> 'archived' THEN PERFORM f08_assert_room(p_brand, 1, v_new_topic); END IF;
  INSERT INTO workspace_questions(brand_key, text, topic, origin, status, branded, source_ref, created_by)
  VALUES (p_brand, p_text, v_topic, p_origin, p_status, coalesce(p_branded, false), p_source_ref, p_actor) RETURNING * INTO q;
  v_rev := f08_bump_revision(p_brand, p_actor);
  INSERT INTO workspace_question_events(brand_key, question_id, event, detail, revision, actor)
    VALUES (p_brand, q.id, 'created', jsonb_build_object('origin', p_origin), v_rev, p_actor);
  RETURN jsonb_build_object('id', q.id, 'status', q.status, 'created', true, 'revived', false, 'revision', v_rev);
END $$;

-- Applies a patch resolved by projectQuestionPatch(). Optimistic on settings.revision.
CREATE OR REPLACE FUNCTION public.save_workspace_questions(p_brand text, p_expected_revision bigint, p_rows jsonb,
  p_events jsonb, p_settings jsonb, p_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s workspace_question_settings; r jsonb; v_bq integer; v_bt integer; v_aq integer; v_at integer; v_rev bigint;
BEGIN
  IF p_actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM customer_brand_memberships WHERE brand_key = p_brand AND user_id = p_actor) THEN
    RAISE EXCEPTION 'question_invalid:actor'; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('f08:questions:' || p_brand));
  INSERT INTO workspace_question_settings(brand_key) VALUES (p_brand) ON CONFLICT DO NOTHING;
  SELECT * INTO s FROM workspace_question_settings WHERE brand_key = p_brand FOR UPDATE;
  IF s.revision <> p_expected_revision THEN RAISE EXCEPTION 'question_revision_conflict'; END IF;
  SELECT count(*), count(DISTINCT lower(topic)) INTO v_bq, v_bt FROM workspace_questions WHERE brand_key = p_brand AND status <> 'archived';
  FOR r IN SELECT value FROM jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) LOOP
    IF r->>'op' = 'insert' THEN
      INSERT INTO workspace_questions(id, brand_key, text, topic, origin, status, branded, source_ref, created_by)
      VALUES ((r->>'id')::uuid, p_brand, r->>'text', coalesce(r->>'topic', 'General'), r->>'origin',
              coalesce(r->>'status', 'active'), coalesce((r->>'branded')::boolean, false), nullif(r->'source_ref', 'null'::jsonb), p_actor);
    ELSIF r->>'op' = 'update' THEN
      UPDATE workspace_questions SET topic = coalesce(r->>'topic', topic), status = coalesce(r->>'status', status),
        branded = coalesce((r->>'branded')::boolean, branded),
        replaced_by = CASE WHEN r ? 'replaced_by' THEN (r->>'replaced_by')::uuid ELSE replaced_by END,
        duplicate_reason = CASE WHEN r ? 'duplicate_reason' THEN r->>'duplicate_reason' ELSE duplicate_reason END
      WHERE id = (r->>'id')::uuid AND brand_key = p_brand;
      IF NOT FOUND THEN RAISE EXCEPTION 'question_invalid:unknown_id'; END IF;
    ELSE RAISE EXCEPTION 'question_invalid:op'; END IF;
  END LOOP;
  SELECT count(*), count(DISTINCT lower(topic)) INTO v_aq, v_at FROM workspace_questions WHERE brand_key = p_brand AND status <> 'archived';
  IF v_aq > 100 AND v_aq > v_bq THEN RAISE EXCEPTION 'question_cap:questions'; END IF;
  IF v_at > 30 AND v_at > v_bt THEN RAISE EXCEPTION 'question_cap:topics'; END IF;
  IF p_settings IS NOT NULL THEN
    UPDATE workspace_question_settings SET
      persona = CASE WHEN p_settings ? 'persona' THEN nullif(btrim(p_settings->>'persona'), '') ELSE persona END,
      country = coalesce(p_settings->>'country', country), language = coalesce(p_settings->>'language', language),
      research_keywords = CASE WHEN p_settings ? 'research_keywords'
        THEN ARRAY(SELECT jsonb_array_elements_text(p_settings->'research_keywords')) ELSE research_keywords END,
      setup_saved_job_id = CASE WHEN p_settings ? 'setup_saved_job_id' THEN (p_settings->>'setup_saved_job_id')::uuid ELSE setup_saved_job_id END,
      setup_saved_at = CASE WHEN p_settings ? 'setup_saved_job_id' THEN now() ELSE setup_saved_at END
    WHERE brand_key = p_brand;
  END IF;
  v_rev := f08_bump_revision(p_brand, p_actor);
  INSERT INTO workspace_question_events(brand_key, question_id, event, detail, revision, actor)
  SELECT p_brand, (e->>'question_id')::uuid, e->>'event', e->'detail', v_rev, p_actor
    FROM jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e;
  RETURN jsonb_build_object('revision', v_rev);
END $$;

-- Legacy approved panels (POST /api/customer/repairs/panel): make the working set equal the posted prompts.
-- Exempt from the 100/30 caps (validatePanel allows 200 prompts).
CREATE OR REPLACE FUNCTION public.sync_panel_questions(p_brand text, p_prompts jsonb, p_settings jsonb, p_actor uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE e jsonb; q workspace_questions; v_keep uuid[] := '{}'; v_ids jsonb := '[]'::jsonb; v_rev bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('f08:questions:' || p_brand));
  v_rev := f08_bump_revision(p_brand, p_actor);
  FOR e IN SELECT value FROM jsonb_array_elements(p_prompts) LOOP
    SELECT * INTO q FROM workspace_questions WHERE brand_key = p_brand AND text_normalized = normalize_question_text(e->>'text') FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO workspace_questions(brand_key, text, topic, origin, status, branded, source_ref, created_by)
      VALUES (p_brand, e->>'text', coalesce(nullif(btrim(e->>'topic'), ''), 'General'),
              CASE WHEN e->>'origin' = 'manual' THEN 'manual' ELSE 'import' END, 'active', coalesce(e->>'purpose', '') = 'diagnostic',
              jsonb_build_object('kind', 'panel_sync', 'panel_origin', e->>'origin'), p_actor) RETURNING * INTO q;
      INSERT INTO workspace_question_events(brand_key, question_id, event, detail, revision, actor)
        VALUES (p_brand, q.id, 'created', '{"via":"panel_sync"}', v_rev, p_actor);
    ELSIF q.status <> 'active' THEN
      UPDATE workspace_questions SET status = 'active' WHERE id = q.id;
      INSERT INTO workspace_question_events(brand_key, question_id, event, detail, revision, actor)
        VALUES (p_brand, q.id, CASE WHEN q.status = 'archived' THEN 'revived' ELSE 'resumed' END, '{"via":"panel_sync"}', v_rev, p_actor);
    END IF;
    v_keep := v_keep || q.id;
    v_ids := v_ids || jsonb_build_object('text', e->>'text', 'question_id', q.id);
  END LOOP;
  WITH gone AS (UPDATE workspace_questions SET status = 'archived'
                 WHERE brand_key = p_brand AND status <> 'archived' AND NOT (id = ANY(v_keep)) RETURNING id)
  INSERT INTO workspace_question_events(brand_key, question_id, event, detail, revision, actor)
    SELECT p_brand, id, 'archived', '{"via":"panel_sync"}', v_rev, p_actor FROM gone;
  UPDATE workspace_question_settings SET
    persona = coalesce(nullif(btrim(p_settings->>'persona'), ''), persona),
    country = coalesce(p_settings->>'country', country), language = coalesce(p_settings->>'language', language)
  WHERE brand_key = p_brand;
  RETURN jsonb_build_object('revision', v_rev, 'ids', v_ids);
END $$;

CREATE OR REPLACE FUNCTION public.prune_workspace_question_events(p_before timestamptz, p_limit integer DEFAULT 5000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  WITH old AS (SELECT id FROM workspace_question_events WHERE created_at < p_before ORDER BY created_at LIMIT p_limit)
  DELETE FROM workspace_question_events e USING old WHERE e.id = old.id;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;

REVOKE ALL ON FUNCTION public.f08_assert_room(text,integer,integer), public.f08_bump_revision(text,uuid),
  public.add_workspace_question(text,text,text,text,text,boolean,jsonb,uuid),
  public.save_workspace_questions(text,bigint,jsonb,jsonb,jsonb,uuid),
  public.sync_panel_questions(text,jsonb,jsonb,uuid), public.prune_workspace_question_events(timestamptz,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.f08_assert_room(text,integer,integer), public.f08_bump_revision(text,uuid),
  public.add_workspace_question(text,text,text,text,text,boolean,jsonb,uuid),
  public.save_workspace_questions(text,bigint,jsonb,jsonb,jsonb,uuid),
  public.sync_panel_questions(text,jsonb,jsonb,uuid), public.prune_workspace_question_events(timestamptz,integer)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.normalize_question_text(text) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
