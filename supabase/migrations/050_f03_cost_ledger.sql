-- F03: per-answer and per-call cost ledger on top of F01's spend_ledger.
-- Never modifies probe_attempts/probe_observations or any P0 function.

ALTER TABLE public.spend_ledger ADD COLUMN IF NOT EXISTS subject_kind text
  CHECK (subject_kind IS NULL OR subject_kind ~ '^[a-z_]+$');
ALTER TABLE public.spend_ledger ADD COLUMN IF NOT EXISTS subject_id text;
ALTER TABLE public.spend_ledger ADD COLUMN IF NOT EXISTS answer_ref text;
ALTER TABLE public.spend_ledger ADD COLUMN IF NOT EXISTS price_version text
  CHECK (price_version IS NULL OR length(price_version) <= 40);
COMMENT ON COLUMN public.spend_ledger.answer_ref IS 'probe_observations.id for answer rows.';
CREATE INDEX IF NOT EXISTS spend_ledger_subject_idx ON public.spend_ledger (subject_kind, subject_id)
  WHERE subject_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS spend_ledger_answer_idx ON public.spend_ledger (answer_ref) WHERE answer_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS spend_ledger_endpoint_time_idx ON public.spend_ledger (provider, endpoint, occurred_at DESC);

-- Rows written by F01's settle_spend inherit the hold's subject and price version.
CREATE OR REPLACE FUNCTION public.f03_ledger_fill() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE h spend_holds;
BEGIN
  IF NEW.hold_id IS NOT NULL AND NEW.subject_kind IS NULL THEN
    SELECT * INTO h FROM spend_holds WHERE id = NEW.hold_id;
    IF FOUND THEN NEW.subject_kind := h.subject_kind; NEW.subject_id := h.subject_id; END IF;
  END IF;
  IF NEW.price_version IS NULL THEN NEW.price_version := NEW.meta->>'price_version'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS spend_ledger_fill ON public.spend_ledger;
CREATE TRIGGER spend_ledger_fill BEFORE INSERT ON public.spend_ledger
  FOR EACH ROW EXECUTE FUNCTION public.f03_ledger_fill();

CREATE TABLE IF NOT EXISTS public.cost_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL REFERENCES public.spend_ledger(id) ON DELETE CASCADE,
  brand_key text NOT NULL REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  feature text NOT NULL,
  provider text NOT NULL,
  endpoint text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('undershoot','unknown_cost')),
  estimate_usd numeric(12,6),
  actual_usd numeric(12,6),
  price_version text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolution text CHECK (resolution IN ('accepted','price_updated','not_billed','provider_confirmed')),
  resolved_at timestamptz,
  resolved_by text,
  note text CHECK (note IS NULL OR length(note) <= 500),
  CONSTRAINT cost_reconciliations_one UNIQUE (ledger_id, kind),
  CONSTRAINT cost_reconciliations_resolved CHECK ((resolution IS NULL) = (resolved_at IS NULL))
);
CREATE INDEX IF NOT EXISTS cost_reconciliations_open_idx ON public.cost_reconciliations (created_at)
  WHERE resolution IS NULL;
ALTER TABLE public.cost_reconciliations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.cost_reconciliations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.cost_reconciliations TO service_role;
-- Operator-only: service role. Customers never see estimate accuracy.

CREATE OR REPLACE FUNCTION public.f03_ledger_reconcile() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.actual_usd IS NOT NULL AND NEW.estimate_usd IS NOT NULL AND NEW.actual_usd > NEW.estimate_usd THEN
    INSERT INTO cost_reconciliations(ledger_id, brand_key, feature, provider, endpoint, kind,
                                     estimate_usd, actual_usd, price_version)
    VALUES (NEW.id, NEW.brand_key, NEW.feature, NEW.provider, NEW.endpoint, 'undershoot',
            NEW.estimate_usd, NEW.actual_usd, NEW.price_version)
    ON CONFLICT (ledger_id, kind) DO NOTHING;
  END IF;
  IF NEW.cost_source = 'reservation' THEN
    INSERT INTO cost_reconciliations(ledger_id, brand_key, feature, provider, endpoint, kind,
                                     estimate_usd, actual_usd, price_version)
    VALUES (NEW.id, NEW.brand_key, NEW.feature, NEW.provider, NEW.endpoint, 'unknown_cost',
            NEW.estimate_usd, NULL, NEW.price_version)
    ON CONFLICT (ledger_id, kind) DO NOTHING;
  ELSIF TG_OP = 'UPDATE' AND OLD.cost_source = 'reservation' THEN
    UPDATE cost_reconciliations SET resolution = 'provider_confirmed', resolved_at = now(),
           resolved_by = 'sync', actual_usd = NEW.actual_usd
     WHERE ledger_id = NEW.id AND kind = 'unknown_cost' AND resolution IS NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS spend_ledger_reconcile ON public.spend_ledger;
CREATE TRIGGER spend_ledger_reconcile AFTER INSERT OR UPDATE ON public.spend_ledger
  FOR EACH ROW EXECUTE FUNCTION public.f03_ledger_reconcile();

-- Scans exist today and are gated by P0 dispatch controls; this row only adds accounting and
-- workspace caps. Deliberate exception to "paid features ship disabled" (see Deviations).
INSERT INTO public.paid_feature_controls(feature, enabled, mode, note)
VALUES ('ai_visibility.scan', true, 'all',
        'Accounting for scan answers. Collection itself is gated by claim_probe_dispatch (P0).')
ON CONFLICT (feature) DO NOTHING;

-- One ledger row per finished probe attempt. Pure mapping; P0 tables are only read.
CREATE OR REPLACE FUNCTION public.f03_upsert_attempt_rows(p_job uuid, p_hold uuid, p_limit integer)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r record; v integer := 0; v_src text; v_actual numeric; v_accounted numeric; v_feature text;
BEGIN
  FOR r IN
    SELECT a.observation_id, a.attempt_no, a.reserved_usd, a.charged_usd, a.cost_state, a.dispatch_state,
           a.result->>'cost_source' AS reported_source, a.started_at, a.finished_at,
           coalesce(a.result->'provenance'->>'gateway', 'unknown') AS gateway,
           o.engine, o.job_id, j.brand_key, j.status AS job_status
      FROM probe_attempts a
      JOIN probe_observations o ON o.id = a.observation_id
      JOIN scan_jobs j ON j.id = o.job_id
     WHERE j.brand_key IS NOT NULL
       AND o.purpose = 'scan'
       AND (p_job IS NULL OR o.job_id = p_job)
       AND (a.dispatch_state IN ('recorded','unknown','historical')
            OR (a.dispatch_state = 'intent' AND j.status IN ('complete','failed','cancelled')))
       -- `expired` counts: F01's expiry turns the hold estimate into a `hold:<id>` reservation
       -- row, so until settlement runs the periodic sync must not add attempt rows beside it.
       AND (p_job IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM spend_holds h WHERE h.subject_kind = 'scan_job'
               AND h.subject_id = o.job_id::text AND h.status IN ('held','expired')))
       AND NOT EXISTS (
            SELECT 1 FROM spend_ledger l
             WHERE l.source_ref = 'probe_attempt:' || a.observation_id || ':' || a.attempt_no
               AND l.cost_source = CASE
                     WHEN a.cost_state = 'confirmed_not_dispatched' THEN 'none'
                     WHEN a.cost_state = 'reconciliation_conflict' THEN 'reservation'
                     WHEN a.charged_usd IS NULL THEN 'reservation'
                     WHEN a.result->>'cost_source' = 'gateway' THEN 'provider_reported'
                     ELSE 'price_table' END
               AND l.hold_id IS NOT DISTINCT FROM coalesce(p_hold, l.hold_id))
     ORDER BY a.started_at
     LIMIT p_limit
  LOOP
    v_feature := 'ai_visibility.scan';
    IF r.cost_state = 'confirmed_not_dispatched' THEN
      v_src := 'none'; v_actual := 0; v_accounted := 0;
    ELSIF r.cost_state = 'reconciliation_conflict' OR r.charged_usd IS NULL THEN
      -- A disputed cost is not a known cost. Hold it at the reservation so it stays in the queue.
      v_src := 'reservation'; v_actual := NULL; v_accounted := r.reserved_usd;
    ELSE
      v_src := CASE WHEN r.reported_source = 'gateway' THEN 'provider_reported' ELSE 'price_table' END;
      v_actual := r.charged_usd; v_accounted := r.charged_usd;
    END IF;
    INSERT INTO spend_ledger(brand_key, feature, hold_id, job_id, source_ref, provider, endpoint, units,
                             estimate_usd, actual_usd, accounted_usd, cost_source, occurred_at, meta,
                             subject_kind, subject_id, answer_ref)
    VALUES (r.brand_key, 'ai_visibility.scan', p_hold, NULL,
            'probe_attempt:' || r.observation_id || ':' || r.attempt_no,
            r.gateway, 'probe:' || r.engine, 1, r.reserved_usd, v_actual, v_accounted, v_src,
            coalesce(r.finished_at, r.started_at),
            jsonb_build_object('engine', r.engine, 'attempt_no', r.attempt_no, 'cost_state', r.cost_state,
                               'reported_source', r.reported_source),
            'scan_job', r.job_id::text, r.observation_id)
    ON CONFLICT (source_ref) DO UPDATE SET
      actual_usd = excluded.actual_usd, accounted_usd = excluded.accounted_usd,
      cost_source = excluded.cost_source, meta = excluded.meta,
      hold_id = coalesce(excluded.hold_id, spend_ledger.hold_id);
    v := v + 1;
  END LOOP;
  RETURN v;
END $$;

-- Periodic sync for scans with no open accounting hold (legacy, scheduled, operator scans,
-- and reconciliation changes after settlement).
CREATE OR REPLACE FUNCTION public.sync_probe_attempt_costs(p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE sql SET search_path = public AS $$
  SELECT f03_upsert_attempt_rows(NULL, NULL, p_limit);
$$;

-- Settle a scan's accounting hold (created by F09) once the scan is terminal.
CREATE OR REPLACE FUNCTION public.settle_scan_hold(p_job uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE h spend_holds; v_status text; v_sum numeric; v_unknown boolean; v_rows integer; r record;
BEGIN
  SELECT * INTO h FROM spend_holds
   WHERE subject_kind = 'scan_job' AND subject_id = p_job::text AND status IN ('held','expired')
   ORDER BY created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('settled', false, 'reason', 'no_hold'); END IF;
  SELECT status INTO v_status FROM scan_jobs WHERE id = p_job;
  IF NOT FOUND THEN
    -- release_spend only updates a hold that is still 'held' (041:247-254). An expired hold
    -- already has its hold:<id> reservation row, so it must be closed here instead: otherwise
    -- settle_finished_scan_holds re-selects it on every run and starves real settlements.
    IF h.status = 'expired' THEN
      DELETE FROM spend_ledger WHERE source_ref = 'hold:' || h.id AND cost_source = 'reservation';
      UPDATE spend_holds SET status = 'settled', actual_usd = 0, closed_at = now() WHERE id = h.id;
    ELSE
      PERFORM release_spend(h.id, 'scan_missing');
    END IF;
    RETURN jsonb_build_object('settled', false, 'reason', 'scan_missing');
  END IF;
  IF v_status NOT IN ('complete','failed','cancelled') THEN
    RETURN jsonb_build_object('settled', false, 'reason', 'scan_running');
  END IF;
  IF h.status = 'expired' THEN
    DELETE FROM spend_ledger WHERE source_ref = 'hold:' || h.id AND cost_source = 'reservation';
  END IF;
  v_rows := f03_upsert_attempt_rows(p_job, h.id, 100000);
  SELECT coalesce(sum(actual_usd), 0), bool_or(cost_source = 'reservation')
    INTO v_sum, v_unknown
    FROM spend_ledger WHERE subject_kind = 'scan_job' AND subject_id = p_job::text
     AND source_ref LIKE 'probe_attempt:%';
  UPDATE spend_holds SET status = 'settled',
         actual_usd = CASE WHEN coalesce(v_unknown, false) THEN NULL ELSE v_sum END,
         closed_at = now() WHERE id = h.id;
  -- F09 creates one hold per scan. If a second slipped through, close it at zero too: attempt
  -- rows are the source of truth, and an open sibling would stay in f01_committed_usd forever.
  FOR r IN SELECT id, status FROM spend_holds
            WHERE subject_kind = 'scan_job' AND subject_id = p_job::text
              AND status IN ('held','expired') AND id <> h.id LOOP
    IF r.status = 'expired' THEN
      DELETE FROM spend_ledger WHERE source_ref = 'hold:' || r.id AND cost_source = 'reservation';
    END IF;
    UPDATE spend_holds SET status = 'settled', actual_usd = 0, release_reason = 'duplicate_scan_hold',
           closed_at = now() WHERE id = r.id;
  END LOOP;
  RETURN jsonb_build_object('settled', true, 'rows', v_rows, 'actual_usd', v_sum,
                            'unknown', coalesce(v_unknown, false));
END $$;

CREATE OR REPLACE FUNCTION public.settle_finished_scan_holds(p_limit integer DEFAULT 50)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r record; v integer := 0;
BEGIN
  -- One row per job, so a second hold on one scan cannot hide behind a settled sibling.
  FOR r IN
    WITH candidate AS (
      SELECT h.created_at,
             -- CASE guards the cast: one malformed subject_id must not break the whole sweep.
             CASE WHEN h.subject_id ~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
                  THEN h.subject_id::uuid END AS job_id
        FROM spend_holds h
       WHERE h.subject_kind = 'scan_job' AND h.status IN ('held','expired')
    )
    SELECT c.job_id FROM candidate c
      LEFT JOIN scan_jobs j ON j.id = c.job_id
     WHERE c.job_id IS NOT NULL AND (j.id IS NULL OR j.status IN ('complete','failed','cancelled'))
     ORDER BY c.created_at LIMIT p_limit
  LOOP
    -- Count settles, not candidates: costs.sync reports this number as `settled`. There is no
    -- "already settled" skip, so a job that somehow holds two open holds settles one per run
    -- instead of stranding the older one as 'held' in f01_committed_usd for ever.
    IF coalesce((settle_scan_hold(r.job_id)->>'settled')::boolean, false) THEN v := v + 1; END IF;
  END LOOP;
  RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.resolve_cost_reconciliation(
  p_id uuid, p_resolution text, p_note text, p_by text)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE c cost_reconciliations; l spend_ledger;
BEGIN
  IF p_resolution NOT IN ('accepted','price_updated','not_billed') OR length(coalesce(trim(p_note), '')) < 10 THEN
    RAISE EXCEPTION 'resolution and a note of at least 10 characters are required'; END IF;
  SELECT * INTO c FROM cost_reconciliations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reconciliation not found'; END IF;
  IF c.resolution IS NOT NULL THEN RETURN jsonb_build_object('resolved', false, 'resolution', c.resolution); END IF;
  SELECT * INTO l FROM spend_ledger WHERE id = c.ledger_id FOR UPDATE;
  IF p_resolution = 'not_billed' THEN
    IF l.source_ref LIKE 'probe_attempt:%' THEN
      RAISE EXCEPTION 'probe attempts are reconciled with reconcile_probe_dispatch'; END IF;
    IF l.cost_source <> 'reservation' THEN RAISE EXCEPTION 'only unknown costs can be marked not billed'; END IF;
    UPDATE spend_ledger SET actual_usd = 0, accounted_usd = 0, cost_source = 'none',
           meta = meta || jsonb_build_object('reconciled', 'not_billed') WHERE id = l.id;
  END IF;
  UPDATE cost_reconciliations SET resolution = p_resolution, resolved_at = now(), resolved_by = left(p_by, 60),
         note = left(p_note, 500) WHERE id = p_id;
  RETURN jsonb_build_object('resolved', true);
END $$;

-- Typical engine cost from measured attempts (no tenant detail is exposed: per-engine aggregates).
CREATE OR REPLACE FUNCTION public.engine_cost_stats(p_days integer DEFAULT 30)
RETURNS TABLE(engine text, samples integer, median_usd numeric, p90_usd numeric)
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT o.engine, count(*)::integer,
         round(percentile_cont(0.5) WITHIN GROUP (ORDER BY a.charged_usd)::numeric, 6),
         round(percentile_cont(0.9) WITHIN GROUP (ORDER BY a.charged_usd)::numeric, 6)
     FROM probe_attempts a JOIN probe_observations o ON o.id = a.observation_id
    WHERE o.purpose = 'scan' AND a.cost_state = 'measured' AND a.charged_usd IS NOT NULL
      AND a.started_at >= now() - make_interval(days => p_days)
    GROUP BY o.engine HAVING count(*) >= 20;
$$;

-- Bulk accept for the unknown-cost backlog. Every attempt whose provider never reported a cost
-- opens one row, so at scan volumes the queue cannot be drained one row at a time. This resolves
-- only 'unknown_cost' rows and only as 'accepted': it never rewrites a ledger amount, so it cannot
-- be used to zero spend (that is 'not_billed', which stays one row at a time and is refused for
-- probe attempts).
CREATE OR REPLACE FUNCTION public.resolve_unknown_cost_backlog(
  p_before timestamptz, p_note text, p_by text, p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  IF length(coalesce(trim(p_note), '')) < 10 THEN
    RAISE EXCEPTION 'resolution and a note of at least 10 characters are required'; END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'bulk resolve limit must be 1..5000'; END IF;
  WITH open_rows AS (
    SELECT id FROM cost_reconciliations
     WHERE kind = 'unknown_cost' AND resolution IS NULL AND created_at < p_before
     ORDER BY created_at LIMIT p_limit FOR UPDATE)
  UPDATE cost_reconciliations c SET resolution = 'accepted', resolved_at = now(),
         resolved_by = left(p_by, 60), note = left(p_note, 500)
    FROM open_rows o WHERE c.id = o.id;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;

CREATE OR REPLACE FUNCTION public.prune_cost_reconciliations(p_before timestamptz, p_limit integer DEFAULT 5000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  WITH old AS (SELECT id FROM cost_reconciliations WHERE resolution IS NOT NULL AND resolved_at < p_before
                ORDER BY resolved_at LIMIT p_limit)
  DELETE FROM cost_reconciliations c USING old WHERE c.id = old.id;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;

REVOKE ALL ON FUNCTION public.f03_ledger_fill(), public.f03_ledger_reconcile(),
  public.f03_upsert_attempt_rows(uuid,uuid,integer), public.sync_probe_attempt_costs(integer),
  public.settle_scan_hold(uuid), public.settle_finished_scan_holds(integer),
  public.resolve_cost_reconciliation(uuid,text,text,text), public.engine_cost_stats(integer),
  public.resolve_unknown_cost_backlog(timestamptz,text,text,integer),
  public.prune_cost_reconciliations(timestamptz,integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.f03_upsert_attempt_rows(uuid,uuid,integer),
  public.sync_probe_attempt_costs(integer), public.settle_scan_hold(uuid),
  public.settle_finished_scan_holds(integer), public.resolve_cost_reconciliation(uuid,text,text,text),
  public.engine_cost_stats(integer), public.resolve_unknown_cost_backlog(timestamptz,text,text,integer),
  public.prune_cost_reconciliations(timestamptz,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
