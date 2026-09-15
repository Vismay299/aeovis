import { supabase } from "./db.js";

/**
 * The scan_runs ledger, from the web app's side (R1.2.3).
 *
 * One row per execution: opened before the work, heartbeated while it is in
 * flight, closed with an outcome, a reason and measured counters. Migration
 * `supabase/migrations/011_scan_runs.sql` owns the table and the three
 * functions this file calls.
 *
 * WHY IT EXISTS
 * An execution currently leaves behind only its side effects, so a chunk that
 * ran and did nothing, a chunk that never ran, a chunk that died halfway and a
 * chunk that skipped for a structured reason are all the same evidence:
 * `scan_jobs.heartbeat_at` moved, or it did not. Standing rule 1 — a measured
 * zero must not look like a run that never happened — cannot be satisfied by a
 * reader that has nothing but heartbeats to read. This is that something.
 *
 * WHY THE OPEN/CLOSE PAIRING IS IN SQL AND NOT HERE
 * The fleet in worker/ may not import from src/ (src/lib/workerIsolation.test.mjs
 * fails the build on any crossing import), so anything implemented in this file
 * would have to exist twice and would drift. `open_scan_run`,
 * `heartbeat_scan_run` and `close_scan_run` are one implementation with two
 * callers. What IS duplicated — the vocabulary and the two pure readers below —
 * is duplicated deliberately and checked by a guard test in
 * src/lib/scanRuns.test.mjs.
 *
 * WIRED BY: R3.2.1 (the scan chunk's one row per execution) and R3.2.2 (the
 * skip reasons that used to be discarded — the scheduler's declined schedules
 * get rows of their own under RUNNERS.SCHEDULER, and the chunk's in-flight
 * skips ride on its single row in `detail.skips`). Both live in
 * src/lib/workers/scanWorker.js. STILL UNWIRED: R3.2.3's status route reads
 * nothing from here yet, so a row written today is written for a reader that
 * does not exist — which is why the writes must be right before it does.
 * `worker/src/lib/runLedger.js` is the fleet's copy and IS wired, in
 * worker/src/index.js.
 *
 * `deps.client` is test-only injection, matching db.js, jobLease.js and
 * probeQueue.js.
 */

/**
 * The closed outcome vocabulary, identical to migration 011's
 * `scan_runs_outcome_chk`. Closed because an outcome outside the list is not a
 * new fact, it is a typo that a reader will round up to success.
 *
 * NOOP and SKIPPED are separate on purpose: 'noop' means the work ran and there
 * was genuinely nothing to do (a measured zero), 'skipped' means it declined to
 * run at all. Collapsing them is how a starved fleet comes to look idle.
 */
export const RUN_OUTCOMES = Object.freeze({
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  SKIPPED: "skipped",
  REAPED: "reaped",
  NOOP: "noop",
});

/** The same list as an array, in the order migration 011's CHECK writes it. */
export const RUN_OUTCOME_LIST = Object.freeze([
  RUN_OUTCOMES.SUCCEEDED,
  RUN_OUTCOMES.FAILED,
  RUN_OUTCOMES.SKIPPED,
  RUN_OUTCOMES.REAPED,
  RUN_OUTCOMES.NOOP,
]);

/**
 * Who ran. Open in the schema (see 011's comment) but named here so the app
 * spells them one way.
 *
 * REAPER joined the list in R3.3.4. It was declared locally in scanWorker.js by
 * R3.3.2 (which could not edit this file), which meant the one runner name that
 * appears on OTHER runners' rows — every reaped row records `reaped_by` — lived
 * somewhere a reader of this vocabulary would not find it. `worker/src/lib/
 * runLedger.js` carries the same four names and a guard test in
 * src/lib/scanRuns.test.mjs fails if the two lists ever differ.
 */
export const RUNNERS = Object.freeze({
  FLEET: "probe-fleet",
  SCAN_CHUNK: "scan-chunk",
  SCHEDULER: "scheduler",
  REAPER: "reaper",
});

function resolveClient(deps) {
  return deps && Object.prototype.hasOwnProperty.call(deps, "client") ? deps.client : supabase;
}

/**
 * No client is a refusal, never a silently skipped ledger write.
 *
 * A run that could not be recorded must not proceed as though it had been: the
 * missing row is indistinguishable from an execution that never happened, which
 * is the exact reading this ledger exists to make impossible.
 */
function requireClient(client, fn) {
  if (!client) {
    throw new Error(
      `${fn}: no Supabase client is configured, so the scan_runs ledger is unreachable. ` +
        `Refusing rather than continuing unrecorded: an unrecorded run and a run that ` +
        `never happened look identical afterwards.`
    );
  }
  return client;
}

/**
 * Rethrow a PostgREST error with its envelope intact (standing rule 2).
 * code/details/hint survive on the thrown Error, the original stays as `cause`.
 */
function throwDbError(fn, error) {
  const err = new Error(
    `${fn}: ${error.message || "database error"}` +
      (error.code ? ` [${error.code}]` : "") +
      (error.details ? ` — ${error.details}` : "") +
      (error.hint ? ` (hint: ${error.hint})` : "")
  );
  err.code = error.code;
  err.details = error.details;
  err.hint = error.hint;
  err.cause = error;
  return err;
}

/**
 * A counter on its way INTO the ledger.
 *
 * Absent/null means NOT MEASURED and is stored as NULL. Anything else must be a
 * non-negative integer: a NaN or a "5" would land as NULL and quietly become
 * "not measured", turning a broken counter into a missing one. Standing rule 5
 * starts before the write.
 */
function countIn(value, label) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(
      `scan_runs ledger: ${label} must be a non-negative integer or null (null means NOT MEASURED), got ${JSON.stringify(value)}`
    );
  }
  return value;
}

/** A counter on its way OUT. Never `?? 0`: an absent count is unknown, not zero. */
function countOut(value) {
  return Number.isFinite(value) ? value : null;
}

/**
 * Read a scan_runs row into the shape callers use.
 *
 * PURE — no client, no network — so the honesty properties are testable without
 * a database. `worker/src/lib/runLedger.js` carries a byte-identical copy (it
 * may not import this file); a guard test asserts the two agree.
 */
export function normalizeRun(raw) {
  if (!raw || typeof raw !== "object" || !raw.id) {
    throw new Error(
      "normalizeRun: the ledger returned no row. A run with no id cannot be heartbeated or " +
        "closed, and an execution that cannot be closed is one nothing will ever account for."
    );
  }
  const outcome = raw.outcome ?? null;
  const endedAt = raw.ended_at ?? null;

  // Migration 011's scan_runs_open_chk makes these two agree in the database.
  // Checked again here because a row that reaches JS half-closed — ended with
  // no outcome — is a finished-looking run that says nothing about how it went,
  // and every reader above will round that up to "fine".
  if ((outcome === null) !== (endedAt === null)) {
    throw new Error(
      `normalizeRun: run ${raw.id} is half-closed (outcome=${JSON.stringify(outcome)}, ` +
        `ended_at=${JSON.stringify(endedAt)}). Open and closed are the only two states.`
    );
  }

  return {
    id: raw.id,
    runner: raw.runner ?? null,
    phase: raw.phase ?? null,
    workerId: raw.worker_id ?? null,
    scanJobId: raw.scan_job_id ?? null,
    batchId: raw.batch_id ?? null,
    brand: raw.brand ?? null,
    outcome,
    reason: raw.reason ?? null,
    // null means NOT MEASURED, all the way out to the renderer.
    probesAttempted: countOut(raw.probes_attempted),
    probesSucceeded: countOut(raw.probes_succeeded),
    errorsRecovered: countOut(raw.errors_recovered),
    error: raw.error ?? null,
    detail: raw.detail ?? null,
    startedAt: raw.started_at ?? null,
    heartbeatAt: raw.heartbeat_at ?? null,
    endedAt,
    open: outcome === null,
  };
}

/** An unmeasured counter never prints as a number. */
function fmtCount(n) {
  return n === null ? "not measured" : String(n);
}

/**
 * One sentence a human can read in a log.
 *
 * A run that measured zero probes and a run that never counted must not produce
 * the same line — that sentence is the false success itself.
 */
export function describeRun(run) {
  const who = `${run.runner}/${run.phase}`;
  if (run.open) {
    return `run ${run.id} OPEN — ${who}, started ${run.startedAt}, last heartbeat ${run.heartbeatAt}`;
  }
  const probes =
    run.probesAttempted === null && run.probesSucceeded === null
      ? "probes not measured"
      : `probes ${fmtCount(run.probesSucceeded)}/${fmtCount(run.probesAttempted)}`;
  return (
    `run ${run.id} ${run.outcome}${run.reason ? ` (${run.reason})` : ""} — ${who}, ` +
    `${probes}, errors recovered ${fmtCount(run.errorsRecovered)}`
  );
}

/**
 * Open a run. Returns the row, including the id the caller must close.
 *
 * Standing rule 2: this throws on failure and never returns `{ error }`. There
 * is deliberately no "could not open the run, carry on anyway" path — work that
 * runs without a ledger row is work whose absence from the ledger reads as
 * idleness.
 */
export async function openScanRun(
  { runner, phase, workerId = null, scanJobId = null, batchId = null, brand = null, detail = null },
  deps = {}
) {
  const client = requireClient(resolveClient(deps), "openScanRun");
  if (!runner || !String(runner).trim()) {
    throw new Error("openScanRun: runner is required — a run nobody ran cannot be attributed");
  }
  if (!phase || !String(phase).trim()) {
    throw new Error("openScanRun: phase is required — a run with no phase says nothing about what executed");
  }

  const { data, error } = await client.rpc("open_scan_run", {
    p_runner: runner,
    p_phase: phase,
    p_worker_id: workerId,
    p_scan_job_id: scanJobId,
    p_batch_id: batchId,
    p_brand: brand,
    p_detail: detail,
  });
  if (error) throw throwDbError("openScanRun", error);
  return normalizeRun(data);
}

/**
 * Move an open run's heartbeat.
 *
 * The RPC RAISES if the run is closed or absent rather than reporting zero rows
 * updated, and that exception is passed on here: being heartbeated after
 * something else closed you is how a writer finds out it has been reaped.
 */
export async function heartbeatScanRun({ runId }, deps = {}) {
  const client = requireClient(resolveClient(deps), "heartbeatScanRun");
  if (!runId) throw new Error("heartbeatScanRun: runId is required");

  const { data, error } = await client.rpc("heartbeat_scan_run", { p_run_id: runId });
  if (error) throw throwDbError("heartbeatScanRun", error);
  if (!data || data.open !== true) {
    throw new Error(
      `heartbeatScanRun: run ${runId} did not report itself open after a heartbeat. ` +
        `A heartbeat that cannot confirm the run is alive proves nothing.`
    );
  }
  return { runId, heartbeatAt: data.heartbeat_at ?? null };
}

/**
 * Close a run with its outcome, reason and counters. Returns the closed row.
 *
 * A non-'succeeded' outcome MUST carry a reason — refused here and again by
 * migration 011's scan_runs_reason_chk. An unexplained skip is precisely the
 * structured reason this codebase currently computes and throws away.
 *
 * Counters left undefined stay NULL: not measured. Pass 0 when you measured
 * zero. The two are different rows and must stay different.
 */
export async function closeScanRun(
  {
    runId,
    outcome,
    reason = null,
    probesAttempted = null,
    probesSucceeded = null,
    errorsRecovered = null,
    error = null,
    detail = null,
  },
  deps = {}
) {
  const client = requireClient(resolveClient(deps), "closeScanRun");
  if (!runId) throw new Error("closeScanRun: runId is required");
  if (!RUN_OUTCOME_LIST.includes(outcome)) {
    throw new Error(
      `closeScanRun: "${outcome}" is not a run outcome. The vocabulary is closed ` +
        `(${RUN_OUTCOME_LIST.join(", ")}).`
    );
  }
  if (outcome !== RUN_OUTCOMES.SUCCEEDED && !String(reason ?? "").trim()) {
    throw new Error(
      `closeScanRun: outcome "${outcome}" requires a reason — a skip with no reason is the ` +
        `discarded fact this ledger exists to keep.`
    );
  }

  const { data, error: dbErr } = await client.rpc("close_scan_run", {
    p_run_id: runId,
    p_outcome: outcome,
    p_reason: reason,
    p_probes_attempted: countIn(probesAttempted, "probesAttempted"),
    p_probes_succeeded: countIn(probesSucceeded, "probesSucceeded"),
    p_errors_recovered: countIn(errorsRecovered, "errorsRecovered"),
    p_error: error,
    p_detail: detail,
  });
  if (dbErr) throw throwDbError("closeScanRun", dbErr);
  return normalizeRun(data);
}

/**
 * List open runs whose heartbeat predates `cutoffIso`, oldest first — the
 * reaper's candidate query.
 *
 * MOVED HERE BY R3.3.4 from `listStaleRunsFromDb` in
 * src/lib/workers/scanWorker.js, which issued this PostgREST select itself. It
 * was the only read of `scan_runs` outside this module, so the table's column
 * list and its predicates had two homes; a migration that renamed
 * `heartbeat_at` would have had to find both. Served by migration 011's
 * `scan_runs_open_idx`, which is partial on `ended_at IS NULL` for exactly this
 * query.
 *
 * `limit + 1` rows are fetched so "there were more than one pass can take" is a
 * measured fact rather than an inference from a full page. The caller slices
 * back to `limit` and reports the overflow as `truncated`.
 *
 * `excludeRunId` keeps the sweep's own (open, fresh) row out of its own
 * candidate list.
 *
 * Standing rule 2: a failed read propagates with its envelope intact. There is
 * deliberately no "could not list the open runs, report zero stale" path —
 * that answer is indistinguishable from a healthy ledger.
 */
export async function listStaleScanRuns({ cutoffIso, limit, excludeRunId = null }, deps = {}) {
  const client = requireClient(resolveClient(deps), "listStaleScanRuns");
  if (!cutoffIso || !Number.isFinite(Date.parse(cutoffIso))) {
    throw new Error(
      `listStaleScanRuns: cutoffIso must be a readable instant, got ${JSON.stringify(cutoffIso)} — ` +
        `a listing with no cutoff would return every open run, including the ones running right now.`
    );
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(
      `listStaleScanRuns: limit must be a positive integer, got ${JSON.stringify(limit)}`
    );
  }

  let query = client
    .from("scan_runs")
    .select("id, runner, phase, worker_id, scan_job_id, batch_id, brand, outcome, started_at, heartbeat_at, ended_at")
    .is("ended_at", null)
    .lt("heartbeat_at", cutoffIso)
    .order("heartbeat_at", { ascending: true })
    .limit(limit + 1);
  if (excludeRunId) query = query.neq("id", excludeRunId);

  const { data, error } = await query;
  if (error) throw throwDbError("listStaleScanRuns: could not list open scan_runs", error);
  return data || [];
}
