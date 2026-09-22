-- 022: retention for the fleet's idle noop rows in scan_runs (R1.2.23).
-- Plan: docs/plans/2026-08-29-rebuild-roadmap.md R1.2.23. Table: 011_scan_runs.sql.
--
-- PURELY ADDITIVE: one new partial index and one new function. It creates no
-- table, drops nothing, alters no column and changes no constraint. Safe to
-- re-run.
--
-- ---------------------------------------------------------------------------
-- THE MEASUREMENT THAT PRODUCED THIS FILE
-- ---------------------------------------------------------------------------
-- Production, 2026-09-22: 20,399 rows in `scan_runs` with runner='probe-fleet'.
-- The twelve most recent were one per ~10.4 s, every one of them
-- `phase=idle outcome=noop` -- an idle fleet pass writing a closed row per
-- poll. 86400 / 10.4 = ~8,300 rows/day; call it ~8,250. Nothing has ever
-- pruned this table, and the project is on the FREE Supabase tier with a
-- 500 MB ceiling.
--
-- 011's own header predicted this cost ("~8.6k rows/day ... Retention/rollup is
-- R3.2.3's to decide") and deferred it. R3.2.3 built the reader and did not
-- take the decision, so the rows accrued.
--
-- OPERATOR DECISION, recorded 2026-09-22 on the R1.2.23 ledger row: option (c)
-- -- do both halves. (a) is this retention pass, with a **30-day window chosen
-- by the operator**; (b) makes an idle worker hold ONE open row heartbeated for
-- the whole idle stretch instead of one closed row per pass. (b) stops the
-- bleeding; (a) drains what has already pooled and bounds the table forever.
-- Neither replaces the other, and this file is not the place to re-litigate it.
--
-- Steady state at 30 days if (b) never shipped: 8,250 * 30 = ~247,500 noop rows
-- ~= 60 MB of a 500 MB budget. With (b) shipped the noop inflow is a few rows
-- per pod per day and the table's size is dominated by real work again.
--
-- ---------------------------------------------------------------------------
-- WHY THE DELETE IS A FUNCTION AND NOT A POSTGREST STATEMENT
-- ---------------------------------------------------------------------------
-- An earlier draft of this file shipped the index alone and argued that the
-- delete should live in src/lib/scanRunsRetention.js as one PostgREST
-- statement, so its test could walk the outcome vocabulary and prove a
-- non-noop row survives. That argument does not survive contact with the
-- caller: scanRunsRetention.js does not issue a delete, it calls
-- `rpc('prune_noop_scan_runs', { p_cutoff, p_limit })` in a batched loop,
-- because PostgREST cannot put a LIMIT on a DELETE and an unbounded delete of
-- a 20,000-row backlog holds one transaction open over the whole ledger. The
-- file and its caller disagreed, and a function that does not exist fails at
-- the first nightly run with "Could not find the function" -- caught here on
-- 2026-09-22 before it shipped, by reading the caller rather than the tests,
-- which stub `.rpc` and are green either way.
--
-- So the function BELOW is the delete, and it takes no outcome parameter:
-- 'noop' is a literal inside it, which is the property the accept criterion
-- asks for ("non-noop rows are never deleted by retention"). A caller cannot
-- widen retention because there is no argument through which to widen it, and
-- src/lib/scanRunsRetention.js refuses a deps.outcome key for the same reason.
-- The index is what makes each batch a range scan rather than a seq scan.
--
-- ---------------------------------------------------------------------------
-- WHY THIS INDEX, AND NOT (outcome, started_at)
-- ---------------------------------------------------------------------------
-- The retention delete is, verbatim (see prune_noop_scan_runs below):
--
--   DELETE FROM scan_runs
--    WHERE outcome = 'noop' AND ended_at IS NOT NULL AND ended_at < p_cutoff
--
-- A partial index whose predicate is the delete's non-range filters, keyed on
-- the range column, IS that row set in sorted order: the planner takes a
-- straight index range scan from the left edge to the cutoff and touches no
-- heap tuple that it is not about to delete.
--
-- AGE IS COUNTED FROM `ended_at`, NOT `started_at`. Before half (b) the two
-- were the same instant to within a millisecond, so either would have done.
-- After it, an idle stretch can last days: a row that OPENED 40 days ago and
-- closed an hour ago is an hour-old record of recent idleness, and keying
-- retention on `started_at` would delete it the moment it was written. The
-- window means "30 days of finished history", so it is measured from the end.
--
-- A plain composite `(outcome, ended_at)` would serve the same query, but it
-- indexes every row in the table -- including the succeeded/failed/skipped rows
-- retention must never look at -- and carries the `outcome` text in every
-- entry. On a FREE 500 MB project the smaller structure wins: ~20 bytes per
-- entry here versus ~30, over the ~95% of the table that is noop.
--
-- `ended_at IS NOT NULL` is in the predicate, not just in the delete, so that
-- the index cannot serve a query that omits it. See THE OPEN-ROW RULE below.
--
-- NOT `CONCURRENTLY`, deliberately: scripts/setup-supabase.mjs runs each
-- migration file inside one transaction, and CREATE INDEX CONCURRENTLY cannot
-- run in a transaction block -- the runner would abort the whole file. A plain
-- CREATE INDEX takes a SHARE lock that blocks INSERTs into scan_runs for the
-- duration; at ~20k rows that is well under a second, and the only writer being
-- delayed is the fleet's own ledger, which retries on the next pass. An
-- operator applying this to a much larger table should run the CREATE INDEX
-- CONCURRENTLY by hand in the SQL editor instead -- same name, same predicate.
--
-- ---------------------------------------------------------------------------
-- THE OPEN-ROW RULE: `ended_at IS NOT NULL` IS NOT REDUNDANT
-- ---------------------------------------------------------------------------
-- 011's scan_runs_open_chk already makes `(outcome IS NULL) = (ended_at IS
-- NULL)`, so TODAY a row with outcome='noop' is closed by construction and the
-- second condition selects nothing extra. It is written out anyway, in both the
-- index and the delete, for one reason: after half (b) an idle worker holds an
-- OPEN row heartbeated for as long as it stays idle, and a pod idle for more
-- than 30 days holds a row older than the cutoff that is still being written
-- to. If scan_runs_open_chk is ever relaxed -- and a constraint that must never
-- be relaxed is exactly the kind that is -- the only thing standing between
-- retention and a live worker's row is this clause. Deleting a row out from
-- under the process that is heartbeating it makes the next heartbeat_scan_run
-- RAISE "no run % exists", and the fleet loses its pass for a reason the
-- operator would spend a day tracing.
--
-- Applied <=> this returns one row:
--
--   SELECT c.relname, pg_get_indexdef(c.oid) AS def
--     FROM pg_class c
--     JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public' AND c.relname = 'scan_runs_noop_retention_idx';
--
-- The returned def must contain both `outcome = 'noop'` and
-- `ended_at IS NOT NULL`. An index of this name whose predicate says only
-- `outcome = 'noop'` is an OLDER version of this file and does not enforce the
-- open-row rule -- drop it by hand and re-apply.

CREATE INDEX IF NOT EXISTS scan_runs_noop_retention_idx
  ON scan_runs (ended_at)
  WHERE outcome = 'noop' AND ended_at IS NOT NULL;

COMMENT ON INDEX scan_runs_noop_retention_idx IS
  'R1.2.23 retention: the exact row set GET /api/scan-runs/retention deletes -- closed noop rows older than SCAN_RUNS_RETENTION_DAYS (30, operator''s window) in src/lib/scanRunsRetention.js. Partial on outcome/ended_at so a non-noop or still-open row is not reachable through it.';

-- ---------------------------------------------------------------------------
-- THE DELETE
-- ---------------------------------------------------------------------------
-- Age is counted from ended_at; see the index section above for why.
-- Batched: one call deletes at most p_limit rows and returns how many it
-- actually deleted, so the caller loops until a short batch says the old end of
-- the table is exhausted. The cap is what keeps the transaction, and the lock
-- footprint on a table the fleet writes to every few seconds, bounded.
--
-- `outcome = 'noop'` is a LITERAL. There is deliberately no p_outcome: the
-- accept criterion is that retention never deletes a non-noop row, and the
-- cheapest way to guarantee that is to give no caller a way to ask.
--
-- FOR UPDATE SKIP LOCKED: a row another transaction holds is left for
-- tomorrow's pass rather than blocking tonight's. Retention is never urgent.
CREATE OR REPLACE FUNCTION prune_noop_scan_runs(
  p_cutoff timestamptz,
  p_limit  integer DEFAULT 5000
)
RETURNS integer
LANGUAGE plpgsql
AS $fn$
DECLARE
  v_deleted      integer;
  v_min_cutoff   timestamptz := now() - interval '7 days';
BEGIN
  IF p_cutoff IS NULL THEN
    RAISE EXCEPTION 'prune_noop_scan_runs: p_cutoff is required -- refusing to guess a retention window';
  END IF;
  -- The route chooses 30 days, but the function is exposed through PostgREST
  -- too. Keep the safety floor at the deletion boundary so a direct RPC caller
  -- cannot turn retention into "delete today's history".
  IF p_cutoff > v_min_cutoff THEN
    RAISE EXCEPTION
      'prune_noop_scan_runs: p_cutoff must be at least 7 days old, got % (newest allowed %)',
      p_cutoff,
      v_min_cutoff;
  END IF;
  -- Bound one transaction even when the function is called directly rather
  -- than through scanRunsRetention.js's 5,000-row batches.
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 50000 THEN
    RAISE EXCEPTION 'prune_noop_scan_runs: p_limit must be between 1 and 50000, got %', COALESCE(p_limit::text, 'null');
  END IF;

  WITH doomed AS (
    SELECT id
      FROM scan_runs
     WHERE outcome = 'noop'
       AND ended_at IS NOT NULL
       AND ended_at < p_cutoff
     ORDER BY ended_at
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  DELETE FROM scan_runs s
   USING doomed d
   WHERE s.id = d.id;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$fn$;

COMMENT ON FUNCTION prune_noop_scan_runs(timestamptz, integer) IS
  'R1.2.23 retention: deletes at most p_limit CLOSED noop scan_runs rows that ENDED before p_cutoff and returns the count. No outcome parameter by design -- a non-noop row is unreachable through this function. Called in a batched loop by src/lib/scanRunsRetention.js.';
