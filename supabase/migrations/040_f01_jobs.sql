-- F01: durable step-based job runner (Cloudflare Workflows semantics on Postgres).
-- Service-role writes only. Customers may read their own workspace's jobs.

CREATE TABLE IF NOT EXISTS public.jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_key text REFERENCES public.customer_brands(brand_key) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  trigger text NOT NULL DEFAULT 'manual'
    CHECK (trigger IN ('manual','scheduled','baseline','system')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','completed','partial','failed','cancelled')),
  dedupe_key text CHECK (dedupe_key IS NULL OR length(dedupe_key) BETWEEN 1 AND 200),
  single_active_key text CHECK (single_active_key IS NULL OR length(single_active_key) BETWEEN 1 AND 200),
  run_at timestamptz NOT NULL DEFAULT now(),
  deadline_at timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  invocations integer NOT NULL DEFAULT 0,
  max_invocations integer NOT NULL DEFAULT 200 CHECK (max_invocations BETWEEN 1 AND 10000),
  lease_owner text,
  lease_until timestamptz,
  progress_done integer,
  progress_total integer,
  progress_label text CHECK (progress_label IS NULL OR length(progress_label) <= 120),
  result jsonb CHECK (result IS NULL OR pg_column_size(result) < 65536),
  error_code text,
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 500),
  cancel_requested_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  -- A job without a workspace exists only for platform maintenance.
  CONSTRAINT jobs_brand_or_system CHECK (brand_key IS NOT NULL OR trigger = 'system'),
  CONSTRAINT jobs_progress_ck CHECK (
    (progress_done IS NULL AND progress_total IS NULL)
    OR (progress_done >= 0 AND progress_total >= 0 AND progress_done <= progress_total)),
  CONSTRAINT jobs_terminal_finished CHECK (
    (status IN ('completed','partial','failed','cancelled')) = (finished_at IS NOT NULL))
);
COMMENT ON COLUMN public.jobs.invocations IS 'Handler entries (claims), not step retries.';
COMMENT ON COLUMN public.jobs.single_active_key IS 'At most one queued/running job per (kind, single_active_key).';

CREATE UNIQUE INDEX IF NOT EXISTS jobs_dedupe_idx
  ON public.jobs (kind, brand_key, dedupe_key) NULLS NOT DISTINCT
  WHERE dedupe_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS jobs_single_active_idx
  ON public.jobs (kind, single_active_key)
  WHERE single_active_key IS NOT NULL AND status IN ('queued','running');
CREATE INDEX IF NOT EXISTS jobs_due_idx ON public.jobs (run_at, created_at)
  WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS jobs_brand_created_idx ON public.jobs (brand_key, created_at DESC);
CREATE INDEX IF NOT EXISTS jobs_finished_idx ON public.jobs (finished_at)
  WHERE finished_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.job_steps (
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  step_kind text NOT NULL CHECK (step_kind IN ('do','sleep')),
  status text NOT NULL CHECK (status IN ('running','retry_wait','sleeping','completed','failed')),
  billed boolean NOT NULL DEFAULT false,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 6),
  timeout_ms integer NOT NULL CHECK (timeout_ms BETWEEN 1 AND 230000),
  output jsonb CHECK (output IS NULL OR pg_column_size(output) < 65536),
  error_code text,
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 500),
  wake_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (job_id, name),
  CONSTRAINT job_steps_billed_once CHECK (NOT billed OR max_attempts = 1),
  CONSTRAINT job_steps_wake CHECK ((status IN ('retry_wait','sleeping')) = (wake_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS public.job_periodic (
  name text PRIMARY KEY CHECK (name ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  interval_seconds integer NOT NULL CHECK (interval_seconds >= 60),
  next_run_at timestamptz NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  last_started_at timestamptz,
  last_finished_at timestamptz,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 500)
);

CREATE OR REPLACE FUNCTION public.f01_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
DROP TRIGGER IF EXISTS jobs_touch_updated_at ON public.jobs;
CREATE TRIGGER jobs_touch_updated_at BEFORE UPDATE ON public.jobs
  FOR EACH ROW EXECUTE FUNCTION public.f01_touch_updated_at();

ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_periodic ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.jobs, public.job_steps, public.job_periodic FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.jobs, public.job_steps, public.job_periodic TO service_role;
GRANT SELECT ON public.jobs TO authenticated;
DROP POLICY IF EXISTS jobs_customer_read ON public.jobs;
CREATE POLICY jobs_customer_read ON public.jobs FOR SELECT TO authenticated
  USING (brand_key IS NOT NULL AND public.customer_can_access_brand(brand_key));

-- Enqueue with dedupe and single-active handling in one statement path.
CREATE OR REPLACE FUNCTION public.enqueue_job(
  p_kind text, p_brand text, p_payload jsonb, p_trigger text,
  p_dedupe text, p_single_active text, p_run_at timestamptz,
  p_created_by uuid, p_deadline_seconds integer, p_max_invocations integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_id uuid;
BEGIN
  IF p_deadline_seconds IS NULL OR p_deadline_seconds < 60 OR p_deadline_seconds > 7*86400 THEN
    RAISE EXCEPTION 'invalid job deadline'; END IF;
  IF p_dedupe IS NOT NULL THEN
    SELECT id INTO v_id FROM jobs
     WHERE kind = p_kind AND brand_key IS NOT DISTINCT FROM p_brand AND dedupe_key = p_dedupe;
    IF FOUND THEN RETURN jsonb_build_object('job_id', v_id, 'deduped', true); END IF;
  END IF;
  BEGIN
    INSERT INTO jobs(kind, brand_key, payload, trigger, dedupe_key, single_active_key,
                     run_at, deadline_at, created_by, max_invocations)
    VALUES (p_kind, p_brand, coalesce(p_payload, '{}'::jsonb), p_trigger, p_dedupe, p_single_active,
            coalesce(p_run_at, now()), coalesce(p_run_at, now()) + make_interval(secs => p_deadline_seconds),
            p_created_by, coalesce(p_max_invocations, 200))
    RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    IF p_dedupe IS NOT NULL THEN
      SELECT id INTO v_id FROM jobs
       WHERE kind = p_kind AND brand_key IS NOT DISTINCT FROM p_brand AND dedupe_key = p_dedupe;
      IF FOUND THEN RETURN jsonb_build_object('job_id', v_id, 'deduped', true); END IF;
    END IF;
    SELECT id INTO v_id FROM jobs
     WHERE kind = p_kind AND single_active_key = p_single_active AND status IN ('queued','running');
    RETURN jsonb_build_object('job_id', NULL, 'deduped', false, 'conflict_job_id', v_id);
  END;
  RETURN jsonb_build_object('job_id', v_id, 'deduped', false);
END $$;

-- Claim due jobs. SKIP LOCKED: two ticks never take the same row.
CREATE OR REPLACE FUNCTION public.claim_due_jobs(
  p_owner text, p_limit integer, p_lease_seconds integer, p_job_id uuid DEFAULT NULL)
RETURNS SETOF public.jobs LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF p_limit < 1 OR p_limit > 50 OR p_lease_seconds < 30 OR p_lease_seconds > 900 THEN
    RAISE EXCEPTION 'invalid claim'; END IF;
  RETURN QUERY
  WITH due AS (
    SELECT id FROM jobs
     WHERE status IN ('queued','running') AND run_at <= now()
       AND (lease_until IS NULL OR lease_until < now())
       AND (p_job_id IS NULL OR id = p_job_id)
     ORDER BY run_at, created_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED)
  UPDATE jobs j SET status = 'running', lease_owner = p_owner,
         lease_until = now() + make_interval(secs => p_lease_seconds),
         invocations = j.invocations + 1, started_at = coalesce(j.started_at, now()),
         heartbeat_at = now()
    FROM due WHERE j.id = due.id
  RETURNING j.*;
END $$;

-- Fence helper: true when p_owner still holds an unexpired lease.
CREATE OR REPLACE FUNCTION public.f01_job_fenced(p_job uuid, p_owner text) RETURNS boolean
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM jobs WHERE id = p_job AND lease_owner = p_owner AND lease_until >= now()
                 AND status = 'running');
$$;

-- Begin (or resume) a step. Returns {action: run|memoised|failed|wait|lost_lease, ...}.
CREATE OR REPLACE FUNCTION public.job_step_begin(
  p_job uuid, p_owner text, p_name text, p_billed boolean, p_max_attempts integer, p_timeout_ms integer)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s job_steps;
BEGIN
  PERFORM 1 FROM jobs WHERE id = p_job FOR UPDATE;
  IF NOT f01_job_fenced(p_job, p_owner) THEN RETURN jsonb_build_object('action','lost_lease'); END IF;
  IF p_billed AND p_max_attempts <> 1 THEN RAISE EXCEPTION 'billed step must have one attempt'; END IF;
  SELECT * INTO s FROM job_steps WHERE job_id = p_job AND name = p_name FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO job_steps(job_id, name, step_kind, status, billed, attempts, max_attempts, timeout_ms)
    VALUES (p_job, p_name, 'do', 'running', p_billed, 1, p_max_attempts, p_timeout_ms);
    RETURN jsonb_build_object('action','run','attempt',1);
  END IF;
  IF s.step_kind <> 'do' THEN RAISE EXCEPTION 'step name % already used by a sleep', p_name; END IF;
  IF s.status = 'completed' THEN RETURN jsonb_build_object('action','memoised','output',s.output); END IF;
  IF s.status = 'failed' THEN
    RETURN jsonb_build_object('action','failed','error_code',s.error_code,'error_message',s.error_message);
  END IF;
  IF s.status = 'retry_wait' AND s.wake_at > now() THEN
    RETURN jsonb_build_object('action','wait','wake_at',s.wake_at);
  END IF;
  -- status 'running' here means the invocation that started it died mid-step.
  IF s.status = 'running' AND s.billed THEN
    UPDATE job_steps SET status = 'failed', error_code = 'billed_step_interrupted',
      error_message = 'A billed step was interrupted; it is never re-run.', finished_at = now()
     WHERE job_id = p_job AND name = p_name;
    RETURN jsonb_build_object('action','failed','error_code','billed_step_interrupted',
      'error_message','A billed step was interrupted; it is never re-run.');
  END IF;
  IF s.attempts >= s.max_attempts THEN
    UPDATE job_steps SET status = 'failed', error_code = 'step_attempts_exhausted', finished_at = now(),
      wake_at = NULL WHERE job_id = p_job AND name = p_name;
    RETURN jsonb_build_object('action','failed','error_code','step_attempts_exhausted',
      'error_message',coalesce(s.error_message,'Step failed after its retry budget.'));
  END IF;
  UPDATE job_steps SET status = 'running', attempts = s.attempts + 1, wake_at = NULL, started_at = now()
   WHERE job_id = p_job AND name = p_name;
  RETURN jsonb_build_object('action','run','attempt',s.attempts + 1);
END $$;

CREATE OR REPLACE FUNCTION public.job_step_complete(
  p_job uuid, p_owner text, p_name text, p_output jsonb, p_lease_seconds integer)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  PERFORM 1 FROM jobs WHERE id = p_job FOR UPDATE;
  IF NOT f01_job_fenced(p_job, p_owner) THEN RETURN false; END IF;
  UPDATE job_steps SET status = 'completed', output = p_output, finished_at = now(),
         error_code = NULL, error_message = NULL
   WHERE job_id = p_job AND name = p_name AND status = 'running';
  UPDATE jobs SET lease_until = now() + make_interval(secs => p_lease_seconds), heartbeat_at = now()
   WHERE id = p_job;
  RETURN true;
END $$;

-- Record a failed attempt. p_retry_at NULL (or budget used) = permanent failure.
CREATE OR REPLACE FUNCTION public.job_step_fail(
  p_job uuid, p_owner text, p_name text, p_code text, p_message text, p_retry_at timestamptz)
RETURNS text LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s job_steps;
BEGIN
  PERFORM 1 FROM jobs WHERE id = p_job FOR UPDATE;
  IF NOT f01_job_fenced(p_job, p_owner) THEN RETURN 'lost_lease'; END IF;
  SELECT * INTO s FROM job_steps WHERE job_id = p_job AND name = p_name FOR UPDATE;
  IF p_retry_at IS NOT NULL AND NOT s.billed AND s.attempts < s.max_attempts THEN
    UPDATE job_steps SET status = 'retry_wait', wake_at = p_retry_at, error_code = p_code,
           error_message = left(p_message, 500) WHERE job_id = p_job AND name = p_name;
    RETURN 'retry_wait';
  END IF;
  UPDATE job_steps SET status = 'failed', error_code = p_code, error_message = left(p_message, 500),
         finished_at = now(), wake_at = NULL WHERE job_id = p_job AND name = p_name;
  RETURN 'failed';
END $$;

-- Sleep: returns NULL when the sleep is over (continue), else the wake time (yield).
CREATE OR REPLACE FUNCTION public.job_sleep(p_job uuid, p_owner text, p_name text, p_seconds integer)
RETURNS timestamptz LANGUAGE plpgsql SET search_path = public AS $$
DECLARE s job_steps; v_wake timestamptz;
BEGIN
  IF p_seconds < 1 OR p_seconds > 86400 THEN RAISE EXCEPTION 'invalid sleep'; END IF;
  PERFORM 1 FROM jobs WHERE id = p_job FOR UPDATE;
  IF NOT f01_job_fenced(p_job, p_owner) THEN RAISE EXCEPTION 'lost_lease'; END IF;
  SELECT * INTO s FROM job_steps WHERE job_id = p_job AND name = p_name FOR UPDATE;
  IF NOT FOUND THEN
    v_wake := now() + make_interval(secs => p_seconds);
    INSERT INTO job_steps(job_id, name, step_kind, status, attempts, max_attempts, timeout_ms, wake_at)
    VALUES (p_job, p_name, 'sleep', 'sleeping', 1, 1, 1, v_wake);
    RETURN v_wake;
  END IF;
  IF s.step_kind <> 'sleep' THEN RAISE EXCEPTION 'step name % already used by a do', p_name; END IF;
  IF s.status = 'completed' THEN RETURN NULL; END IF;
  IF s.wake_at > now() THEN RETURN s.wake_at; END IF;
  UPDATE job_steps SET status = 'completed', wake_at = NULL, finished_at = now()
   WHERE job_id = p_job AND name = p_name;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.job_yield(p_job uuid, p_owner text, p_run_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE jobs SET lease_owner = NULL, lease_until = NULL, run_at = p_run_at, heartbeat_at = now()
   WHERE id = p_job AND lease_owner = p_owner AND status = 'running';
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.job_progress(
  p_job uuid, p_owner text, p_done integer, p_total integer, p_label text, p_lease_seconds integer)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  UPDATE jobs SET progress_done = p_done, progress_total = p_total, progress_label = left(p_label, 120),
         lease_until = now() + make_interval(secs => p_lease_seconds), heartbeat_at = now()
   WHERE id = p_job AND lease_owner = p_owner AND lease_until >= now() AND status = 'running';
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.job_finish(
  p_job uuid, p_owner text, p_status text, p_result jsonb, p_error_code text, p_error_message text)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF p_status NOT IN ('completed','partial','failed','cancelled') THEN RAISE EXCEPTION 'invalid terminal status'; END IF;
  UPDATE jobs SET status = p_status, result = p_result, error_code = p_error_code,
         error_message = left(p_error_message, 500), finished_at = now(),
         lease_owner = NULL, lease_until = NULL
   WHERE id = p_job AND lease_owner = p_owner AND status = 'running';
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.cancel_job(p_job uuid) RETURNS text
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE j jobs;
BEGIN
  SELECT * INTO j FROM jobs WHERE id = p_job FOR UPDATE;
  IF NOT FOUND THEN RETURN 'not_found'; END IF;
  IF j.status IN ('completed','partial','failed','cancelled') THEN RETURN j.status; END IF;
  IF j.status = 'queued' OR (j.lease_until IS NULL OR j.lease_until < now()) THEN
    UPDATE jobs SET status = 'cancelled', cancel_requested_at = coalesce(cancel_requested_at, now()),
           finished_at = now(), lease_owner = NULL, lease_until = NULL,
           error_code = 'cancelled', error_message = 'Cancelled.'
     WHERE id = p_job;
    RETURN 'cancelled';
  END IF;
  UPDATE jobs SET cancel_requested_at = coalesce(cancel_requested_at, now()) WHERE id = p_job;
  RETURN 'cancel_requested';
END $$;

-- Watchdog (port of auditReconciler). Oldest first, bounded batch.
CREATE OR REPLACE FUNCTION public.reconcile_stale_jobs(p_limit integer DEFAULT 100)
RETURNS jsonb LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_deadline integer := 0; v_invocations integer := 0;
BEGIN
  WITH stale AS (
    SELECT id FROM jobs WHERE status IN ('queued','running') AND deadline_at < now()
       AND (lease_until IS NULL OR lease_until < now())
     ORDER BY deadline_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
  UPDATE jobs j SET status = 'failed', error_code = 'deadline_exceeded',
         error_message = 'The job did not finish before its deadline.', finished_at = now(),
         lease_owner = NULL, lease_until = NULL
    FROM stale WHERE j.id = stale.id;
  GET DIAGNOSTICS v_deadline = ROW_COUNT;
  WITH runaway AS (
    SELECT id FROM jobs WHERE status IN ('queued','running') AND invocations >= max_invocations
       AND (lease_until IS NULL OR lease_until < now())
     ORDER BY created_at LIMIT p_limit FOR UPDATE SKIP LOCKED)
  UPDATE jobs j SET status = 'failed', error_code = 'invocation_limit',
         error_message = 'The job resumed too many times without finishing.', finished_at = now(),
         lease_owner = NULL, lease_until = NULL
    FROM runaway WHERE j.id = runaway.id;
  GET DIAGNOSTICS v_invocations = ROW_COUNT;
  RETURN jsonb_build_object('deadline_exceeded', v_deadline, 'invocation_limit', v_invocations);
END $$;

-- "Advance next-run before starting" (port of claimDueTracker). One catch-up only.
CREATE OR REPLACE FUNCTION public.claim_due_periodic(p_name text, p_interval_seconds integer, p_now timestamptz)
RETURNS boolean LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_next timestamptz; v_step interval := make_interval(secs => p_interval_seconds);
BEGIN
  INSERT INTO job_periodic(name, interval_seconds, next_run_at) VALUES (p_name, p_interval_seconds, p_now)
  ON CONFLICT (name) DO UPDATE SET interval_seconds = excluded.interval_seconds;
  SELECT next_run_at INTO v_next FROM job_periodic WHERE name = p_name AND enabled FOR UPDATE;
  IF NOT FOUND OR v_next > p_now THEN RETURN false; END IF;
  WHILE v_next <= p_now LOOP v_next := v_next + v_step; END LOOP;
  UPDATE job_periodic SET next_run_at = v_next, last_started_at = p_now, last_error = NULL WHERE name = p_name;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.prune_jobs(p_before timestamptz, p_limit integer DEFAULT 1000)
RETURNS integer LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v integer;
BEGIN
  WITH old AS (SELECT id FROM jobs WHERE finished_at < p_before ORDER BY finished_at LIMIT p_limit)
  DELETE FROM jobs j USING old WHERE j.id = old.id;
  GET DIAGNOSTICS v = ROW_COUNT; RETURN v;
END $$;

REVOKE ALL ON FUNCTION public.enqueue_job(text,text,jsonb,text,text,text,timestamptz,uuid,integer,integer),
  public.claim_due_jobs(text,integer,integer,uuid), public.f01_job_fenced(uuid,text),
  public.job_step_begin(uuid,text,text,boolean,integer,integer),
  public.job_step_complete(uuid,text,text,jsonb,integer),
  public.job_step_fail(uuid,text,text,text,text,timestamptz), public.job_sleep(uuid,text,text,integer),
  public.job_yield(uuid,text,timestamptz), public.job_progress(uuid,text,integer,integer,text,integer),
  public.job_finish(uuid,text,text,jsonb,text,text), public.cancel_job(uuid),
  public.reconcile_stale_jobs(integer), public.claim_due_periodic(text,integer,timestamptz),
  public.prune_jobs(timestamptz,integer), public.f01_touch_updated_at()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_job(text,text,jsonb,text,text,text,timestamptz,uuid,integer,integer),
  public.claim_due_jobs(text,integer,integer,uuid), public.f01_job_fenced(uuid,text),
  public.job_step_begin(uuid,text,text,boolean,integer,integer),
  public.job_step_complete(uuid,text,text,jsonb,integer),
  public.job_step_fail(uuid,text,text,text,text,timestamptz), public.job_sleep(uuid,text,text,integer),
  public.job_yield(uuid,text,timestamptz), public.job_progress(uuid,text,integer,integer,text,integer),
  public.job_finish(uuid,text,text,jsonb,text,text), public.cancel_job(uuid),
  public.reconcile_stale_jobs(integer), public.claim_due_periodic(text,integer,timestamptz),
  public.prune_jobs(timestamptz,integer)
  TO service_role;
NOTIFY pgrst, 'reload schema';
