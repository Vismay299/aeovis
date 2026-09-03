-- 010: the probe_tasks queue and its atomic claim.
-- Plan: docs/plans/2026-08-29-rebuild-roadmap.md R1.2.2.
-- Safe to re-run. PURELY ADDITIVE: one new table, its indexes, four new
-- functions. Nothing here alters, drops or rewrites an existing object, and
-- there is deliberately no foreign key to scan_jobs -- a REFERENCES clause
-- would take a lock and install a trigger on a table full of customer scans.
-- R1.2.3 owns the scan_runs ledger that ties the two together.

-- ---------------------------------------------------------------------------
-- The queue
-- ---------------------------------------------------------------------------
--
-- WHY A TABLE AND NOT A LEASE ON scan_jobs
-- A scan job is one row that passes through phases. A probe fleet needs N
-- independently claimable units of work per scan, spread across engines and
-- across containers, each retryable on its own. That is a queue, not a phase.
--
-- LEASE COLUMNS ARE jobLease's COLUMNS
-- `lease_owner` / `lease_expires_at` are named and used exactly as
-- src/lib/jobLease.js defines them: a NULL owner or a past expiry means free,
-- re-acquiring your own lease is allowed, and the default TTL below is
-- jobLease's LEASE_TTL_MS (3 minutes). renew_probe_lease and
-- release_probe_tasks are the same verbs jobLease exposes, on the same columns.
-- What is NOT reused is the acquire STATEMENT: jobLease.acquireLease claims one
-- row whose id the caller already knows, and a queue claim has to CHOOSE which
-- rows to take. That selection needs FOR UPDATE SKIP LOCKED. See
-- claim_probe_tasks.
CREATE TABLE IF NOT EXISTS probe_tasks (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The unit two workers race for. Set by the producer; every task of one
  -- scan/engine slice shares it.
  batch_id     uuid        NOT NULL,
  -- Plain uuid, NOT a foreign key (see header). R1.2.3 wires the ledger.
  scan_job_id  uuid,
  engine       text        NOT NULL,
  query        text        NOT NULL,
  status       text        NOT NULL DEFAULT 'pending',
  priority     integer     NOT NULL DEFAULT 0,
  attempts     integer     NOT NULL DEFAULT 0,
  max_attempts integer     NOT NULL DEFAULT 3,
  lease_owner      text,
  lease_expires_at timestamptz,
  claimed_at       timestamptz,
  -- The typed outcome, from the closed vocabulary in worker/src/lib/probe.js.
  -- Constrained here as well as in JS because 'blocked' being written as
  -- 'no_answer' is decision D2's whole failure mode, and a CHECK is the one
  -- place a typo cannot get past.
  outcome        text,
  outcome_detail jsonb,
  completed_at   timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT probe_tasks_status_chk
    CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'abandoned')),
  CONSTRAINT probe_tasks_outcome_chk
    CHECK (outcome IS NULL OR outcome IN (
      'answered', 'no_answer', 'blocked', 'captcha',
      'login_wall', 'timeout', 'parse_error', 'skipped'
    ))
);

-- The claim's WHERE and ORDER BY, exactly. Partial on NON-TERMINAL status --
-- not on status='pending' -- because a claimable task is not only a pending
-- one: a 'claimed' row whose lease has lapsed is claimable too, and that is
-- the whole reclaim path. A pending-only index cannot serve it.
CREATE INDEX IF NOT EXISTS probe_tasks_claim_idx
  ON probe_tasks (engine, priority DESC, created_at)
  WHERE status IN ('pending', 'claimed');

-- "How is this batch doing" -- the read the reporter and the ledger both make.
CREATE INDEX IF NOT EXISTS probe_tasks_batch_idx
  ON probe_tasks (batch_id, status);

-- Reaping: find the claims whose worker died. Without this the sweep is a seq
-- scan over the whole queue.
CREATE INDEX IF NOT EXISTS probe_tasks_lease_idx
  ON probe_tasks (lease_expires_at)
  WHERE status = 'claimed';

ALTER TABLE probe_tasks ENABLE ROW LEVEL SECURITY;
DO $policy$
BEGIN
  -- The same anon-all shape every other table in this schema uses (001-009).
  -- The fleet holds the service role key and bypasses RLS; the Next app holds
  -- only the anon key, so without this policy the producer cannot enqueue.
  -- Tightening RLS is a schema-wide decision, not this migration's to make.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'probe_tasks' AND policyname = 'Allow anon all on probe_tasks'
  ) THEN
    CREATE POLICY "Allow anon all on probe_tasks" ON probe_tasks
      FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END
$policy$;

-- ---------------------------------------------------------------------------
-- The atomic claim
-- ---------------------------------------------------------------------------
--
-- WHY THIS IS SQL AND NOT jobLease.js
-- The fleet lives in worker/, which may not import from src/ -- the container
-- image does not ship it, and src/lib/workerIsolation.test.mjs fails the build
-- on any import that crosses. So the app and the fleet cannot share a JS claim.
-- They share this function instead: ONE implementation, called by both over
-- RPC, with no code copied and so nothing to drift.
--
-- WHY IT CANNOT BE LOST
-- The candidate CTE takes a row lock with FOR UPDATE SKIP LOCKED. Two workers
-- racing for the same row: the first locks it; the second does not block and
-- does not read it -- it skips and looks further down the queue. There is no
-- window between choosing a row and claiming it, because choosing IS locking.
-- This is jobLease's atomicity argument applied to a SET instead of one id:
-- jobLease's conditional UPDATE already knows its row id, and a queue does not.
--
-- WHY IT RETURNS A REPORT AND NOT A ROWSET
-- Standing rule 1. "I claimed nothing" has two completely different meanings --
-- the queue is empty, or every task is leased by somebody else -- and a bare
-- empty array cannot tell them apart. A fleet that says "nothing to do" while
-- its queue fills is the false success this rebuild exists to remove, so what
-- comes back always carries the outstanding count that separates the two.
CREATE OR REPLACE FUNCTION claim_probe_tasks(
  p_owner     text,
  p_engines   text[]  DEFAULT NULL,
  p_limit     integer DEFAULT 5,
  -- Default TTL is jobLease.LEASE_TTL_MS (3 min). Keep the two in step.
  p_lease_ms  integer DEFAULT 180000,
  p_batch_id  uuid    DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_now         timestamptz := now();
  v_expires     timestamptz;
  v_claimed     jsonb;
  v_count       integer;
  v_outstanding integer;
  v_leased      integer;
BEGIN
  -- An anonymous claim can never be renewed, released or attributed, and its
  -- lease can only be recovered by waiting out the TTL. Refuse loudly rather
  -- than hand out an unownable lease.
  IF p_owner IS NULL OR btrim(p_owner) = '' THEN
    RAISE EXCEPTION 'claim_probe_tasks: p_owner is required (an unowned lease cannot be renewed, released or reaped)';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'claim_probe_tasks: p_limit must be >= 1, got %', p_limit;
  END IF;
  IF p_lease_ms IS NULL OR p_lease_ms < 1000 THEN
    RAISE EXCEPTION 'claim_probe_tasks: p_lease_ms must be >= 1000, got %', p_lease_ms;
  END IF;

  v_expires := v_now + make_interval(secs => p_lease_ms / 1000.0);

  WITH candidate AS (
    SELECT t.id
      FROM probe_tasks t
       -- NON-TERMINAL, not 'pending'. A row whose worker died is left at
       -- 'claimed' with a lapsed lease, and that is exactly the row the reaper
       -- must be able to take. Restricting the claim to 'pending' would make
       -- LEASE_TTL_MS meaningless: the lease would expire and nothing could
       -- ever pick the task up again. (It did; the live expiry test caught it.)
     WHERE t.status IN ('pending', 'claimed')
       AND (p_engines  IS NULL OR t.engine = ANY (p_engines))
       AND (p_batch_id IS NULL OR t.batch_id = p_batch_id)
       -- jobLease.leaseIsFree as a predicate, and the only thing standing
       -- between a live claim and a stolen one: no owner, or the lease lapsed.
       --
       -- ONE DELIBERATE DIVERGENCE FROM jobLease: it also treats
       -- `lease_owner = me` as free, because re-acquiring your own lease on a
       -- resumed job is idempotent and useful. On a QUEUE it is neither. A
       -- worker's next poll would be handed the batch it is still probing,
       -- re-running live work and inflating `attempts`. A lease that is mine
       -- and unexpired is held, by me, and not available.
       AND (t.lease_owner IS NULL
            OR t.lease_expires_at IS NULL
            OR t.lease_expires_at < v_now)
     ORDER BY t.priority DESC, t.created_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  ),
  claimed AS (
    UPDATE probe_tasks t
       SET status           = 'claimed',
           lease_owner      = p_owner,
           lease_expires_at = v_expires,
           attempts         = t.attempts + 1,
           claimed_at       = v_now,
           updated_at       = v_now
      FROM candidate c
     WHERE t.id = c.id
    RETURNING t.*
  )
  SELECT COALESCE(jsonb_agg(to_jsonb(claimed) ORDER BY claimed.created_at), '[]'::jsonb),
         COUNT(*)::integer
    INTO v_claimed, v_count
    FROM claimed;

  -- Outstanding counts NON-TERMINAL work, and that is what makes "empty" and
  -- "all leased" distinguishable. Counting only status='pending' would not:
  -- the loser of a race re-reads after the winner commits, sees the row as
  -- 'claimed', and would report an empty queue -- the exact lie rule 1 bans.
  SELECT COUNT(*)::integer,
         COUNT(*) FILTER (
           WHERE t.lease_owner IS NOT NULL
             AND t.lease_owner <> p_owner
             AND t.lease_expires_at IS NOT NULL
             AND t.lease_expires_at >= v_now
         )::integer
    INTO v_outstanding, v_leased
    FROM probe_tasks t
   WHERE t.status IN ('pending', 'claimed')
     AND (p_engines  IS NULL OR t.engine = ANY (p_engines))
     AND (p_batch_id IS NULL OR t.batch_id = p_batch_id);

  RETURN jsonb_build_object(
    'owner',            p_owner,
    'tasks',            v_claimed,
    'claimed_count',    v_count,
    -- Non-terminal tasks matching this filter, INCLUDING the ones just claimed.
    'outstanding',      v_outstanding,
    -- Of those, how many another worker holds a live lease on.
    'leased_elsewhere', v_leased,
    'lease_expires_at', v_expires,
    'observed_at',      v_now
  );
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Renew and release -- jobLease's other two verbs, on the same columns
-- ---------------------------------------------------------------------------

-- Push the expiry out for tasks THIS owner still holds. Returns how many were
-- renewed; a worker whose lease was reaped gets back fewer than it asked for
-- and has therefore lost ownership. jobLease.renewLease's role.
CREATE OR REPLACE FUNCTION renew_probe_lease(
  p_owner    text,
  p_task_ids uuid[],
  p_lease_ms integer DEFAULT 180000
)
RETURNS integer
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_renewed integer;
BEGIN
  IF p_owner IS NULL OR btrim(p_owner) = '' THEN
    RAISE EXCEPTION 'renew_probe_lease: p_owner is required';
  END IF;
  IF p_lease_ms IS NULL OR p_lease_ms < 1000 THEN
    RAISE EXCEPTION 'renew_probe_lease: p_lease_ms must be >= 1000, got %', p_lease_ms;
  END IF;

  UPDATE probe_tasks t
     SET lease_expires_at = now() + make_interval(secs => p_lease_ms / 1000.0),
         updated_at = now()
   WHERE t.id = ANY (p_task_ids)
     AND t.lease_owner = p_owner
     AND t.status = 'claimed';

  GET DIAGNOSTICS v_renewed = ROW_COUNT;
  RETURN v_renewed;
END;
$fn$;

-- Record typed outcomes and drop the lease.
--
-- ONLY THE LEASE HOLDER MAY REPORT. A worker whose lease expired has had its
-- tasks handed to somebody else; letting its late result land would overwrite a
-- live claim with a stale answer. Rows it no longer owns are counted as
-- REJECTED and named in the return, never silently dropped -- the caller has to
-- be able to tell "wrote 5" from "wrote 2, lost 3".
--
-- p_results: [{"id": uuid, "outcome": text, "detail": jsonb}]
CREATE OR REPLACE FUNCTION complete_probe_tasks(p_owner text, p_results jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_applied     integer;
  v_asked       integer;
  v_rejected    jsonb;
  v_written_ids uuid[];
BEGIN
  IF p_owner IS NULL OR btrim(p_owner) = '' THEN
    RAISE EXCEPTION 'complete_probe_tasks: p_owner is required';
  END IF;
  IF p_results IS NULL OR jsonb_typeof(p_results) <> 'array' THEN
    RAISE EXCEPTION 'complete_probe_tasks: p_results must be a JSON array, got %',
      COALESCE(jsonb_typeof(p_results), 'null');
  END IF;

  SELECT COUNT(*)::integer INTO v_asked FROM jsonb_array_elements(p_results);

  WITH incoming AS (
    SELECT (e ->> 'id')::uuid AS id,
           e ->> 'outcome'    AS outcome,
           COALESCE(e -> 'detail', 'null'::jsonb) AS detail
      FROM jsonb_array_elements(p_results) e
  ),
  written AS (
    UPDATE probe_tasks t
       -- 'skipped', 'blocked', 'captcha' and friends are REPORTABLE outcomes,
       -- not completed work: the row goes to 'failed' unless the probe really
       -- answered or really found no answer. A blocked probe recorded as done
       -- is decision D2's confident zero.
       SET status = CASE WHEN i.outcome IN ('answered', 'no_answer') THEN 'done' ELSE 'failed' END,
           outcome          = i.outcome,
           outcome_detail   = NULLIF(i.detail, 'null'::jsonb),
           completed_at     = now(),
           updated_at       = now(),
           lease_owner      = NULL,
           lease_expires_at = NULL
      FROM incoming i
     WHERE t.id = i.id
       AND t.lease_owner = p_owner
       AND t.status = 'claimed'
    RETURNING t.id
  )
  SELECT COALESCE(array_agg(written.id), '{}'::uuid[])
    INTO v_written_ids
    FROM written;

  v_applied := COALESCE(array_length(v_written_ids, 1), 0);

  -- Every id we were asked about that we did NOT write. Computed from the
  -- request, not from the table, so an id that does not exist at all is
  -- rejected rather than quietly counted as fine.
  SELECT COALESCE(jsonb_agg(i.id), '[]'::jsonb)
    INTO v_rejected
    FROM jsonb_array_elements(p_results) e
    CROSS JOIN LATERAL (SELECT (e ->> 'id')::uuid AS id) i
   WHERE NOT (i.id = ANY (v_written_ids));

  RETURN jsonb_build_object(
    'owner',    p_owner,
    'asked',    v_asked,
    'applied',  v_applied,
    -- Ids this owner no longer held. Named, not swallowed.
    'rejected', v_rejected
  );
END;
$fn$;

-- Hand tasks back unclaimed, without a result. Used on SIGTERM so a deploy does
-- not orphan a batch for the full TTL. jobLease.releaseLease's role.
CREATE OR REPLACE FUNCTION release_probe_tasks(p_owner text, p_task_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_released integer;
BEGIN
  IF p_owner IS NULL OR btrim(p_owner) = '' THEN
    RAISE EXCEPTION 'release_probe_tasks: p_owner is required';
  END IF;

  UPDATE probe_tasks t
     SET status = 'pending',
         lease_owner = NULL,
         lease_expires_at = NULL,
         claimed_at = NULL,
         updated_at = now()
   WHERE t.id = ANY (p_task_ids)
     AND t.lease_owner = p_owner
     AND t.status = 'claimed';

  GET DIAGNOSTICS v_released = ROW_COUNT;
  RETURN v_released;
END;
$fn$;
