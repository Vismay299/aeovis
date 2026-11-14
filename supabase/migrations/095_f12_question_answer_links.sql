-- F12: stable link from every collected answer of the workspace to the question it answered,
-- across scans, panel versions, Prompt Explorer and legacy prompt_results rows.
-- P0 tables are read only. Requires F08 (workspace_questions, normalize_question_text).

DO $$ BEGIN
  IF to_regclass('public.workspace_questions') IS NULL
     OR to_regprocedure('public.normalize_question_text(text)') IS NULL THEN
    RAISE EXCEPTION 'F12 requires F08: workspace_questions and normalize_question_text(text)';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.question_answer_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  question_id uuid NOT NULL REFERENCES public.workspace_questions(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (source IN ('scan','explore','legacy')),
  observation_id text UNIQUE REFERENCES public.probe_observations(id) ON DELETE CASCADE,
  prompt_result_id uuid UNIQUE REFERENCES public.prompt_results(id) ON DELETE CASCADE,
  scan_job_id uuid,                       -- scan_jobs.id (scan and legacy rows)
  scan_id uuid,                           -- scans.id once the scan finalized
  explore_run_id uuid,                    -- explore_runs.id (F11), no FK: runs are pruned after 13 months
  engine text NOT NULL,
  asked_text text NOT NULL,               -- exact text asked; may differ from the question's current text
  collected_at timestamptz NOT NULL,
  linked_by text NOT NULL CHECK (linked_by IN ('backfill','periodic','read')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT question_answer_links_target CHECK (observation_id IS NOT NULL OR prompt_result_id IS NOT NULL),
  CONSTRAINT question_answer_links_source_shape CHECK (
    (source = 'scan' AND observation_id IS NOT NULL AND scan_job_id IS NOT NULL)
    OR (source = 'explore' AND observation_id IS NOT NULL AND explore_run_id IS NOT NULL)
    OR (source = 'legacy' AND observation_id IS NULL AND prompt_result_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS question_answer_links_question_idx
  ON public.question_answer_links (question_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS question_answer_links_brand_idx
  ON public.question_answer_links (brand_key, collected_at DESC);
CREATE INDEX IF NOT EXISTS question_answer_links_scan_idx
  ON public.question_answer_links (scan_id) WHERE scan_id IS NOT NULL;
ALTER TABLE public.question_answer_links ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.question_answer_links TO authenticated;
GRANT ALL ON public.question_answer_links TO service_role;
DROP POLICY IF EXISTS question_answer_links_read ON public.question_answer_links;
CREATE POLICY question_answer_links_read ON public.question_answer_links FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));

CREATE OR REPLACE FUNCTION public.link_question_answers(p_brand text, p_limit integer DEFAULT 2000,
  p_import_missing boolean DEFAULT false, p_linked_by text DEFAULT 'periodic')
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_scan integer := 0; v_explore integer := 0; v_legacy integer := 0; v_imported integer := 0; v_unmatched integer := 0;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN RAISE EXCEPTION 'invalid link limit'; END IF;
  IF p_linked_by NOT IN ('backfill','periodic','read') THEN RAISE EXCEPTION 'invalid linker'; END IF;
  IF NOT EXISTS (SELECT 1 FROM customer_brands WHERE brand_key = p_brand) THEN RAISE EXCEPTION 'unknown workspace'; END IF;

  IF p_import_missing THEN
    INSERT INTO workspace_questions(brand_key, text, topic, origin, status, branded)
    SELECT p_brand, src.text, 'General', 'import', 'archived', coalesce(src.branded, false)
      FROM (
        SELECT DISTINCT ON (normalize_question_text(t.text)) t.text, t.branded
          FROM (
            SELECT o.query AS text, (o.result->>'is_branded_query')::boolean AS branded, o.created_at
              FROM probe_observations o JOIN scan_jobs j ON j.id = o.job_id
             WHERE j.brand_key = p_brand AND o.purpose = 'scan'
            UNION ALL
            SELECT r.query, r.is_branded_query, r.created_at FROM prompt_results r WHERE r.brand = p_brand
          ) t
         WHERE btrim(t.text) <> ''
         ORDER BY normalize_question_text(t.text), t.created_at
      ) src
     WHERE NOT EXISTS (SELECT 1 FROM workspace_questions q
                        WHERE q.brand_key = p_brand AND q.text_normalized = normalize_question_text(src.text))
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_imported = ROW_COUNT;
  END IF;

  -- 1. Terminal scan observations. Prefer the question id frozen in the scan's panel snapshot.
  WITH cand AS (
    SELECT o.id, o.job_id, o.engine, o.query, coalesce(o.observed_at, o.created_at) AS at, j.result_id AS scan_id,
           coalesce(
             (SELECT q.id FROM jsonb_array_elements(coalesce(j.panel_snapshot->'payload'->'prompts', '[]'::jsonb)) e
                JOIN workspace_questions q ON q.id::text = e->>'question_id' AND q.brand_key = p_brand
               WHERE normalize_question_text(e->>'text') = normalize_question_text(o.query) LIMIT 1),
             (SELECT q.id FROM workspace_questions q
               WHERE q.brand_key = p_brand AND q.text_normalized = normalize_question_text(o.query) LIMIT 1)
           ) AS question_id
      FROM probe_observations o JOIN scan_jobs j ON j.id = o.job_id
     WHERE j.brand_key = p_brand AND o.purpose = 'scan'
       AND o.state IN ('answered','valid_no_aio','failed','ambiguous','blocked')
       AND NOT EXISTS (SELECT 1 FROM question_answer_links l WHERE l.observation_id = o.id)
  )
  INSERT INTO question_answer_links(brand_key, question_id, source, observation_id, prompt_result_id,
                                    scan_job_id, scan_id, engine, asked_text, collected_at, linked_by)
  SELECT p_brand, c.question_id, 'scan', c.id,
         (SELECT r.id FROM prompt_results r WHERE r.job_id = c.job_id AND r.engine = c.engine AND r.query = c.query LIMIT 1),
         c.job_id, c.scan_id, c.engine, c.query, c.at, p_linked_by
    FROM (SELECT * FROM cand WHERE question_id IS NOT NULL ORDER BY at LIMIT p_limit) c
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_scan = ROW_COUNT;

  -- 2. Explore observations (F11) of this workspace.
  INSERT INTO question_answer_links(brand_key, question_id, source, observation_id, explore_run_id,
                                    engine, asked_text, collected_at, linked_by)
  SELECT p_brand, q.id, 'explore', o.id, (o.context->>'explore_run_id')::uuid, o.engine, o.query,
         coalesce(o.observed_at, o.created_at), p_linked_by
    FROM probe_observations o
    JOIN workspace_questions q ON q.brand_key = p_brand AND q.text_normalized = normalize_question_text(o.query)
   WHERE o.purpose = 'explore' AND o.brand_key = p_brand
     AND o.state IN ('answered','failed','ambiguous','blocked')
     AND NOT EXISTS (SELECT 1 FROM question_answer_links l WHERE l.observation_id = o.id)
   ORDER BY o.created_at LIMIT p_limit
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_explore = ROW_COUNT;

  -- 3. Legacy prompt_results with no observation (scans before durable dispatch).
  INSERT INTO question_answer_links(brand_key, question_id, source, prompt_result_id, scan_job_id, scan_id,
                                    engine, asked_text, collected_at, linked_by)
  SELECT p_brand, q.id, 'legacy', r.id, r.job_id, r.scan_id, r.engine, r.query, coalesce(r.created_at, now()), p_linked_by
    FROM prompt_results r
    JOIN workspace_questions q ON q.brand_key = p_brand AND q.text_normalized = normalize_question_text(r.query)
   WHERE r.brand = p_brand
     AND NOT EXISTS (SELECT 1 FROM probe_observations o WHERE o.job_id = r.job_id AND o.engine = r.engine AND o.query = r.query)
     AND NOT EXISTS (SELECT 1 FROM question_answer_links l WHERE l.prompt_result_id = r.id)
   ORDER BY r.created_at LIMIT p_limit
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_legacy = ROW_COUNT;

  -- 4. Late scan_id: links created before the scan finalized.
  UPDATE question_answer_links l SET scan_id = j.result_id
    FROM scan_jobs j WHERE l.brand_key = p_brand AND l.scan_id IS NULL AND l.scan_job_id = j.id AND j.result_id IS NOT NULL;

  SELECT count(*) INTO v_unmatched
    FROM probe_observations o JOIN scan_jobs j ON j.id = o.job_id
   WHERE j.brand_key = p_brand AND o.purpose = 'scan'
     AND o.state IN ('answered','valid_no_aio','failed','ambiguous','blocked')
     AND NOT EXISTS (SELECT 1 FROM question_answer_links l WHERE l.observation_id = o.id)
     AND NOT EXISTS (SELECT 1 FROM workspace_questions q WHERE q.brand_key = p_brand
                       AND q.text_normalized = normalize_question_text(o.query));
  RETURN jsonb_build_object('scan', v_scan, 'explore', v_explore, 'legacy', v_legacy,
                            'imported', v_imported, 'unmatched', v_unmatched);
END $$;

CREATE OR REPLACE FUNCTION public.prune_question_answer_links(p_before timestamptz, p_limit integer DEFAULT 5000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  WITH old AS (SELECT id FROM question_answer_links WHERE collected_at < p_before ORDER BY collected_at LIMIT p_limit)
  DELETE FROM question_answer_links l USING old WHERE l.id = old.id;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;

REVOKE ALL ON FUNCTION public.link_question_answers(text,integer,boolean,text),
  public.prune_question_answer_links(timestamptz,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.link_question_answers(text,integer,boolean,text),
  public.prune_question_answer_links(timestamptz,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
