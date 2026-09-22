/**
 * R1.2.23(a) — retention for the fleet's idle `noop` rows in `scan_runs`.
 *
 * THE MEASUREMENT THAT CAUSED THIS, taken on the live project 2026-09-22:
 * 20,399 `probe-fleet` rows in `scan_runs`, the twelve most recent one per
 * ~10.4 s, every one of them `phase = 'idle'`, `outcome = 'noop'`. That is
 * ~8,250 rows/day — ~250k rows a month — accruing forever on a FREE 500 MB
 * Supabase project, with nothing in the system pruning `scan_runs`.
 * `011_scan_runs.sql` predicted the cost in its own header and deferred the
 * policy; the fleet deployed before the policy was written, so it is written
 * here.
 *
 * THE OPERATOR'S DECISION, 2026-09-22, recorded so nobody re-derives it:
 * delete `noop` rows older than 30 DAYS, and never touch anything else. Long
 * enough that "was the fleet alive last month" is still answerable from the
 * ledger; short enough that the idle stream stops eating a free project.
 *
 * HOW "never deletes a non-noop row" IS GUARANTEED
 * Not by this file being careful. The delete lives in ONE place —
 * `prune_noop_scan_runs` in `supabase/migrations/022_scan_runs_retention.sql`
 * — whose `outcome = 'noop'` filter is a literal in the function body and is
 * NOT one of its arguments. This module cannot widen it, and neither can a
 * caller: `pruneNoopScanRuns` takes no outcome, and REFUSES (loudly) if handed
 * one, so a future call site cannot quietly acquire the ability to delete a
 * 'failed' run. The same function also refuses to delete an OPEN row
 * (`ended_at IS NULL`), which after R1.2.23(b) is a worker that is idle right
 * now — see that file's header for why age is counted from `ended_at`.
 *
 * WHAT IT REPORTS
 * A measured count or nothing. If the RPC errors, or answers with something
 * that is not a count, this returns `deleted: null` with a `reason` — never
 * `?? 0`, because "0 deleted" is exactly what a healthy already-clean table
 * says, and the two must not be the same answer (standing rule 1). The route
 * turns `ok: false` into an HTTP 500 so platform cron alerting sees it.
 *
 * Driven daily by GET /api/scan-runs/retention (vercel.json).
 */

import { supabase } from "./db.js";

/** The operator's window. See the header — this number is a decision, not a default. */
export const SCAN_RUNS_RETENTION_DAYS = 30;

/**
 * The ONLY outcome retention may delete. Exported so the tests can assert it,
 * never so a caller can substitute it.
 */
export const SCAN_RUNS_DELETABLE_OUTCOME = "noop";

/**
 * The closed outcome vocabulary, read off `011_scan_runs.sql`'s
 * scan_runs_outcome_chk. The tests walk this list and assert that every value
 * other than SCAN_RUNS_DELETABLE_OUTCOME survives retention, so adding a sixth
 * outcome here without thinking about retention turns a test red rather than
 * silently making rows deletable.
 */
export const SCAN_RUNS_OUTCOMES = Object.freeze([
  "succeeded",
  "failed",
  "skipped",
  "reaped",
  "noop",
]);

/** The one delete in the system. `supabase/migrations/022_scan_runs_retention.sql`. */
export const SCAN_RUNS_PRUNE_FN = "prune_noop_scan_runs";

/**
 * Rows per statement. Small enough that one pass never holds a long lock on a
 * table the fleet writes to every 10 s; large enough that the 20k-row backlog
 * clears on the first cron run.
 */
const DEFAULT_BATCH_SIZE = 5000;
const MAX_BATCH_SIZE = 50000;

/**
 * Batches per pass. A cap, not a target: if retention somehow has more than
 * 100k rows to remove, the pass stops and says `truncated: true` rather than
 * running until the platform kills the request mid-delete.
 */
const DEFAULT_MAX_BATCHES = 20;

/**
 * The floor `prune_noop_scan_runs` itself enforces (v_min_age_days). Repeated
 * here only so a bad `retentionDays` is refused before a network call, with a
 * sentence instead of a Postgres exception.
 */
const MIN_RETENTION_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The cutoff instant: rows that ENDED before this are old enough to delete.
 *
 * @param {string} nowIso  the clock, injected — never Date.now() inside here,
 *                         so the boundary is exercisable in a test.
 * @param {number} retentionDays
 * @returns {string} ISO instant
 */
export function retentionCutoff(nowIso, retentionDays = SCAN_RUNS_RETENTION_DAYS) {
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) {
    // Never fall back to Date.now(): a pass that silently substituted its own
    // clock for the one it was given would compute a cutoff nobody asked for
    // and then delete against it.
    throw new Error(
      `scan-runs retention: nowIso "${nowIso}" is not a parsable instant — refusing to guess the clock.`
    );
  }
  if (!Number.isFinite(retentionDays) || retentionDays < MIN_RETENTION_DAYS) {
    throw new Error(
      `scan-runs retention: retentionDays must be a number >= ${MIN_RETENTION_DAYS}, got ${retentionDays}.`
    );
  }
  return new Date(nowMs - retentionDays * DAY_MS).toISOString();
}

/**
 * The count the RPC gave us, or null.
 *
 * Deliberately NOT `Number(value)`: `Number(null)` is 0, and `null` is exactly
 * what PostgREST hands back when a call returned no body. Coercing it would
 * manufacture the confident zero this whole module exists to avoid. Only a real
 * integer, or a string of digits (a bigint-shaped body), counts as measured.
 */
function usableCount(value) {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : null;
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return null;
}

/**
 * Delete `noop` scan_runs rows older than the window. Dependency-injected:
 * pass a `client` with `.rpc()` and a `nowIso` and nothing touches the network.
 *
 * @param {object} deps
 * @param {{rpc: Function}} [deps.client]  Supabase client (defaults to the app's)
 * @param {string} [deps.nowIso]           the clock
 * @param {number} [deps.retentionDays]    window override, floored at 7 days
 * @param {number} [deps.batchSize]
 * @param {number} [deps.maxBatches]
 * @returns {Promise<object>} the report; `deleted` is null when not measured
 */
export async function pruneNoopScanRuns(deps = {}) {
  // Standing rule: the outcome filter is not the caller's to choose. Refusing
  // loudly beats ignoring the key, because a call site that passes
  // `{ outcome: "failed" }` believes it is doing something.
  if (Object.prototype.hasOwnProperty.call(deps, "outcome")) {
    throw new Error(
      "scan-runs retention: `outcome` is not an argument. The filter is a literal in " +
        "prune_noop_scan_runs (022) so that no caller can widen retention past 'noop'."
    );
  }

  const client = deps.client ?? supabase;
  const nowIso = deps.nowIso ?? new Date().toISOString();
  const retentionDays = deps.retentionDays ?? SCAN_RUNS_RETENTION_DAYS;
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatches = deps.maxBatches ?? DEFAULT_MAX_BATCHES;

  // Thrown, not reported: these are cutoff arithmetic errors, and a pass that
  // could not even work out WHAT to delete has measured nothing at all.
  const cutoff = retentionCutoff(nowIso, retentionDays);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new Error(
      `scan-runs retention: batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}, got ${batchSize}.`
    );
  }
  if (!Number.isInteger(maxBatches) || maxBatches < 1) {
    throw new Error(
      `scan-runs retention: maxBatches must be a positive integer, got ${maxBatches}.`
    );
  }

  const base = {
    table: "scan_runs",
    outcome: SCAN_RUNS_DELETABLE_OUTCOME,
    retention_days: retentionDays,
    cutoff,
    batch_size: batchSize,
  };

  if (!client || typeof client.rpc !== "function") {
    // Not "0 deleted". Nothing was looked at.
    return {
      ...base,
      ok: false,
      deleted: null,
      batches: 0,
      truncated: false,
      reason:
        "Supabase is not configured — scan-runs retention did not run. This is not '0 rows deleted'.",
    };
  }

  let deleted = null;
  let batches = 0;
  for (; batches < maxBatches; ) {
    const { data, error } = await client.rpc(SCAN_RUNS_PRUNE_FN, {
      p_cutoff: cutoff,
      p_limit: batchSize,
      // No p_outcome. There is no such parameter, by design (022).
    });
    batches += 1;

    if (error) {
      return {
        ...base,
        ok: false,
        // Whatever earlier batches measured is kept — it happened — but the
        // pass is not reported as complete.
        deleted,
        batches,
        truncated: false,
        reason:
          deleted === null
            ? `${SCAN_RUNS_PRUNE_FN} failed before deleting anything: ${error.message || error}`
            : `${SCAN_RUNS_PRUNE_FN} deleted ${deleted} row(s), then failed: ${error.message || error}`,
      };
    }

    const count = usableCount(data);
    if (count === null) {
      return {
        ...base,
        ok: false,
        deleted,
        batches,
        truncated: false,
        reason:
          `${SCAN_RUNS_PRUNE_FN} returned ${JSON.stringify(data)}, which is not a row count — ` +
          "refusing to report a number the database did not give us.",
      };
    }

    deleted = (deleted ?? 0) + count;
    // A short batch means the old end of the table is exhausted (or a
    // concurrently-locked row was skipped, which tomorrow's pass collects).
    if (count < batchSize) {
      return { ...base, ok: true, deleted, batches, truncated: false, reason: null };
    }
  }

  return {
    ...base,
    ok: true,
    deleted,
    batches,
    truncated: true,
    // Truncation is not a failure, but it must never read as "the table is
    // clean now" — it is explicitly "more remains".
    reason: `Batch cap reached (${maxBatches} × ${batchSize}); rows older than the window remain.`,
  };
}
