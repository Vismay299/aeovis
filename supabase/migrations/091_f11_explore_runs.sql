-- F11: one row per Prompt Explorer question asked, plus its ledger settlement.
CREATE TABLE IF NOT EXISTS public.explore_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  job_id uuid,                                   -- F01 jobs.id; no FK because jobs are pruned after 30 days
  prompt text NOT NULL CHECK (length(btrim(prompt)) BETWEEN 1 AND 500),
  prompt_hash text NOT NULL CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
  models text[] NOT NULL CHECK (cardinality(models) BETWEEN 1 AND 4
    AND models <@ ARRAY['chatgpt','gemini','perplexity']::text[]),
  web_search boolean NOT NULL DEFAULT true,
  country text CHECK (country IS NULL OR country ~ '^[A-Z]{2}$'),
  highlight_brand text CHECK (highlight_brand IS NULL OR length(btrim(highlight_brand)) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','partial','failed','cancelled')),
  plan jsonb NOT NULL,                           -- ExplorePlan (§6.2), one entry per selected model
  quote jsonb NOT NULL,                          -- F09 PriceQuote the customer approved
  approved_max_usd numeric(12,6) NOT NULL CHECK (approved_max_usd >= 0),
  hold_id uuid REFERENCES public.spend_holds(id),
  question_id uuid REFERENCES public.workspace_questions(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
COMMENT ON COLUMN public.explore_runs.prompt_hash IS
  'sha256 of the prompt trimmed with internal whitespace collapsed (case kept), as OpenSEO normalizePromptForCache.';
CREATE INDEX IF NOT EXISTS explore_runs_brand_idx ON public.explore_runs (brand_key, created_at DESC);
CREATE INDEX IF NOT EXISTS explore_runs_user_idx ON public.explore_runs (created_by, created_at DESC);
CREATE INDEX IF NOT EXISTS explore_runs_active_idx ON public.explore_runs (brand_key, created_by)
  WHERE status IN ('queued','running');
ALTER TABLE public.explore_runs ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.explore_runs TO authenticated;
GRANT ALL ON public.explore_runs TO service_role;
DROP POLICY IF EXISTS explore_runs_read ON public.explore_runs;
CREATE POLICY explore_runs_read ON public.explore_runs FOR SELECT TO authenticated
  USING (public.customer_can_access_brand(brand_key));

-- Ledger rows for one run's attempts. Same mapping as F03's f03_upsert_attempt_rows, scoped to
-- explore observations (which F03's sync cannot see: it joins scan_jobs).
CREATE OR REPLACE FUNCTION public.f11_upsert_explore_attempt_rows(p_run uuid, p_hold uuid)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r record; v integer := 0; v_src text; v_actual numeric; v_accounted numeric;
BEGIN
  FOR r IN
    SELECT a.observation_id, a.attempt_no, a.reserved_usd, a.charged_usd, a.cost_state, a.dispatch_state,
           a.result->>'cost_source' AS reported_source, a.started_at, a.finished_at,
           coalesce(a.result->'provenance'->>'gateway', 'unknown') AS gateway, o.engine, o.brand_key
      FROM probe_attempts a JOIN probe_observations o ON o.id = a.observation_id
     WHERE o.purpose = 'explore' AND o.context->>'explore_run_id' = p_run::text
     ORDER BY a.started_at
  LOOP
    IF r.cost_state = 'confirmed_not_dispatched' THEN v_src := 'none'; v_actual := 0; v_accounted := 0;
    ELSIF r.charged_usd IS NULL THEN v_src := 'reservation'; v_actual := NULL; v_accounted := r.reserved_usd;
    ELSE v_src := CASE WHEN r.reported_source = 'gateway' THEN 'provider_reported' ELSE 'price_table' END;
         v_actual := r.charged_usd; v_accounted := r.charged_usd;
    END IF;
    INSERT INTO spend_ledger(brand_key, feature, hold_id, job_id, source_ref, provider, endpoint, units,
                             estimate_usd, actual_usd, accounted_usd, cost_source, occurred_at, meta,
                             subject_kind, subject_id, answer_ref)
    VALUES (r.brand_key, 'ai_visibility.explore', p_hold, NULL,
            'probe_attempt:' || r.observation_id || ':' || r.attempt_no,
            r.gateway, 'probe:' || r.engine, 1, r.reserved_usd, v_actual, v_accounted, v_src,
            coalesce(r.finished_at, r.started_at),
            jsonb_build_object('engine', r.engine, 'attempt_no', r.attempt_no, 'cost_state', r.cost_state,
                               'reported_source', r.reported_source),
            'explore_run', p_run::text, r.observation_id)
    ON CONFLICT (source_ref) DO UPDATE SET actual_usd = excluded.actual_usd, accounted_usd = excluded.accounted_usd,
      cost_source = excluded.cost_source, meta = excluded.meta, hold_id = coalesce(excluded.hold_id, spend_ledger.hold_id);
    v := v + 1;
  END LOOP;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.settle_explore_hold(p_run uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE run explore_runs; h spend_holds; v_rows integer; v_sum numeric; v_unknown boolean;
BEGIN
  SELECT * INTO run FROM explore_runs WHERE id = p_run FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('settled', false, 'reason', 'run_missing'); END IF;
  IF run.status NOT IN ('completed','partial','failed','cancelled') THEN
    RETURN jsonb_build_object('settled', false, 'reason', 'run_active'); END IF;
  IF run.hold_id IS NULL THEN
    v_rows := f11_upsert_explore_attempt_rows(p_run, NULL);
    RETURN jsonb_build_object('settled', false, 'reason', 'no_hold', 'rows', v_rows); END IF;
  SELECT * INTO h FROM spend_holds WHERE id = run.hold_id FOR UPDATE;
  IF h.status NOT IN ('held','expired') THEN RETURN jsonb_build_object('settled', false, 'reason', h.status); END IF;
  IF h.status = 'expired' THEN
    DELETE FROM spend_ledger WHERE source_ref = 'hold:' || h.id AND cost_source = 'reservation';
  END IF;
  v_rows := f11_upsert_explore_attempt_rows(p_run, h.id);
  SELECT coalesce(sum(actual_usd), 0), bool_or(cost_source = 'reservation') INTO v_sum, v_unknown
    FROM spend_ledger WHERE subject_kind = 'explore_run' AND subject_id = p_run::text
     AND source_ref LIKE 'probe_attempt:%';
  UPDATE spend_holds SET status = 'settled', actual_usd = CASE WHEN coalesce(v_unknown,false) THEN NULL ELSE v_sum END,
         closed_at = now() WHERE id = h.id;
  RETURN jsonb_build_object('settled', true, 'rows', v_rows, 'actual_usd', v_sum, 'unknown', coalesce(v_unknown,false));
END $$;

CREATE OR REPLACE FUNCTION public.settle_finished_explore_holds(p_limit integer DEFAULT 50)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r record; v integer := 0;
BEGIN
  FOR r IN SELECT e.id FROM explore_runs e JOIN spend_holds h ON h.id = e.hold_id
            WHERE e.status IN ('completed','partial','failed','cancelled') AND h.status IN ('held','expired')
            ORDER BY e.created_at LIMIT p_limit LOOP
    PERFORM settle_explore_hold(r.id); v := v + 1;
  END LOOP;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.prune_explore_runs(p_before timestamptz, p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  WITH old AS (SELECT id FROM explore_runs WHERE created_at < p_before ORDER BY created_at LIMIT p_limit)
  DELETE FROM explore_runs e USING old WHERE e.id = old.id;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;

REVOKE ALL ON FUNCTION public.f11_upsert_explore_attempt_rows(uuid,uuid), public.settle_explore_hold(uuid),
  public.settle_finished_explore_holds(integer), public.prune_explore_runs(timestamptz,integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.f11_upsert_explore_attempt_rows(uuid,uuid), public.settle_explore_hold(uuid),
  public.settle_finished_explore_holds(integer), public.prune_explore_runs(timestamptz,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
