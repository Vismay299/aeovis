/**
 * The scan_runs ledger, from the fleet's side (R1.2.3).
 *
 * One row per UNIT OF WORK in ../index.js — a claimed batch, or a whole IDLE
 * STRETCH — opened before the work, heartbeated while it is in flight, closed
 * with an outcome, a reason and measured counters. Migration
 * `supabase/migrations/011_scan_runs.sql` owns the table and the three
 * functions this file calls.
 *
 * WHY A ROW FOR IDLENESS TOO
 * Standing rule 1. "The fleet is idle" and "the fleet is dead" produce exactly
 * the same evidence if only busy passes are recorded: no rows. Idleness writes a
 * run with reason 'queue_empty' or 'all_leased' and `probes_attempted = 0` — a
 * MEASURED zero, which is a different row from the one a dead container leaves,
 * namely none.
 *
 * WHY THAT IS NO LONGER ONE ROW PER POLL (R1.2.23)
 * It used to be: an idle poll opened a row and closed it in the same pass, every
 * `FLEET_IDLE_POLL_MS`. Measured on production 2026-09-22 that was ~8,250 rows a
 * day from a fleet doing nothing, on a 500 MB project. The invariant is kept and
 * the cost is not: one OPEN row per idle stretch, heartbeated while the stretch
 * lasts, closed when work arrives or the process exits. "Idle and alive" is then
 * an open row whose `heartbeat_at` moved inside the last beat window, and "dead"
 * is the same row going quiet until the sweep closes it as 'reaped'. See
 * REAP_STALE_AFTER_MS below: that heartbeat is what makes the long-lived row
 * safe, and without it the sweep would close a live fleet's row every 6 minutes.
 *
 * WHY THE OPEN/CLOSE PAIRING IS IN SQL
 * This workspace may not import from src/ (src/lib/workerIsolation.test.mjs
 * fails the build on any crossing import), so a JS implementation would exist
 * twice and drift. `open_scan_run`, `heartbeat_scan_run` and `close_scan_run`
 * are one implementation with two callers.
 *
 * WHAT IS COPIED, AND WHY THAT IS CHECKED
 * The vocabulary and the two pure readers below are byte-identical to
 * `src/lib/scanRuns.js`, deliberately and unavoidably. `src/lib/scanRuns.test.mjs`
 * asserts the two copies still agree on every case, so the duplication is
 * checked rather than trusted.
 */

import { resolveClient, dbError } from "./queue.js";

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
 * Who ran. The fleet only ever writes RUNNERS.FLEET; the rest are R3.2's and
 * R3.3's. REAPER is here because src/lib/scanRuns.test.mjs asserts this list is
 * byte-identical to the app's — the fleet never writes it, but it is the runner
 * that CLOSES the fleet's rows when a container dies, so a reader of this file
 * must be able to find the name.
 */
export const RUNNERS = Object.freeze({
  FLEET: "probe-fleet",
  SCAN_CHUNK: "scan-chunk",
  SCHEDULER: "scheduler",
  REAPER: "reaper",
});

/** The two phases the fleet writes. */
export const FLEET_PHASES = Object.freeze({
  BATCH: "probe_batch",
  IDLE: "idle",
});

/**
 * The sweep's staleness threshold, COPIED (R1.2.23).
 *
 * `src/lib/workers/scanWorker.js` owns it: REAP_STALE_AFTER_MS =
 * RUN_HEARTBEAT_TTL_MS (180 000, db.js's HEARTBEAT_STALE_MS) x REAP_TTL_MULTIPLE
 * (2) = 360 000 ms. Its listing (`listStaleScanRuns`) filters on neither
 * `runner` nor `phase`, so from R1.2.23 on — when an idle stretch is ONE row
 * that stays open for as long as the container is idle — the fleet's idle row is
 * exactly as reapable as anyone else's open row.
 *
 * This workspace may not import src/, so the number lives here twice. It is
 * CHECKED rather than trusted: src/lib/workers/scanRunReaper.test.mjs asserts
 * the two constants are equal, because a fleet that believes it is beating fast
 * enough while the sweep closes its live row every six minutes would look, from
 * the ledger, exactly like a fleet that keeps dying.
 */
export const REAP_STALE_AFTER_MS = 360_000;

/**
 * How much room the configured cadence leaves before the sweep above would
 * close a live idle row. PURE, so the boot log can state it and a test can pin
 * it.
 *
 * The idle heartbeat is driven by the POLL LOOP, not by a timer: the loop wakes
 * every `idlePollMs` and beats when at least `heartbeatMs` has passed since the
 * last beat. So the worst gap between two beats is one beat interval plus one
 * poll interval — 40s on the shipped defaults (30s + 10s), against a 360s
 * threshold: nine missed beats of margin.
 *
 * A value that is not a positive finite number is NOT MEASURED, never defaulted
 * silently: `worstCaseGapMs` and `marginX` come back null and `safe` comes back
 * false, so a caller cannot read "unknown cadence" as "fine".
 */
export function idleHeartbeatPlan(config) {
  const positive = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  const beatEveryMs = positive(config?.heartbeatMs);
  const pollMs = positive(config?.idlePollMs);
  const worstCaseGapMs = beatEveryMs !== null && pollMs !== null ? beatEveryMs + pollMs : null;
  const marginX = worstCaseGapMs === null ? null : REAP_STALE_AFTER_MS / worstCaseGapMs;
  return {
    beatEveryMs,
    pollMs,
    staleAfterMs: REAP_STALE_AFTER_MS,
    worstCaseGapMs,
    marginX,
    // Three whole beat-plus-poll windows have to be missed before the sweep can
    // act. Fewer than that and one slow database is enough to lose the row.
    safe: marginX !== null && marginX >= 3,
  };
}

/** One sentence for the boot log. An unmeasurable cadence says so out loud. */
export function describeIdleHeartbeatPlan(plan) {
  if (plan.worstCaseGapMs === null) {
    return (
      `idle heartbeat: NOT MEASURABLE from this config (heartbeatMs=${JSON.stringify(plan.beatEveryMs)}, ` +
      `idlePollMs=${JSON.stringify(plan.pollMs)}) — an idle run that is not beaten inside ` +
      `${plan.staleAfterMs}ms is closed as 'reaped' by the sweep, and this container cannot say whether it will be`
    );
  }
  const margin = `${plan.marginX.toFixed(1)}x`;
  if (!plan.safe) {
    return (
      `WARNING: idle heartbeat every ${plan.beatEveryMs}ms with a ${plan.pollMs}ms poll leaves at worst ` +
      `${plan.worstCaseGapMs}ms between beats, only ${margin} inside the sweep's ${plan.staleAfterMs}ms ` +
      `staleness threshold — this fleet's OPEN idle row will be reaped while it is alive, and it will ` +
      `open a fresh one each time. Lower FLEET_HEARTBEAT_MS or FLEET_IDLE_POLL_MS.`
    );
  }
  return (
    `idle heartbeat every ${plan.beatEveryMs}ms, worst case ${plan.worstCaseGapMs}ms between beats — ` +
    `${margin} inside the sweep's ${plan.staleAfterMs}ms staleness threshold`
  );
}

/**
 * No client is a refusal, never a silently skipped ledger write.
 *
 * A pass that could not be recorded must not proceed as though it had been: the
 * missing row is indistinguishable from a container that was never running,
 * which is the exact reading this ledger exists to make impossible.
 */
function requireClient(client, fn) {
  if (!client) {
    throw new Error(
      `${fn}: no Supabase client — the scan_runs ledger is unreachable. Refusing rather ` +
        `than running unrecorded, because an unrecorded pass and a fleet that never ran ` +
        `look identical afterwards.`
    );
  }
  return client;
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
 * Read a scan_runs row into the shape callers use. PURE — copied from
 * src/lib/scanRuns.js for the reason above.
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
 * One sentence for the log. A run that measured zero probes and a run that
 * never counted must not print the same line.
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

// ---------------------------------------------------------------------------
// Pure summaries — what a pass will write, computed without a database
// ---------------------------------------------------------------------------

/**
 * Which job and batch a claimed set of tasks belongs to.
 *
 * A claim is filtered by ENGINE, not by batch, so one claim can legitimately
 * span batches and jobs. When it does, `batchId`/`scanJobId` are null — picking
 * the first would attribute the whole pass to one arbitrary batch — and `spans`
 * says how many there were, so a null reads as "several", never as "none".
 */
export function batchSubject(tasks) {
  const list = Array.isArray(tasks) ? tasks : [];
  const batches = new Set();
  const jobs = new Set();
  for (const t of list) {
    const b = t?.batch_id ?? t?.batchId ?? null;
    const j = t?.scan_job_id ?? t?.scanJobId ?? null;
    if (b) batches.add(b);
    if (j) jobs.add(j);
  }
  return {
    batchId: batches.size === 1 ? [...batches][0] : null,
    scanJobId: jobs.size === 1 ? [...jobs][0] : null,
    spans: { batches: batches.size, jobs: jobs.size },
  };
}

/** The probe outcomes that mean the surface actually answered the question. */
const ANSWERING_OUTCOMES = new Set(["answered", "no_answer"]);

/**
 * What a finished batch pass should be closed with.
 *
 * PURE, and the honesty of the pass lives here:
 *   * `probesAttempted` counts the tasks we held, not the results we liked.
 *   * `probesSucceeded` counts only results that BOTH answered and landed in
 *     the database. A blocked probe is not a success, and neither is an
 *     answer whose write was refused because the lease had lapsed.
 *   * `errorsRecovered` counts landed results that were typed failures —
 *     blocked, captcha, timeout, parse_error. A pass that "succeeded" after
 *     absorbing nine of those is not the same pass as one that met none, and
 *     with a single success count the two are identical in the ledger.
 *   * any refused write makes the whole pass 'failed' with reason 'lease_lost'.
 *     A batch of five that wrote two is not a batch of five.
 */
export function summarizeBatchRun(batch, outcomes, written) {
  const tasks = Array.isArray(batch) ? batch : [];
  const reported = Array.isArray(outcomes) ? outcomes : [];
  const rejected = written && Array.isArray(written.rejected) ? written.rejected : [];
  const refused = new Set(rejected.map(String));

  const landed = reported.filter((o) => !refused.has(String(o?.id)));
  const answered = landed.filter((o) => ANSWERING_OUTCOMES.has(o?.outcome)).length;
  const errored = landed.length - answered;

  return {
    outcome: rejected.length ? RUN_OUTCOMES.FAILED : RUN_OUTCOMES.SUCCEEDED,
    reason: rejected.length ? "lease_lost" : null,
    probesAttempted: tasks.length,
    probesSucceeded: answered,
    errorsRecovered: errored,
    detail: {
      asked: written && Number.isFinite(written.asked) ? written.asked : null,
      // Never `?? 0`: an absent applied count is unknown, and reading it as 0
      // would report every write as lost.
      applied: written && Number.isFinite(written.applied) ? written.applied : null,
      refused: rejected.length,
      reported: reported.length,
    },
  };
}

// ---------------------------------------------------------------------------
// The three ledger calls
// ---------------------------------------------------------------------------

/**
 * Open a run. Returns the row, including the id the pass must close.
 *
 * Standing rule 2: throws on failure, never returns `{ error }`, and has no
 * "could not open, carry on anyway" path — a batch that runs with no ledger row
 * is a batch whose absence from the ledger reads as idleness.
 */
export async function openRun(fields, config, deps = {}) {
  const client = requireClient(resolveClient(config, deps), "openRun");
  const { runner = RUNNERS.FLEET, phase, workerId = null, scanJobId = null, batchId = null, brand = null, detail = null } =
    fields || {};
  if (!phase || !String(phase).trim()) {
    throw new Error("openRun: phase is required — a run with no phase says nothing about what executed");
  }
  if (!workerId || !String(workerId).trim()) {
    throw new Error("openRun: workerId is required — a run no container owns cannot be attributed or reaped");
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
  if (error) throw dbError("openRun", error);
  return normalizeRun(data);
}

/**
 * Move an open run's heartbeat.
 *
 * The RPC RAISES if the run is already closed or absent rather than reporting
 * zero rows updated, and that exception is passed on: being heartbeated after
 * something else closed you is how a container learns it has been reaped.
 */
export async function heartbeatRun(runId, config, deps = {}) {
  const client = requireClient(resolveClient(config, deps), "heartbeatRun");
  if (!runId) throw new Error("heartbeatRun: runId is required");

  const { data, error } = await client.rpc("heartbeat_scan_run", { p_run_id: runId });
  if (error) throw dbError("heartbeatRun", error);
  if (!data || data.open !== true) {
    throw new Error(
      `heartbeatRun: run ${runId} did not report itself open after a heartbeat. A heartbeat ` +
        `that cannot confirm the run is alive proves nothing.`
    );
  }
  return { runId, heartbeatAt: data.heartbeat_at ?? null };
}

/**
 * Close a run with its outcome, reason and counters. Returns the closed row.
 *
 * A non-'succeeded' outcome MUST carry a reason — refused here and again by
 * migration 011's scan_runs_reason_chk. Counters left undefined stay NULL: not
 * measured. Pass 0 when you measured zero; the two are different rows.
 */
export async function closeRun(runId, fields, config, deps = {}) {
  const client = requireClient(resolveClient(config, deps), "closeRun");
  if (!runId) throw new Error("closeRun: runId is required");
  const {
    outcome,
    reason = null,
    probesAttempted = null,
    probesSucceeded = null,
    errorsRecovered = null,
    error = null,
    detail = null,
  } = fields || {};

  if (!RUN_OUTCOME_LIST.includes(outcome)) {
    throw new Error(
      `closeRun: "${outcome}" is not a run outcome. The vocabulary is closed ` +
        `(${RUN_OUTCOME_LIST.join(", ")}).`
    );
  }
  if (outcome !== RUN_OUTCOMES.SUCCEEDED && !String(reason ?? "").trim()) {
    throw new Error(
      `closeRun: outcome "${outcome}" requires a reason — a skip with no reason is the ` +
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
  if (dbErr) throw dbError("closeRun", dbErr);
  return normalizeRun(data);
}
