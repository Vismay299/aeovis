-- Allow one owned QA workspace and deliberate canaries while ordinary dispatch
-- remains paused. All existing fencing, uncertainty and shared budget rules apply.
ALTER TABLE probe_dispatch_control ADD COLUMN IF NOT EXISTS canaries_allowed boolean NOT NULL DEFAULT false;
ALTER TABLE probe_dispatch_control ADD COLUMN IF NOT EXISTS brand_allowlist text[] NOT NULL DEFAULT '{}';

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
  IF o.state='leased' AND o.lease_until<=at_time THEN
    UPDATE probe_attempts SET dispatch_state='unknown' WHERE observation_id=o.id AND lease_token=o.lease_token;
    UPDATE probe_observations SET state='ambiguous',reason='dispatch_unknown',lease_until=NULL WHERE id=o.id;
    RETURN jsonb_build_object('granted',false,'reason','dispatch_unknown');
  END IF;
  IF o.state NOT IN ('pending','retry') THEN
    RETURN jsonb_build_object('granted',false,'reason',o.state);
  END IF;
  IF NOT EXISTS(SELECT 1 FROM probe_dispatch_control p WHERE p.singleton=true AND
    (NOT p.paused OR (p.canaries_allowed AND o.purpose='canary') OR EXISTS(
      SELECT 1 FROM scan_jobs j WHERE j.id=o.job_id AND j.brand_key=ANY(p.brand_allowlist)))) THEN
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
  -- A dispatch must have its complete request/body deadline before lease expiry.
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
  SELECT coalesce(sum(coalesce(a.charged_usd,a.reserved_usd)),0) INTO scan_spend
    FROM probe_attempts a JOIN probe_observations x ON x.id=a.observation_id
    WHERE (o.job_id IS NOT NULL AND x.job_id=o.job_id)
      OR (o.purpose='canary' AND x.context->>'budget_scope'=o.context->>'budget_scope');
  IF o.purpose='canary' AND coalesce((o.context->>'max_requests')::integer,0) <
    coalesce((SELECT sum((x.context->>'request_units')::integer) FROM probe_attempts a JOIN probe_observations x ON x.id=a.observation_id
      WHERE x.context->>'budget_scope'=o.context->>'budget_scope'),0)+(o.context->>'request_units')::integer THEN
    UPDATE probe_observations SET state='blocked',reason='request_budget_refused' WHERE id=o.id;
    RETURN jsonb_build_object('granted',false,'reason','request_budget_refused');
  END IF;
  -- Include sourcing and legacy finalized scan charges. Completed ledger jobs
  -- are excluded from this extra sum to avoid charging their probes twice.
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
  UPDATE probe_observations SET state='leased',attempt_count=attempt_count+1,lease_token=token,
    lease_until=at_time+make_interval(secs=>p_lease_seconds),reason=NULL,unknown_cost_calls=unknown_cost_calls+1 WHERE id=o.id;
  INSERT INTO probe_attempts(observation_id,attempt_no,lease_token,reserved_usd,started_at)
    VALUES(o.id,o.attempt_count+1,token,p_reserve,at_time);
  RETURN jsonb_build_object('granted',true,'lease_token',token,'attempt_no',o.attempt_count+1,
    'lease_until',at_time+make_interval(secs=>p_lease_seconds));
END $$;

CREATE OR REPLACE FUNCTION set_probe_rollout(p_paused boolean,p_canaries boolean,p_brands text[]) RETURNS jsonb
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE c probe_dispatch_control;
BEGIN
 IF p_paused IS NULL OR p_canaries IS NULL OR p_brands IS NULL OR cardinality(p_brands)>1
   OR EXISTS(SELECT 1 FROM unnest(p_brands) b WHERE b IS NULL OR NOT EXISTS(SELECT 1 FROM customer_brands WHERE brand_key=b AND is_active))
 THEN RAISE EXCEPTION 'invalid owned rollout scope'; END IF;
 PERFORM pg_advisory_xact_lock(270027);
 UPDATE probe_dispatch_control SET paused=p_paused,canaries_allowed=p_canaries,brand_allowlist=p_brands WHERE singleton=true RETURNING * INTO c;
 IF NOT FOUND THEN RAISE EXCEPTION 'dispatch control missing';END IF;
 RETURN to_jsonb(c);
END $$;
REVOKE ALL ON FUNCTION set_probe_rollout(boolean,boolean,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION set_probe_rollout(boolean,boolean,text[]) TO service_role;
NOTIFY pgrst,'reload schema';
