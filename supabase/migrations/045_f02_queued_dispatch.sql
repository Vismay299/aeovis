-- F02 phase 4: queued (task_post / task_get) answer collection inside the P0 fence.
-- Adds one non-terminal state, 'posted': the claimed attempt was sent and billed at post,
-- and its answer is collected later by free reads. claim_probe_dispatch,
-- finish_probe_dispatch and every other 027/035 function are NOT modified.

DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.probe_observations'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%valid_no_aio%' LOOP
    EXECUTE format('ALTER TABLE public.probe_observations DROP CONSTRAINT %I', c.conname);
  END LOOP;
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'public.probe_attempts'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%historical%' LOOP
    EXECUTE format('ALTER TABLE public.probe_attempts DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
ALTER TABLE public.probe_observations ADD CONSTRAINT probe_observations_state_check CHECK (state IN
  ('pending','leased','retry','posted','answered','valid_no_aio','failed','ambiguous','blocked'));
ALTER TABLE public.probe_attempts ADD CONSTRAINT probe_attempts_dispatch_state_check CHECK (dispatch_state IN
  ('intent','posted','recorded','unknown','historical'));

ALTER TABLE public.probe_attempts ADD COLUMN IF NOT EXISTS provider_task_id text
  CHECK (provider_task_id IS NULL OR length(provider_task_id) BETWEEN 1 AND 200);
ALTER TABLE public.probe_attempts ADD COLUMN IF NOT EXISTS posted_at timestamptz;
ALTER TABLE public.probe_attempts ADD COLUMN IF NOT EXISTS collect_until timestamptz;
COMMENT ON COLUMN public.probe_attempts.provider_task_id IS
  'Provider task id of a queued (posted) attempt, e.g. a DataForSEO task_post id. Billed at post.';
COMMENT ON COLUMN public.probe_attempts.collect_until IS
  'After this time a still-posted attempt is failed as not_collected, keeping its posted cost.';
CREATE UNIQUE INDEX IF NOT EXISTS probe_attempts_provider_task_idx
  ON public.probe_attempts (provider_task_id) WHERE provider_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS probe_observations_posted_idx
  ON public.probe_observations (next_attempt_at) WHERE state = 'posted';

-- A granted, still-leased attempt was accepted by the provider's queue.
-- The post cost is known now (DataForSEO bills task_post), so the attempt is charged now.
CREATE OR REPLACE FUNCTION public.post_probe_dispatch(p_id text, p_token uuid, p_task_id text,
  p_post_cost numeric, p_next_at timestamptz, p_collect_until timestamptz) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE o probe_observations; a probe_attempts; at_time timestamptz; n integer;
BEGIN
  IF p_task_id IS NULL OR length(p_task_id) NOT BETWEEN 1 AND 200 OR p_post_cost IS NULL OR p_post_cost < 0
     OR p_next_at IS NULL OR p_collect_until IS NULL OR p_collect_until <= p_next_at THEN
    RAISE EXCEPTION 'invalid posted task'; END IF;
  PERFORM pg_advisory_xact_lock(270027);
  at_time := clock_timestamp();
  SELECT * INTO o FROM probe_observations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'observation not found'; END IF;
  SELECT * INTO a FROM probe_attempts WHERE observation_id = p_id AND lease_token = p_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'attempt token not found'; END IF;
  IF a.dispatch_state = 'posted' AND a.provider_task_id = p_task_id THEN
    RETURN jsonb_build_object('accepted', true, 'duplicate', true); END IF;
  IF o.state <> 'leased' OR o.lease_token <> p_token OR o.lease_until <= at_time OR a.dispatch_state <> 'intent' THEN
    -- Same fence as finish_probe_dispatch: a post recorded after its lease is a late receipt.
    INSERT INTO probe_late_receipts(observation_id, lease_token, result)
    VALUES (p_id, p_token, jsonb_build_object('provider_task_id', p_task_id, 'post_cost_usd', p_post_cost))
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS n = ROW_COUNT;
    UPDATE probe_attempts SET dispatch_state = 'unknown'
     WHERE observation_id = p_id AND lease_token = p_token AND dispatch_state = 'intent';
    IF o.lease_token = p_token AND o.state = 'leased' THEN
      UPDATE probe_observations SET state = 'ambiguous', reason = 'late_post', lease_until = NULL WHERE id = p_id;
    END IF;
    RETURN jsonb_build_object('accepted', false, 'reason', 'stale_lease', 'late_receipt', n = 1);
  END IF;
  UPDATE probe_attempts SET dispatch_state = 'posted', provider_task_id = p_task_id, posted_at = at_time,
         collect_until = least(p_collect_until, o.deadline_at), charged_usd = p_post_cost, cost_state = 'measured'
   WHERE observation_id = p_id AND lease_token = p_token;
  UPDATE probe_observations SET state = 'posted', lease_until = NULL, next_attempt_at = p_next_at, reason = NULL,
         total_cost = total_cost + p_post_cost, unknown_cost_calls = unknown_cost_calls - 1
   WHERE id = p_id;
  RETURN jsonb_build_object('accepted', true, 'duplicate', false);
END $$;

-- Move a posted row's next free read. No cost, no attempt change.
CREATE OR REPLACE FUNCTION public.reschedule_probe_collection(p_id text, p_token uuid, p_next_at timestamptz)
RETURNS boolean LANGUAGE sql SET search_path = public AS $$
  UPDATE probe_observations SET next_attempt_at = p_next_at
   WHERE id = p_id AND state = 'posted' AND lease_token = p_token AND p_next_at IS NOT NULL
  RETURNING true;
$$;

-- Record a collected (or finally uncollectable) posted attempt. Mirrors finish_probe_dispatch
-- (027:237-267) for a posted attempt: circuit handling and the prompt_results projection are
-- copied verbatim and covered by the collect-projection DB test.
CREATE OR REPLACE FUNCTION public.collect_probe_dispatch(p_id text, p_token uuid, p_result jsonb, p_state text,
  p_failure jsonb DEFAULT NULL, p_next_at timestamptz DEFAULT NULL, p_settled_cost numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE o probe_observations; a probe_attempts; at_time timestamptz; v_cost numeric; v_result jsonb;
BEGIN
  IF p_state NOT IN ('answered','valid_no_aio','failed','retry') THEN RAISE EXCEPTION 'invalid result state'; END IF;
  IF p_state = 'retry' AND p_next_at IS NULL THEN RAISE EXCEPTION 'retry requires a due time'; END IF;
  PERFORM pg_advisory_xact_lock(270027);
  at_time := clock_timestamp();
  SELECT * INTO o FROM probe_observations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'observation not found'; END IF;
  SELECT * INTO a FROM probe_attempts WHERE observation_id = p_id AND lease_token = p_token;
  IF NOT FOUND THEN RAISE EXCEPTION 'attempt token not found'; END IF;
  IF a.dispatch_state = 'recorded' THEN RETURN jsonb_build_object('accepted', true, 'duplicate', true); END IF;
  IF o.state <> 'posted' OR o.lease_token <> p_token OR a.dispatch_state <> 'posted' THEN
    RETURN jsonb_build_object('accepted', false, 'reason', 'not_posted');
  END IF;
  -- A provider refund (e.g. no async AI Overview loaded) may only lower the charge.
  v_cost := CASE WHEN p_settled_cost IS NOT NULL AND p_settled_cost >= 0 AND p_settled_cost <= a.charged_usd
                 THEN p_settled_cost ELSE a.charged_usd END;
  v_result := coalesce(p_result, '{}'::jsonb) || jsonb_build_object('cost', v_cost);
  UPDATE probe_attempts SET dispatch_state = 'recorded', finished_at = at_time, result = v_result,
         failure = p_failure, charged_usd = v_cost
   WHERE observation_id = p_id AND lease_token = p_token;
  UPDATE probe_observations SET state = p_state, next_attempt_at = coalesce(p_next_at, at_time), result = v_result,
         reason = p_failure->>'kind', observed_at = at_time, total_cost = total_cost + (v_cost - a.charged_usd)
   WHERE id = p_id;
  IF coalesce((p_failure->>'opens_circuit')::boolean, false) THEN
    UPDATE provider_dispatch_circuits SET open_until = at_time + interval '15 minutes', failure = p_failure,
           recovery_token = NULL, recovery_until = NULL WHERE circuit_key = o.circuit_key;
  ELSIF o.purpose = 'canary' AND p_state IN ('answered','valid_no_aio') THEN
    UPDATE provider_dispatch_circuits SET open_until = NULL, failure = NULL, recovery_token = NULL, recovery_until = NULL
     WHERE circuit_key = o.circuit_key AND (recovery_token IS NULL OR recovery_token = p_token);
  ELSIF o.purpose = 'canary' THEN
    UPDATE provider_dispatch_circuits SET open_until = at_time + interval '15 minutes', recovery_token = NULL,
           recovery_until = NULL WHERE circuit_key = o.circuit_key AND recovery_token = p_token;
  END IF;
  IF o.job_id IS NOT NULL THEN
    INSERT INTO prompt_results(job_id,brand,query,engine,answered,mentioned,brand_cited,intent,is_branded_query,answer_text,raw,position,sentiment)
    SELECT o.job_id, j.checkpoint->>'prompt_key', o.query, o.engine,
      (v_result->>'answer_present')::boolean, (v_result->>'brand_mentioned_in_text')::boolean,
      (v_result->>'brand_cited')::boolean, v_result->>'intent_tier', (v_result->>'is_branded_query')::boolean,
      v_result->>'text', v_result, (b->>'position')::numeric, (b->>'sentiment')::integer
    FROM scan_jobs j LEFT JOIN LATERAL (
      SELECT value AS b FROM jsonb_array_elements(coalesce(v_result->'brands','[]'::jsonb)) WHERE (value->>'is_self')::boolean LIMIT 1
    ) labels ON true WHERE j.id = o.job_id
    ON CONFLICT(job_id,engine,query) DO UPDATE SET answered=excluded.answered, mentioned=excluded.mentioned,
      brand_cited=excluded.brand_cited, intent=excluded.intent, is_branded_query=excluded.is_branded_query,
      answer_text=excluded.answer_text, raw=excluded.raw, position=excluded.position, sentiment=excluded.sentiment;
  END IF;
  RETURN jsonb_build_object('accepted', true, 'duplicate', false);
END $$;

-- Fail posted attempts whose collection window closed (abandoned or cancelled jobs).
CREATE OR REPLACE FUNCTION public.expire_posted_probe_dispatch(p_limit integer DEFAULT 200)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE r record; v integer := 0;
BEGIN
  FOR r IN SELECT o.id, a.lease_token FROM probe_observations o
             JOIN probe_attempts a ON a.observation_id = o.id AND a.lease_token = o.lease_token
            WHERE o.state = 'posted' AND a.dispatch_state = 'posted' AND a.collect_until <= clock_timestamp()
            ORDER BY a.collect_until LIMIT p_limit LOOP
    PERFORM collect_probe_dispatch(r.id, r.lease_token,
      jsonb_build_object('answer_present', false, 'error', 'Answer was paid for but not collected in time',
                         'provider_failure', jsonb_build_object('kind','provider_capacity','retryable',false,
                           'opens_circuit',false,'message','Queued answer was not collected before its window closed')),
      'failed', jsonb_build_object('kind','not_collected','opens_circuit',false), NULL, NULL);
    v := v + 1;
  END LOOP;
  RETURN v;
END $$;

REVOKE ALL ON FUNCTION public.post_probe_dispatch(text,uuid,text,numeric,timestamptz,timestamptz),
  public.reschedule_probe_collection(text,uuid,timestamptz),
  public.collect_probe_dispatch(text,uuid,jsonb,text,jsonb,timestamptz,numeric),
  public.expire_posted_probe_dispatch(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.post_probe_dispatch(text,uuid,text,numeric,timestamptz,timestamptz),
  public.reschedule_probe_collection(text,uuid,timestamptz),
  public.collect_probe_dispatch(text,uuid,jsonb,text,jsonb,timestamptz,numeric),
  public.expire_posted_probe_dispatch(integer) TO service_role;
NOTIFY pgrst, 'reload schema';
