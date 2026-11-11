-- F11: Prompt Explorer answers are probe_observations with purpose 'explore', claimed through
-- claim_probe_dispatch. Pause, the one-brand allowlist, circuits, attempt/deadline limits and the
-- global day cap apply unchanged. claim_probe_dispatch below is 035's body with four changes,
-- each marked "F11". finish_probe_dispatch and every other function are unchanged.

-- No ON DELETE CASCADE: probe_attempts reference observations without cascade (027:28), so a
-- cascading brand delete would fail. Workspace deletion keeps P0 history, as scans do today.
ALTER TABLE public.probe_observations ADD COLUMN IF NOT EXISTS brand_key text
  REFERENCES public.customer_brands(brand_key);
COMMENT ON COLUMN public.probe_observations.brand_key IS
  'Workspace of an explore observation (purpose = explore). NULL for scan and canary rows, whose workspace is scan_jobs.brand_key.';

DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.probe_observations'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%purpose%' AND pg_get_constraintdef(oid) LIKE '%canary%' LOOP
    EXECUTE format('ALTER TABLE public.probe_observations DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.probe_observations ADD CONSTRAINT probe_observations_purpose_check
  CHECK (purpose IN ('scan','canary','explore'));
ALTER TABLE public.probe_observations DROP CONSTRAINT IF EXISTS probe_observations_explore_shape;
ALTER TABLE public.probe_observations ADD CONSTRAINT probe_observations_explore_shape CHECK (
  purpose <> 'explore' OR (job_id IS NULL AND brand_key IS NOT NULL
    AND (context->>'explore_run_id') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));
CREATE INDEX IF NOT EXISTS probe_observations_explore_run_idx
  ON public.probe_observations ((context->>'explore_run_id')) WHERE purpose = 'explore';
CREATE INDEX IF NOT EXISTS probe_observations_explore_reuse_idx
  ON public.probe_observations (brand_key, engine, (context->>'prompt_hash'), observed_at DESC)
  WHERE purpose = 'explore' AND state = 'answered';

CREATE OR REPLACE FUNCTION public.seed_explore_observations(p_rows jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r jsonb; prior probe_observations;
BEGIN
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF r->>'purpose' IS DISTINCT FROM 'explore' OR (r->>'job_id') IS NOT NULL THEN
      RAISE EXCEPTION 'explore rows only'; END IF;
    INSERT INTO probe_observations(id, job_id, purpose, engine, query, context, config_version, circuit_key,
                                   deadline_at, brand_key)
    VALUES (r->>'id', NULL, 'explore', r->>'engine', r->>'query', r->'context', r->>'config_version',
            r->>'circuit_key', (r->>'deadline_at')::timestamptz, r->>'brand_key')
    ON CONFLICT DO NOTHING;
    SELECT * INTO prior FROM probe_observations WHERE id = r->>'id';
    IF NOT FOUND OR prior.purpose <> 'explore' OR prior.context IS DISTINCT FROM r->'context'
       OR prior.engine <> r->>'engine' OR prior.query <> r->>'query'
       OR prior.config_version <> r->>'config_version' OR prior.circuit_key <> r->>'circuit_key'
       OR prior.brand_key IS DISTINCT FROM r->>'brand_key' THEN
      RAISE EXCEPTION 'immutable observation identity mismatch';
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION claim_probe_dispatch(p_id text, p_reserve numeric,
  p_scan_cap numeric DEFAULT NULL, p_day_cap numeric DEFAULT NULL,
  p_lease_seconds integer DEFAULT 120) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE o probe_observations; c provider_dispatch_circuits; b provider_canary_budgets; token uuid := gen_random_uuid();
  at_time timestamptz; scan_spend numeric; day_spend numeric;
BEGIN
  IF p_reserve IS NULL OR p_reserve<=0 OR p_lease_seconds<1 OR p_lease_seconds>180
    OR p_scan_cap<0 OR p_day_cap<0 THEN RAISE EXCEPTION 'invalid dispatch budget'; END IF;
  PERFORM pg_advisory_xact_lock(270027);
  at_time := clock_timestamp();
  SELECT * INTO o FROM probe_observations WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'observation not found'; END IF;
  -- F11 (1/4): an explore claim always carries the run's approved maximum.
  IF o.purpose='explore' AND p_scan_cap IS NULL THEN RAISE EXCEPTION 'explore requires an approved run cap'; END IF;
  IF o.state='leased' AND o.lease_until<=at_time THEN
    UPDATE probe_attempts SET dispatch_state='unknown' WHERE observation_id=o.id AND lease_token=o.lease_token;
    UPDATE probe_observations SET state='ambiguous',reason='dispatch_unknown',lease_until=NULL WHERE id=o.id;
    RETURN jsonb_build_object('granted',false,'reason','dispatch_unknown');
  END IF;
  IF o.state NOT IN ('pending','retry') THEN
    RETURN jsonb_build_object('granted',false,'reason',o.state);
  END IF;
  -- F11 (2/4): an explore row is allow-listed by its own brand_key (it has no scan job).
  IF NOT EXISTS(SELECT 1 FROM probe_dispatch_control p WHERE p.singleton=true AND
    (NOT p.paused OR (p.canaries_allowed AND o.purpose='canary')
      OR (o.purpose='explore' AND o.brand_key=ANY(p.brand_allowlist))
      OR EXISTS(SELECT 1 FROM scan_jobs j WHERE j.id=o.job_id AND j.brand_key=ANY(p.brand_allowlist)))) THEN
    UPDATE probe_observations SET state='blocked',reason='dispatch_paused' WHERE id=o.id;
    RETURN jsonb_build_object('granted',false,'reason','dispatch_paused');
  END IF;
  IF o.next_attempt_at>at_time THEN
    RETURN jsonb_build_object('granted',false,'reason','not_due','next_attempt_at',o.next_attempt_at);
  END IF;
  IF o.attempt_count>=3 OR o.deadline_at<=at_time THEN
    UPDATE probe_observations SET state='failed',reason='attempt_or_deadline_limit' WHERE id=o.id;
    RETURN jsonb_build_object('granted',false,'reason','attempt_or_deadline_limit');
  END IF;
  IF at_time + make_interval(secs=>p_lease_seconds) > o.deadline_at THEN
    UPDATE probe_observations SET state='failed',reason='insufficient_deadline' WHERE id=o.id;
    RETURN jsonb_build_object('granted',false,'reason','insufficient_deadline');
  END IF;
  INSERT INTO provider_dispatch_circuits(circuit_key) VALUES(o.circuit_key) ON CONFLICT DO NOTHING;
  SELECT * INTO c FROM provider_dispatch_circuits WHERE circuit_key=o.circuit_key FOR UPDATE;
  IF c.open_until IS NOT NULL THEN
    IF o.purpose<>'canary' OR c.open_until>at_time OR c.recovery_until>at_time THEN
      UPDATE probe_observations SET state='blocked',reason='provider_circuit_open' WHERE id=o.id;
      RETURN jsonb_build_object('granted',false,'reason','provider_circuit_open');
    END IF;
  END IF;
  IF o.purpose='canary' THEN
    INSERT INTO provider_canary_budgets(scope,max_requests,max_spend_usd)
    VALUES(o.context->>'budget_scope',(o.context->>'max_requests')::integer,p_scan_cap) ON CONFLICT DO NOTHING;
    SELECT * INTO b FROM provider_canary_budgets WHERE scope=o.context->>'budget_scope' FOR UPDATE;
    IF b.max_requests<>(o.context->>'max_requests')::integer OR b.max_spend_usd IS DISTINCT FROM p_scan_cap THEN
      RAISE EXCEPTION 'canary shared budget mismatch'; END IF;
  END IF;
  -- F11 (3/4): an explore run's spend is the sum of its own attempts.
  SELECT coalesce(sum(coalesce(a.charged_usd,a.reserved_usd)),0) INTO scan_spend
    FROM probe_attempts a JOIN probe_observations x ON x.id=a.observation_id
    WHERE (o.job_id IS NOT NULL AND x.job_id=o.job_id)
      OR (o.purpose='canary' AND x.context->>'budget_scope'=o.context->>'budget_scope')
      OR (o.purpose='explore' AND x.purpose='explore' AND x.context->>'explore_run_id'=o.context->>'explore_run_id');
  IF o.purpose='canary' AND coalesce((o.context->>'max_requests')::integer,0) <
    coalesce((SELECT sum((x.context->>'request_units')::integer) FROM probe_attempts a JOIN probe_observations x ON x.id=a.observation_id
      WHERE x.context->>'budget_scope'=o.context->>'budget_scope'),0)+(o.context->>'request_units')::integer THEN
    UPDATE probe_observations SET state='blocked',reason='request_budget_refused' WHERE id=o.id;
    RETURN jsonb_build_object('granted',false,'reason','request_budget_refused');
  END IF;
  IF o.job_id IS NOT NULL THEN
    scan_spend := scan_spend+coalesce((o.context->>'sourcing_cost')::numeric,0);
  END IF;
  SELECT coalesce(sum(coalesce(charged_usd,reserved_usd)),0) INTO day_spend
    FROM probe_attempts WHERE started_at >= date_trunc('day',at_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  SELECT day_spend+coalesce(sum((s.raw_results->>'cost_total')::numeric),0) INTO day_spend FROM scans s
    WHERE s.created_at >= date_trunc('day',at_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      AND NOT EXISTS (SELECT 1 FROM scan_jobs j JOIN probe_observations x ON x.job_id=j.id WHERE j.result_id=s.id);
  SELECT day_spend+coalesce(sum(seed_cost),0) INTO day_spend FROM (
    SELECT x.job_id,max(coalesce((x.context->>'sourcing_cost')::numeric,0)) AS seed_cost
      FROM probe_observations x WHERE x.job_id IS NOT NULL
        AND x.created_at >= date_trunc('day',at_time AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' GROUP BY x.job_id
  ) costs;
  IF (p_scan_cap IS NOT NULL AND scan_spend+p_reserve>p_scan_cap)
    OR (p_day_cap IS NOT NULL AND day_spend+p_reserve>p_day_cap) THEN
    UPDATE probe_observations SET state='blocked',reason='spend_reservation_refused' WHERE id=o.id;
    RETURN jsonb_build_object('granted',false,'reason','spend_reservation_refused');
  END IF;
  IF c.open_until IS NOT NULL THEN
    UPDATE provider_dispatch_circuits SET recovery_token=token,recovery_until=at_time+make_interval(secs=>p_lease_seconds)
      WHERE circuit_key=o.circuit_key;
  END IF;
  -- F11 (4/4): none in the grant itself; explore attempts are recorded exactly like scan attempts.
  UPDATE probe_observations SET state='leased',attempt_count=attempt_count+1,lease_token=token,
    lease_until=at_time+make_interval(secs=>p_lease_seconds),reason=NULL,unknown_cost_calls=unknown_cost_calls+1 WHERE id=o.id;
  INSERT INTO probe_attempts(observation_id,attempt_no,lease_token,reserved_usd,started_at)
    VALUES(o.id,o.attempt_count+1,token,p_reserve,at_time);
  RETURN jsonb_build_object('granted',true,'lease_token',token,'attempt_no',o.attempt_count+1,
    'lease_until',at_time+make_interval(secs=>p_lease_seconds));
END $$;

REVOKE ALL ON FUNCTION public.seed_explore_observations(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_explore_observations(jsonb) TO service_role;
REVOKE ALL ON FUNCTION claim_probe_dispatch(text,numeric,numeric,numeric,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION claim_probe_dispatch(text,numeric,numeric,numeric,integer) TO service_role;
NOTIFY pgrst, 'reload schema';
