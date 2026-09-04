-- 012: scan_jobs.attempts, and the cap that makes a poison job terminal.
-- Plan: docs/plans/2026-08-29-rebuild-roadmap.md R3.3.1 (finding S12).
-- Safe to re-run.
--
-- ADDITIVE: one new column on scan_jobs, one CHECK, one partial index, one new
-- function. Nothing is dropped, renamed or rewritten, and no existing function
-- is replaced. `ADD COLUMN ... integer NOT NULL DEFAULT 0` does NOT rewrite the
-- table on PostgreSQL 11+ (the default is stored in the catalog), so this takes
-- an ACCESS EXCLUSIVE lock on scan_jobs only for the length of a catalog write,
-- not for the length of a table scan.
--
-- ---------------------------------------------------------------------------
-- WHY THIS COLUMN EXISTS (S12)
-- ---------------------------------------------------------------------------
-- `/api/scan/worker`'s sweep selects every scan_job that is not 'complete' or
-- 'failed' and re-dispatches the ones whose heartbeat has gone stale
-- (`shouldRescueJob`). Nothing counts how many times it has already done that.
-- A job whose worker dies at the same point every time -- a finalize that
-- outruns maxDuration, a container killed mid-probe, a checkpoint that always
-- deserializes into the same crash -- is therefore resumed forever: every cron
-- tick, every day, spending real Bright Data and LLM budget on an execution
-- that has never once finished, while the row sits in 'probing' looking like
-- work in progress.
--
-- The chunk's own `catch` already marks a job failed when the FAILURE IS AN
-- EXCEPTION IT SURVIVES TO HANDLE. This column is for the other kind: the
-- process that never comes back to write anything. Nobody is left to record
-- that attempt, so the record has to be made when the NEXT attempt starts.
--
-- ---------------------------------------------------------------------------
-- WHAT `attempts` COUNTS, AND WHAT IT DOES NOT
-- ---------------------------------------------------------------------------
-- It counts RESUMES OF A JOB WHOSE PREVIOUS EXECUTOR WENT AWAY, not chunks.
-- A scan is deliberately many chunks (CHUNK_TIME_BUDGET_MS makes a long probe
-- set yield and self-continue), so counting every chunk would cap the SIZE of a
-- scan at three slices and kill healthy scans. src/lib/workers/scanWorker.js
-- calls this function only when `shouldRescueJob(job)` is true at chunk entry --
-- i.e. the job is non-terminal and its heartbeat is older than
-- HEARTBEAT_STALE_MS, which is exactly "the last executor stopped saying it was
-- alive". A clean hand-off (self-continue after a checkpoint) arrives on a
-- heartbeat that is seconds old and costs nothing.
--
-- IT IS RESET TO 0 BY MEASURED PROGRESS. runProbingPhase writes `attempts = 0`
-- in the same UPDATE that persists a batch of probe results, so the cap counts
-- CONSECUTIVE resumes that achieved nothing. That is not a loophole that
-- restores the infinite retry: progress here is monotone and bounded -- each
-- (engine, query) pair is probed at most once for a job -- so a job can only
-- reset the counter as many times as it has pairs left, and then it must either
-- finalize or stop resetting and hit the cap. Without the reset, a scan whose
-- self-continue fetch cannot reach itself (the fetch is documented as an
-- optimisation only; poll and cron rescue are the guarantee) would die at three
-- slices even though every slice made real progress.
--
-- ---------------------------------------------------------------------------
-- WHY THE CLAIM IS A FUNCTION AND NOT TWO STATEMENTS IN JS
-- ---------------------------------------------------------------------------
-- Read-then-increment from JS is a lost update: two rescues that race (the
-- status route's poll rescue firing on top of the cron sweep is the common one)
-- both read the same `attempts` and both write the same value, so the cap leaks
-- an attempt every time it is contended. `SELECT ... FOR UPDATE` inside one
-- function serialises them -- the second racer waits, then reads the value the
-- first committed -- and it puts the increment and the terminal flip in the same
-- transaction, so a job can never be both refused and left running. Migrations
-- 010 and 011 put their claims in SQL for the same reason.
--
-- ---------------------------------------------------------------------------
-- BEYOND THE CAP THE JOB IS TERMINAL, AND SAYS WHY
-- ---------------------------------------------------------------------------
-- Refusing the attempt without recording anything would leave the row in
-- 'probing' forever: invisible to the sweep's own filter only by accident, and
-- indistinguishable from a scan still being worked. So the refusal WRITES the
-- terminal state in the same transaction -- status 'failed', progress 100, and
-- an `error_message` that starts with the marker `max_attempts:` and names the
-- count, the cap, the status it died in and the last error it managed to
-- record. That message is what /api/scan/[job_id]/status hands the customer's
-- browser, so an abandoned scan reads as an abandoned scan.
--
-- Flipping the status to 'failed' also releases migration 007's
-- `scan_jobs_one_running_per_brand` lock, so a brand whose scan was abandoned
-- can be scanned again immediately instead of being blocked by a corpse.
ALTER TABLE scan_jobs ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

DO $$
BEGIN
  -- A negative attempt count is not a smaller number of tries, it is a bug that
  -- would silently buy a poison job unlimited retries by never reaching the cap.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scan_jobs_attempts_chk') THEN
    ALTER TABLE scan_jobs ADD CONSTRAINT scan_jobs_attempts_chk CHECK (attempts >= 0);
  END IF;
END $$;

-- The sweep's own predicate (`/api/scan/worker`: status NOT IN
-- ('complete','failed'), which is at most a handful of rows out of a table that
-- only grows), carrying `attempts` so "which live jobs are close to being
-- abandoned" is an index-only read.
--
-- It has a second job. `scripts/setup-supabase.mjs` verifies an applied
-- migration by looking for the objects it should have created, and its catalog
-- probe can see tables, indexes and functions -- not columns. An index ON the
-- new column cannot exist unless the column does, so this is the artifact that
-- makes "012 was applied" checkable. Without it a database missing this
-- migration would pass the catalog check on the strength of the function alone,
-- and a plpgsql body does not resolve its column references until it runs.
CREATE INDEX IF NOT EXISTS scan_jobs_attempts_idx
  ON scan_jobs (attempts)
  WHERE status NOT IN ('complete', 'failed');

-- ---------------------------------------------------------------------------
-- The attempt claim
-- ---------------------------------------------------------------------------
--
-- Returns a REPORT, never a bare row and never NULL. Standing rule 1: the four
-- ways this can decline -- the job vanished, the job finished, the job is out of
-- attempts, or the attempt is granted -- are four different facts, and a caller
-- that cannot tell them apart will round the lot up to "carry on".
--
-- Every return carries `granted` as a real boolean. The JS caller refuses to
-- proceed if it is missing rather than assuming success (src/lib/workers/scanWorker.js).
--
-- SECURITY INVOKER (the default) on purpose: the Next app holds only the anon
-- key, and 001's "Allow anon all on scan_jobs" policy is what lets it write.
-- SECURITY DEFINER would silently hand this function more authority than the
-- caller has, which is not a decision this migration needs to make.
CREATE OR REPLACE FUNCTION claim_scan_job_attempt(
  p_job_id       uuid,
  -- The cap. Kept as a PARAMETER rather than a per-row `max_attempts` column
  -- (probe_tasks has one, and nothing has ever read it) because the cap is
  -- policy, not data: a second copy of it on every row is a second thing to
  -- disagree with MAX_JOB_ATTEMPTS in scanWorker.js. A guard test asserts this
  -- default and that constant are the same number.
  p_max_attempts integer DEFAULT 3
)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_now      timestamptz := now();
  v_job      scan_jobs;
  v_attempts integer;
  v_message  text;
BEGIN
  IF p_job_id IS NULL THEN
    RAISE EXCEPTION 'claim_scan_job_attempt: p_job_id is required (an attempt against no job cannot be counted)';
  END IF;
  IF p_max_attempts IS NULL OR p_max_attempts < 1 THEN
    RAISE EXCEPTION 'claim_scan_job_attempt: p_max_attempts must be >= 1, got %',
      COALESCE(p_max_attempts::text, 'null');
  END IF;

  -- FOR UPDATE is the whole atomicity argument: a second racer blocks here and
  -- reads the value the first one committed.
  SELECT * INTO v_job FROM scan_jobs WHERE id = p_job_id FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'granted', false, 'verdict', 'not_found', 'job_id', p_job_id,
      -- NULL, not 0: nothing was measured about a job that is not there. Cast,
      -- because an untyped NULL into a variadic "any" is a resolution the
      -- planner should not have to guess at.
      'attempts', NULL::integer, 'max_attempts', p_max_attempts, 'observed_at', v_now
    );
  END IF;

  -- It finished between the caller's read and this claim. Not an error, and
  -- emphatically not an attempt: charging a completed scan for the rescue that
  -- arrived one second late is how a healthy job loses its budget.
  IF v_job.status IN ('complete', 'failed') THEN
    RETURN jsonb_build_object(
      'granted', false, 'verdict', 'already_finished', 'job_id', p_job_id,
      'attempts', v_job.attempts, 'max_attempts', p_max_attempts,
      'status', v_job.status, 'observed_at', v_now
    );
  END IF;

  IF COALESCE(v_job.attempts, 0) >= p_max_attempts THEN
    v_message := format(
      'max_attempts: abandoned at %s after %s resume attempt(s) without finishing (cap %s). '
      || 'It was last seen in status "%s" with heartbeat %s.%s',
      v_now, COALESCE(v_job.attempts, 0), p_max_attempts, v_job.status,
      COALESCE(v_job.heartbeat_at::text, 'never'),
      CASE
        WHEN btrim(COALESCE(v_job.error_message, '')) = '' THEN ''
        ELSE ' Last recorded error: ' || v_job.error_message
      END
    );

    -- Terminal, in the same transaction as the refusal. A refusal that left the
    -- row alive would be a scan that stops progressing and never says so.
    UPDATE scan_jobs
       SET status        = 'failed',
           progress_pct  = 100,
           error_message = v_message,
           heartbeat_at  = v_now
     WHERE id = p_job_id;

    RETURN jsonb_build_object(
      'granted', false, 'verdict', 'max_attempts', 'job_id', p_job_id,
      'attempts', COALESCE(v_job.attempts, 0), 'max_attempts', p_max_attempts,
      'status', 'failed', 'error_message', v_message, 'observed_at', v_now
    );
  END IF;

  -- The heartbeat stamp is load-bearing, not decoration. The status route
  -- rescues on EVERY poll where the job looks stale, so without a stamp here a
  -- browser polling every two seconds would be handed three attempts in six
  -- seconds and abandon a job that was working. Stamping as the attempt is
  -- granted closes that window to the width of this statement.
  UPDATE scan_jobs
     SET attempts     = COALESCE(attempts, 0) + 1,
         heartbeat_at = v_now
   WHERE id = p_job_id
  RETURNING attempts INTO v_attempts;

  RETURN jsonb_build_object(
    'granted', true, 'verdict', 'granted', 'job_id', p_job_id,
    'attempts', v_attempts, 'max_attempts', p_max_attempts,
    'status', v_job.status, 'observed_at', v_now
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES NOT DO
-- ---------------------------------------------------------------------------
-- * It does not touch probe_tasks. 011's footer hands its dead
--   `max_attempts`/'abandoned' pair to this task, but probe_tasks is the FLEET's
--   queue (worker/, not deployed) and enforcing its cap means replacing
--   `claim_probe_tasks`, whose live behaviour is covered by tests this task
--   cannot run against a database. A task whose worker keeps dying is still
--   reclaimed forever with `attempts` climbing past `max_attempts` -- unchanged
--   here, still true, and still worth its own task.
-- * It does not backfill or retire the jobs already stranded in a running
--   status. They start at attempts = 0 and get three fresh chances, which is the
--   behaviour a new column can honestly claim; retiring the existing corpses is
--   an operator action, not a schema change.
