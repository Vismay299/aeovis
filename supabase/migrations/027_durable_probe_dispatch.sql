-- P0 R01/R02: service-only dispatch ledger. No customer can claim global
-- provider budgets/circuits. Additive; legacy prompt_results stay readable.
CREATE TABLE IF NOT EXISTS probe_observations (
  id text PRIMARY KEY,
  job_id uuid REFERENCES scan_jobs(id),
  purpose text NOT NULL CHECK (purpose IN ('scan','canary')),
  engine text NOT NULL,
  query text NOT NULL,
  context jsonb NOT NULL,
  config_version text NOT NULL,
  circuit_key text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN
    ('pending','leased','retry','answered','valid_no_aio','failed','ambiguous','blocked')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL,
  lease_token uuid,
  lease_until timestamptz,
  reason text,
  result jsonb,
  observed_at timestamptz,
  total_cost numeric NOT NULL DEFAULT 0,
  unknown_cost_calls integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id, engine, query)
);
CREATE TABLE IF NOT EXISTS probe_attempts (
  observation_id text NOT NULL REFERENCES probe_observations(id),
  attempt_no integer NOT NULL,
  lease_token uuid NOT NULL UNIQUE,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  -- A claim commits intent BEFORE the external call. A crash at either side
  -- of that call is ambiguous; none of our offered adapters promises idempotency.
  dispatch_state text NOT NULL DEFAULT 'intent' CHECK (dispatch_state IN ('intent','recorded','unknown','historical')),
  reserved_usd numeric NOT NULL CHECK (reserved_usd >= 0),
  charged_usd numeric CHECK (charged_usd >= 0),
  cost_state text NOT NULL DEFAULT 'unknown_billed',
  failure jsonb,
  result jsonb,
  PRIMARY KEY(observation_id, attempt_no)
);
CREATE TABLE IF NOT EXISTS probe_late_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id text NOT NULL REFERENCES probe_observations(id),
  lease_token uuid NOT NULL UNIQUE,
  received_at timestamptz NOT NULL DEFAULT now(),
  result jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_dispatch_circuits (
  circuit_key text PRIMARY KEY,
  open_until timestamptz,
  failure jsonb,
  recovery_token uuid,
  recovery_until timestamptz
);
CREATE INDEX IF NOT EXISTS probe_observations_job_idx ON probe_observations(job_id, state);
CREATE INDEX IF NOT EXISTS probe_attempts_started_idx ON probe_attempts(started_at);
ALTER TABLE probe_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE probe_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE probe_late_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_dispatch_circuits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON probe_observations, probe_attempts, probe_late_receipts, provider_dispatch_circuits FROM PUBLIC, anon, authenticated;
GRANT ALL ON probe_observations, probe_attempts, probe_late_receipts, provider_dispatch_circuits TO service_role;

CREATE OR REPLACE FUNCTION seed_probe_observations(p_rows jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r jsonb; prior probe_observations; inserted_count integer; h jsonb;
BEGIN
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    INSERT INTO probe_observations(id,job_id,purpose,engine,query,context,config_version,circuit_key,deadline_at)
    VALUES(r->>'id',(r->>'job_id')::uuid,r->>'purpose',r->>'engine',r->>'query',r->'context',
      r->>'config_version',r->>'circuit_key',(r->>'deadline_at')::timestamptz)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS inserted_count = ROW_COUNT;
    h := r->'historical';
    IF inserted_count=1 AND h IS NOT NULL AND h<>'null'::jsonb THEN
      UPDATE probe_observations SET attempt_count=1,state=h->>'state',result=h->'result',
        next_attempt_at=coalesce((h->>'next_at')::timestamptz,now()),reason=h->'failure'->>'kind',
        total_cost=coalesce((h->'result'->>'cost')::numeric,0),
        unknown_cost_calls=CASE WHEN h->'result'->>'cost' IS NULL THEN 1 ELSE 0 END
        WHERE id=r->>'id';
      INSERT INTO probe_attempts(observation_id,attempt_no,lease_token,dispatch_state,reserved_usd,charged_usd,cost_state,failure,result)
      VALUES(r->>'id',1,gen_random_uuid(),'historical',coalesce((h->>'reserve')::numeric,1),(h->'result'->>'cost')::numeric,
        CASE WHEN h->'result'->>'cost' IS NULL THEN 'unknown_billed' ELSE 'measured' END,h->'failure',h->'result');
    END IF;
    SELECT * INTO prior FROM probe_observations WHERE id=r->>'id';
    IF NOT FOUND OR prior.context IS DISTINCT FROM r->'context'
      OR prior.engine<>r->>'engine' OR prior.query<>r->>'query'
      OR prior.config_version<>r->>'config_version' OR prior.circuit_key<>r->>'circuit_key'
      OR prior.job_id IS DISTINCT FROM (r->>'job_id')::uuid OR prior.purpose<>r->>'purpose' THEN
      RAISE EXCEPTION 'immutable observation identity mismatch';
    END IF;
  END LOOP;
END $$;

CREATE TABLE IF NOT EXISTS provider_canary_budgets (
  scope text PRIMARY KEY, max_requests integer NOT NULL CHECK(max_requests>0), max_spend_usd numeric NOT NULL CHECK(max_spend_usd>0)
);
ALTER TABLE provider_canary_budgets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON provider_canary_budgets FROM PUBLIC,anon,authenticated;
GRANT ALL ON provider_canary_budgets TO service_role;

CREATE TABLE IF NOT EXISTS probe_dispatch_control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), paused boolean NOT NULL DEFAULT false
);
INSERT INTO probe_dispatch_control(singleton) VALUES(true) ON CONFLICT DO NOTHING;
ALTER TABLE probe_dispatch_control ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON probe_dispatch_control FROM PUBLIC,anon,authenticated;
GRANT ALL ON probe_dispatch_control TO service_role;

-- Serialize short authorization/settlement transactions, never the network.
-- This deliberately favors correctness at current scan scale over throughput.
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
  IF (SELECT paused FROM probe_dispatch_control WHERE singleton=true) IS DISTINCT FROM false THEN
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

-- Atomic completion + legacy report projection. No gap between a successful
-- attempt commit and prompt_results persistence. Duplicate delivery is a no-op.
CREATE OR REPLACE FUNCTION finish_probe_dispatch(p_id text,p_token uuid,p_result jsonb,
  p_state text,p_failure jsonb DEFAULT NULL,p_next_at timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE o probe_observations; a probe_attempts; at_time timestamptz; price numeric; receipt_count integer;
BEGIN
  IF p_state='retry' AND p_next_at IS NULL THEN RAISE EXCEPTION 'retry requires a due time'; END IF;
  IF p_state NOT IN ('answered','valid_no_aio','failed','retry') THEN RAISE EXCEPTION 'invalid result state'; END IF;
  PERFORM pg_advisory_xact_lock(270027);
  at_time := clock_timestamp();
  SELECT * INTO o FROM probe_observations WHERE id=p_id FOR UPDATE;
  SELECT * INTO a FROM probe_attempts WHERE observation_id=p_id AND lease_token=p_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'attempt token not found'; END IF;
  IF a.dispatch_state='recorded' THEN RETURN jsonb_build_object('accepted',true,'duplicate',true); END IF;
  IF o.state<>'leased' OR o.lease_token<>p_token OR o.lease_until<=at_time THEN
    INSERT INTO probe_late_receipts(observation_id,lease_token,result) VALUES(p_id,p_token,p_result) ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS receipt_count = ROW_COUNT;
    IF receipt_count=1 AND a.cost_state='confirmed_not_dispatched' THEN
      -- A real late receipt contradicts the operator's no-dispatch assertion.
      -- Restore cost uncertainty; do not erase the newer valid observation.
      UPDATE probe_attempts SET charged_usd=NULL,cost_state='reconciliation_conflict'
        WHERE observation_id=p_id AND lease_token=p_token;
      UPDATE probe_observations SET unknown_cost_calls=unknown_cost_calls+1 WHERE id=p_id;
    END IF;
    UPDATE probe_attempts SET dispatch_state='unknown' WHERE observation_id=p_id AND lease_token=p_token;
    IF o.lease_token=p_token THEN UPDATE probe_observations SET state='ambiguous',reason='late_result' WHERE id=p_id; END IF;
    RETURN jsonb_build_object('accepted',false,'reason','stale_lease');
  END IF;
  price := (p_result->>'cost')::numeric;
  IF price<0 THEN RAISE EXCEPTION 'invalid measured cost'; END IF;
  UPDATE probe_attempts SET dispatch_state='recorded',finished_at=at_time,result=p_result,failure=p_failure,
    charged_usd=price,cost_state=CASE WHEN price IS NULL THEN 'unknown_billed' ELSE 'measured' END
    WHERE observation_id=p_id AND lease_token=p_token;
  UPDATE probe_observations SET state=p_state,next_attempt_at=coalesce(p_next_at,at_time),
    result=p_result,reason=p_failure->>'kind',observed_at=at_time,lease_until=NULL,
    total_cost=total_cost+coalesce(price,0),unknown_cost_calls=unknown_cost_calls-CASE WHEN price IS NULL THEN 0 ELSE 1 END WHERE id=p_id;
  IF coalesce((p_failure->>'opens_circuit')::boolean,false) THEN
    UPDATE provider_dispatch_circuits SET open_until=at_time+interval '15 minutes',failure=p_failure,
      recovery_token=NULL,recovery_until=NULL WHERE circuit_key=o.circuit_key;
  ELSIF o.purpose='canary' AND p_state IN ('answered','valid_no_aio') THEN
    UPDATE provider_dispatch_circuits SET open_until=NULL,failure=NULL,recovery_token=NULL,recovery_until=NULL
      WHERE circuit_key=o.circuit_key AND (recovery_token IS NULL OR recovery_token=p_token);
  ELSIF o.purpose='canary' THEN
    UPDATE provider_dispatch_circuits SET open_until=at_time+interval '15 minutes',recovery_token=NULL,recovery_until=NULL
      WHERE circuit_key=o.circuit_key AND recovery_token=p_token;
  END IF;
  IF o.job_id IS NOT NULL THEN
    INSERT INTO prompt_results(job_id,brand,query,engine,answered,mentioned,brand_cited,intent,is_branded_query,answer_text,raw,position,sentiment)
    SELECT o.job_id,j.checkpoint->>'prompt_key',o.query,o.engine,
      (p_result->>'answer_present')::boolean,(p_result->>'brand_mentioned_in_text')::boolean,
      (p_result->>'brand_cited')::boolean,p_result->>'intent_tier',(p_result->>'is_branded_query')::boolean,
      p_result->>'text',p_result,(b->>'position')::numeric,(b->>'sentiment')::integer
    FROM scan_jobs j LEFT JOIN LATERAL (
      SELECT value AS b FROM jsonb_array_elements(coalesce(p_result->'brands','[]'::jsonb)) WHERE (value->>'is_self')::boolean LIMIT 1
    ) labels ON true WHERE j.id=o.job_id
    ON CONFLICT(job_id,engine,query) DO UPDATE SET answered=excluded.answered,mentioned=excluded.mentioned,
      brand_cited=excluded.brand_cited,intent=excluded.intent,is_branded_query=excluded.is_branded_query,
      answer_text=excluded.answer_text,raw=excluded.raw,position=excluded.position,sentiment=excluded.sentiment;
  END IF;
  RETURN jsonb_build_object('accepted',true,'duplicate',false);
END $$;
REVOKE ALL ON FUNCTION seed_probe_observations(jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION claim_probe_dispatch(text,numeric,numeric,numeric,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION finish_probe_dispatch(text,uuid,jsonb,text,jsonb,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION seed_probe_observations(jsonb),claim_probe_dispatch(text,numeric,numeric,numeric,integer),
  finish_probe_dispatch(text,uuid,jsonb,text,jsonb,timestamptz) TO service_role;

CREATE OR REPLACE FUNCTION block_probe_dispatch(p_id text,p_reason text) RETURNS void
LANGUAGE sql SET search_path=public AS $$
  UPDATE probe_observations SET state='blocked',reason=p_reason
  WHERE id=p_id AND state IN ('pending','retry');
$$;
REVOKE ALL ON FUNCTION block_probe_dispatch(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION block_probe_dispatch(text,text) TO service_role;

CREATE TABLE IF NOT EXISTS probe_reconciliations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), observation_id text NOT NULL REFERENCES probe_observations(id),
  lease_token uuid NOT NULL, action text NOT NULL, note text NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE probe_reconciliations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON probe_reconciliations FROM PUBLIC,anon,authenticated;
GRANT ALL ON probe_reconciliations TO service_role;
CREATE OR REPLACE FUNCTION reconcile_probe_dispatch(p_id text,p_token uuid,p_action text,p_note text) RETURNS void
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE o probe_observations;
BEGIN
  IF p_action NOT IN ('confirm_not_dispatched','close_failed') OR length(trim(p_note))<20 THEN
    RAISE EXCEPTION 'explicit reconciliation decision and evidence note required'; END IF;
  PERFORM pg_advisory_xact_lock(270027);
  SELECT * INTO o FROM probe_observations WHERE id=p_id FOR UPDATE;
  IF o.lease_token IS DISTINCT FROM p_token OR NOT (o.state='ambiguous' OR (o.state='leased' AND o.lease_until<clock_timestamp())) THEN
    RAISE EXCEPTION 'only the current ambiguous dispatch can be reconciled'; END IF;
  INSERT INTO probe_reconciliations(observation_id,lease_token,action,note) VALUES(p_id,p_token,p_action,p_note);
  IF p_action='confirm_not_dispatched' THEN
    -- This is an operator assertion based on evidence, never an automatic retry.
    UPDATE probe_attempts SET charged_usd=0,cost_state='confirmed_not_dispatched',dispatch_state='unknown'
      WHERE observation_id=p_id AND lease_token=p_token;
    UPDATE probe_observations SET state='retry',next_attempt_at=clock_timestamp(),lease_until=NULL,
      unknown_cost_calls=unknown_cost_calls-1,reason='confirmed_not_dispatched' WHERE id=p_id;
  ELSE
    UPDATE probe_observations SET state='failed',lease_until=NULL,reason='unresolved_dispatch_cost' WHERE id=p_id;
  END IF;
END $$;
REVOKE ALL ON FUNCTION reconcile_probe_dispatch(text,uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION reconcile_probe_dispatch(text,uuid,text,text) TO service_role;


CREATE OR REPLACE FUNCTION renew_probe_dispatch(p_id text,p_token uuid,p_seconds integer DEFAULT 120) RETURNS boolean
LANGUAGE plpgsql SET search_path=public AS $$
DECLARE renewed boolean;
BEGIN
  IF p_seconds<1 OR p_seconds>180 THEN RAISE EXCEPTION 'invalid lease duration'; END IF;
  UPDATE probe_observations SET lease_until=least(deadline_at,clock_timestamp()+make_interval(secs=>p_seconds))
    WHERE id=p_id AND state='leased' AND lease_token=p_token AND lease_until>clock_timestamp()
      AND deadline_at>clock_timestamp()
    RETURNING true INTO renewed;
  RETURN coalesce(renewed,false);
END $$;
REVOKE ALL ON FUNCTION renew_probe_dispatch(text,uuid,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION renew_probe_dispatch(text,uuid,integer) TO service_role;

-- Refresh PostgREST RPC and foreign-key relation discovery after application.
NOTIFY pgrst, 'reload schema';
