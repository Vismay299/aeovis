-- 011: the scan_runs ledger -- one row per execution, fleet or web worker.
-- Plan: docs/plans/2026-08-29-rebuild-roadmap.md R1.2.3 (created here, fully
-- wired in R3.2). Safe to re-run.
--
-- PURELY ADDITIVE: one new table, four new indexes, three new functions. It
-- does not ALTER, DROP or rewrite any existing table, column, index or
-- function, and it takes no lock on `scans`, `scan_jobs`, `prompt_results` or
-- `probe_tasks` -- see NO FOREIGN KEYS below for why that is a choice and not
-- an oversight.
--
-- ---------------------------------------------------------------------------
-- WHY THIS TABLE EXISTS
-- ---------------------------------------------------------------------------
-- Today an execution leaves behind only its side effects. A chunk that ran and
-- did nothing, a chunk that never ran, a chunk that died halfway and a chunk
-- that skipped for a structured reason all produce the same evidence:
-- `scan_jobs.heartbeat_at` moved, or it did not. `src/lib/workers/scanWorker.js`
-- computes a reason for every early return ("sourcing_claimed_elsewhere",
-- "checkpointed", "noop", "read_failed") and then throws it away with the stack
-- frame. The status route guesses backwards from heartbeats (R3.2.3), and the
-- guess cannot distinguish "measured zero" from "never ran" -- the exact
-- failure standing rule 1 exists to ban.
--
-- One row per execution, opened before the work and closed after it, makes the
-- four cases four different rows. `system_heartbeats` (008) already made this
-- argument for the cron ticker and solved it with one upserted row per named
-- ticker; that answers "is it alive" but not "what did the last 40 passes
-- actually do", which is what a ledger is for.
--
-- ---------------------------------------------------------------------------
-- OPEN AND CLOSED ARE THE ONLY TWO STATES, AND THE TABLE ENFORCES IT
-- ---------------------------------------------------------------------------
-- `outcome IS NULL` means still running; `ended_at IS NULL` means the same
-- thing, and scan_runs_open_chk makes the two agree by construction. The row
-- shapes that constraint forbids are the dishonest ones:
--   * ended_at set, outcome NULL -- a run that looks finished and says nothing
--     about how, which every reader will round up to "fine".
--   * outcome set, ended_at NULL -- a verdict on work that never stopped.
-- A crashed writer therefore leaves an OPEN row with a stale `heartbeat_at`,
-- which is a visible, sweepable state (R3.3.2 closes it as 'reaped'), not a
-- silently-successful one.
--
-- ---------------------------------------------------------------------------
-- THE COUNTERS ARE NULLABLE ON PURPOSE. DO NOT GIVE THEM `DEFAULT 0`.
-- ---------------------------------------------------------------------------
-- `probes_attempted`, `probes_succeeded` and `errors_recovered` have no
-- default, so an unwritten counter reads NULL: NOT MEASURED. `DEFAULT 0` would
-- make a run that never counted anything indistinguishable from a run that
-- counted and found nothing, and a dashboard summing the column would report a
-- confident zero built out of absence. Standing rule 5 -- never `?? 0` on a
-- metric -- starts in the schema, because a column that cannot express "unknown"
-- forces every reader above it to lie. Readers must render NULL as an em dash
-- plus a state chip, never as 0.
--
-- ---------------------------------------------------------------------------
-- NO FOREIGN KEYS ON scan_job_id OR batch_id
-- ---------------------------------------------------------------------------
-- Same reasoning as migration 010, plus one that is specific to a ledger:
--   1. COST. `REFERENCES scan_jobs(id)` takes a ShareRowExclusiveLock on
--      scan_jobs and installs RI triggers on it. scan_jobs holds live customer
--      scans and is written on every heartbeat; a ledger is not worth a lock on
--      the hot path of the product.
--   2. CORRECTNESS. A ledger must be able to record executions that have no
--      job. A scheduler skip (R3.2.2) happens precisely because no job was
--      created. An idle fleet pass has no job and no batch. An FK would force
--      those rows to NULL out their subject or not exist at all -- and the row
--      that does not exist is the one whose absence reads as "nothing went
--      wrong".
--   3. LIFETIME. `ON DELETE CASCADE` (the shape content_runs uses) would delete
--      the history of a job along with the job. The record of what happened
--      must outlive the thing it happened to; that is the whole point of a
--      ledger. `ON DELETE SET NULL` avoids that but still needs the lock.
-- The cost of no FK is that a typo'd uuid is storable. That is a ledger of a
-- wrong id -- recoverable, and visible in a join that returns nothing -- rather
-- than a lock on customer traffic. scan_runs_subject_chk below still refuses a
-- row that names NOTHING at all, because an unattributable ledger row is not
-- evidence of anything.
CREATE TABLE IF NOT EXISTS scan_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- WHO ran. 'probe-fleet' (worker/), 'scan-chunk' (src/lib/workers/scanWorker.js),
  -- 'scheduler'. Deliberately NOT a closed CHECK vocabulary, unlike `outcome`:
  -- R3.2.1/R3.2.2 add runners and phases as they wire their call sites, and a
  -- closed list here would force each of them to ALTER a table that by then
  -- holds live rows. A mis-typed runner splits a report; a mis-typed OUTCOME
  -- reads as success, which is why only that one is closed.
  runner text NOT NULL,
  -- WHAT part. Fleet: 'probe_batch' | 'idle'. Chunk: 'sourcing' | 'probing' |
  -- 'scoring' | 'finalize'.
  phase text NOT NULL,
  -- The identity that would hold the lease: fleet `config.workerId`, or
  -- jobLease's `lease_owner`. Lets a run be traced to the container that ran it.
  worker_id text,

  -- Plain uuids, NOT foreign keys (see header).
  scan_job_id uuid,
  batch_id uuid,
  brand text,

  -- NULL while the run is open. Closed vocabulary, R3.2.1's:
  --   succeeded -- the work ran and finished
  --   failed    -- it ran and did not finish
  --   skipped   -- it declined to run, and `reason` says why
  --   reaped    -- it never closed itself; a sweep closed it (R3.3.2)
  --   noop      -- it ran, correctly, and there was nothing to do
  -- 'noop' and 'skipped' are separate on purpose: an empty queue is a MEASURED
  -- zero, a skip is a decision not to measure, and collapsing them is how a
  -- fleet that is being starved comes to look like a fleet that is idle.
  outcome text,
  -- Required for every outcome except 'succeeded' (scan_runs_reason_chk). An
  -- unexplained skip is the thing R3.2.2 exists to abolish; the schema refuses
  -- to store one.
  reason text,

  -- No DEFAULT 0. NULL means NOT MEASURED. See the header.
  probes_attempted integer,
  probes_succeeded integer,
  -- Errors this run absorbed and continued past. A run that "succeeded" after
  -- swallowing nine failures is not the same run as one that met none, and
  -- without this column the two are identical in the ledger.
  errors_recovered integer,

  error text,
  detail jsonb,

  started_at   timestamptz NOT NULL DEFAULT now(),
  -- Moved by heartbeat_scan_run while the work is in flight. An open row whose
  -- heartbeat has gone stale is a dead writer, and the partial index below is
  -- what makes finding those cheap (R3.3.2).
  heartbeat_at timestamptz NOT NULL DEFAULT now(),
  ended_at     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),

  -- Duration is `ended_at - started_at` and is deliberately NOT stored: a
  -- second copy of a derivable number is a second thing that can disagree with
  -- the first, and content_runs.duration_ms is already a column nothing checks.

  CONSTRAINT scan_runs_runner_chk CHECK (btrim(runner) <> '' AND btrim(phase) <> ''),
  CONSTRAINT scan_runs_outcome_chk
    CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'skipped', 'reaped', 'noop')),
  -- Open xor closed. Neither half-state is representable.
  CONSTRAINT scan_runs_open_chk CHECK ((outcome IS NULL) = (ended_at IS NULL)),
  -- Anything that is not a clean success has to say why.
  CONSTRAINT scan_runs_reason_chk
    CHECK (outcome IS NULL OR outcome = 'succeeded' OR btrim(COALESCE(reason, '')) <> ''),
  -- A row that names no job, no batch, no brand and no worker is a ledger entry
  -- about nobody.
  CONSTRAINT scan_runs_subject_chk
    CHECK (scan_job_id IS NOT NULL OR batch_id IS NOT NULL OR brand IS NOT NULL OR worker_id IS NOT NULL),
  -- Counters may be unknown (NULL), never negative, and "succeeded" can never
  -- exceed "attempted" -- a >100% success rate is the arithmetic signature of
  -- the false-100% bug this rebuild is named after.
  CONSTRAINT scan_runs_counts_chk CHECK (
    COALESCE(probes_attempted, 0) >= 0
    AND COALESCE(probes_succeeded, 0) >= 0
    AND COALESCE(errors_recovered, 0) >= 0
    AND (probes_attempted IS NULL OR probes_succeeded IS NULL OR probes_succeeded <= probes_attempted)
  )
);

-- "Show me this job's run history" -- the status route's read (R3.2.3), which
-- today guesses from heartbeat_at instead.
CREATE INDEX IF NOT EXISTS scan_runs_job_idx
  ON scan_runs (scan_job_id, started_at DESC)
  WHERE scan_job_id IS NOT NULL;

-- "What happened to this probe batch" -- joins the ledger to probe_tasks.batch_id
-- without a foreign key on either side.
CREATE INDEX IF NOT EXISTS scan_runs_batch_idx
  ON scan_runs (batch_id, started_at DESC)
  WHERE batch_id IS NOT NULL;

-- The reaper's hot path (R3.3.2): open runs ordered by how stale their
-- heartbeat is. Partial on `ended_at IS NULL` so the index stays the size of
-- the work in flight rather than the size of all history.
CREATE INDEX IF NOT EXISTS scan_runs_open_idx
  ON scan_runs (heartbeat_at)
  WHERE ended_at IS NULL;

-- "Is the fleet alive, and what have the last N passes done" -- the dashboard
-- read. Callers that do not want the fleet's idle passes filter on
-- `phase <> 'idle'`; see THE IDLE ROWS note at the foot of this file.
CREATE INDEX IF NOT EXISTS scan_runs_runner_idx
  ON scan_runs (runner, started_at DESC);

ALTER TABLE scan_runs ENABLE ROW LEVEL SECURITY;
DO $policy$
BEGIN
  -- House style since 001: ENABLE ROW LEVEL SECURITY plus an anon-all policy.
  -- The fleet holds the service role key and bypasses RLS; the Next app holds
  -- only the anon key, so without this policy the app could not write a run.
  -- Tightening RLS is a schema-wide decision, not this migration's to make.
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE tablename = 'scan_runs' AND policyname = 'Allow anon all on scan_runs'
  ) THEN
    CREATE POLICY "Allow anon all on scan_runs" ON scan_runs
      FOR ALL TO anon USING (true) WITH CHECK (true);
  END IF;
END
$policy$;

-- ---------------------------------------------------------------------------
-- open / heartbeat / close
-- ---------------------------------------------------------------------------
--
-- WHY THESE ARE SQL FUNCTIONS AND NOT TWO JS HELPERS
-- The same reason migration 010 put the claim in SQL: the fleet in worker/ may
-- not import from src/ (src/lib/workerIsolation.test.mjs fails the build on any
-- crossing import), so a JS implementation would have to exist twice and would
-- drift. The open/close pairing above is an INVARIANT, and an invariant with
-- two implementations has two chances to be wrong. One function, two callers.

-- Open a run. Returns the whole row, so the caller has the id it must close.
--
-- Standing rule 2: this never fail-softs. There is no "could not open, carry
-- on" path, because a batch that runs with no ledger row is a batch that
-- happened invisibly, and its absence from the ledger reads as "the fleet was
-- idle".
CREATE OR REPLACE FUNCTION open_scan_run(
  p_runner      text,
  p_phase       text,
  p_worker_id   text  DEFAULT NULL,
  p_scan_job_id uuid  DEFAULT NULL,
  p_batch_id    uuid  DEFAULT NULL,
  p_brand       text  DEFAULT NULL,
  p_detail      jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_row scan_runs;
BEGIN
  IF p_runner IS NULL OR btrim(p_runner) = '' THEN
    RAISE EXCEPTION 'open_scan_run: p_runner is required (a run nobody ran cannot be attributed)';
  END IF;
  IF p_phase IS NULL OR btrim(p_phase) = '' THEN
    RAISE EXCEPTION 'open_scan_run: p_phase is required (a run with no phase says nothing about what executed)';
  END IF;

  INSERT INTO scan_runs (runner, phase, worker_id, scan_job_id, batch_id, brand, detail)
  VALUES (btrim(p_runner), btrim(p_phase), p_worker_id, p_scan_job_id, p_batch_id, p_brand, p_detail)
  RETURNING * INTO v_row;

  RETURN to_jsonb(v_row);
END;
$fn$;

-- Move the heartbeat of an OPEN run.
--
-- WHY THIS RAISES INSTEAD OF RETURNING 0
-- "I heartbeat a run that is closed, reaped or does not exist" is a bug in the
-- caller every single time, and a 0 row count is exactly the shape a caller
-- ignores. The writer needs to learn that something else has already closed its
-- run -- typically the reaper, which means its lease is gone too.
CREATE OR REPLACE FUNCTION heartbeat_scan_run(p_run_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_now     timestamptz := now();
  v_outcome text;
  v_found   boolean;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'heartbeat_scan_run: p_run_id is required';
  END IF;

  UPDATE scan_runs
     SET heartbeat_at = v_now
   WHERE id = p_run_id
     AND ended_at IS NULL;

  IF FOUND THEN
    RETURN jsonb_build_object('run_id', p_run_id, 'heartbeat_at', v_now, 'open', true);
  END IF;

  SELECT true, outcome INTO v_found, v_outcome FROM scan_runs WHERE id = p_run_id;
  IF v_found IS NULL THEN
    RAISE EXCEPTION 'heartbeat_scan_run: no run % exists', p_run_id;
  END IF;
  RAISE EXCEPTION 'heartbeat_scan_run: run % is already closed (outcome=%); something else ended it',
    p_run_id, v_outcome;
END;
$fn$;

-- Close a run with its outcome, reason and counters. Returns the closed row.
--
-- WHY A SECOND CLOSE RAISES
-- Two closes on one run are two different accounts of the same execution, and
-- the second silently overwriting the first would let a late writer relabel a
-- 'reaped' run as 'succeeded' -- work that was taken away from it reported as
-- work it finished. The first close wins and the loser is told, loudly, which
-- outcome beat it.
--
-- NULL counters do NOT overwrite values already on the row, and a NULL counter
-- stays NULL: "not measured". Never coalesce these to 0 (see the header).
CREATE OR REPLACE FUNCTION close_scan_run(
  p_run_id           uuid,
  p_outcome          text,
  p_reason           text    DEFAULT NULL,
  p_probes_attempted integer DEFAULT NULL,
  p_probes_succeeded integer DEFAULT NULL,
  p_errors_recovered integer DEFAULT NULL,
  p_error            text    DEFAULT NULL,
  p_detail           jsonb   DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_now  timestamptz := now();
  v_row  scan_runs;
  v_prior scan_runs;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'close_scan_run: p_run_id is required';
  END IF;
  IF p_outcome IS NULL OR p_outcome NOT IN ('succeeded', 'failed', 'skipped', 'reaped', 'noop') THEN
    RAISE EXCEPTION 'close_scan_run: outcome must be one of succeeded/failed/skipped/reaped/noop, got %',
      COALESCE(p_outcome, 'null');
  END IF;
  -- Same rule as scan_runs_reason_chk, raised here so the caller gets a
  -- sentence instead of a constraint name. An unexplained non-success is the
  -- discarded skip reason R3.2.2 is about.
  IF p_outcome <> 'succeeded' AND btrim(COALESCE(p_reason, '')) = '' THEN
    RAISE EXCEPTION 'close_scan_run: outcome "%" requires a reason -- a skip with no reason is the one this ledger exists to record',
      p_outcome;
  END IF;

  UPDATE scan_runs t
     SET outcome          = p_outcome,
         reason           = COALESCE(p_reason, t.reason),
         probes_attempted = COALESCE(p_probes_attempted, t.probes_attempted),
         probes_succeeded = COALESCE(p_probes_succeeded, t.probes_succeeded),
         errors_recovered = COALESCE(p_errors_recovered, t.errors_recovered),
         error            = COALESCE(p_error, t.error),
         detail           = CASE
                              WHEN p_detail IS NULL THEN t.detail
                              ELSE COALESCE(t.detail, '{}'::jsonb) || p_detail
                            END,
         heartbeat_at     = v_now,
         ended_at         = v_now
   WHERE t.id = p_run_id
     AND t.ended_at IS NULL
  RETURNING t.* INTO v_row;

  IF v_row.id IS NOT NULL THEN
    RETURN to_jsonb(v_row);
  END IF;

  SELECT * INTO v_prior FROM scan_runs WHERE id = p_run_id;
  IF v_prior.id IS NULL THEN
    RAISE EXCEPTION 'close_scan_run: no run % exists -- refusing to report a close that wrote nothing', p_run_id;
  END IF;
  RAISE EXCEPTION 'close_scan_run: run % was already closed as "%" at %; refusing to overwrite it with "%"',
    p_run_id, v_prior.outcome, v_prior.ended_at, p_outcome;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- THE IDLE ROWS, AND WHAT THEY COST
-- ---------------------------------------------------------------------------
-- The fleet writes one row per PASS, not one per claimed batch: a pass that
-- claimed nothing closes as 'noop' with reason 'queue_empty' or 'all_leased'.
-- That is the point -- "the fleet looked and the queue was empty at 12:00:10"
-- is a measured zero, and its absence is the only thing that can distinguish a
-- dead container from a quiet one.
--
-- The cost, stated rather than discovered later: at the default
-- FLEET_IDLE_POLL_MS of 10s an idle container writes ~8.6k rows/day (a few MB a
-- month). Nothing accrues today -- the fleet is not deployed until R1.3 lands a
-- real adapter. Retention/rollup is R3.2.3's to decide when it builds the
-- reader; `scan_runs_runner_idx` plus `phase <> 'idle'` serves the dashboard
-- until then.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS MIGRATION DOES NOT DO
-- ---------------------------------------------------------------------------
-- * No reaper. `scan_runs_open_idx` makes the sweep cheap, but the policy --
--   how stale is dead, what closes as 'reaped' -- is R3.3.2's, and writing it
--   here would mean a sweep nothing calls.
-- * Nothing touches probe_tasks. Its dead `max_attempts`/'abandoned' pair
--   (R1.2.2's hand-off) is a queue retry policy, not a ledger concern; it
--   belongs with R3.3.1 ("attempts column with a cap of 3 ... terminal with
--   reason 'max_attempts'"), which is the task that already owns exactly that
--   rule for scan_jobs. It is NOT R1.5.1, which is a storage bucket.
--   Until then a task whose worker keeps dying is still reclaimed forever with
--   `attempts` climbing past `max_attempts` -- unchanged by this migration and
--   still true.
