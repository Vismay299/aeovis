#!/usr/bin/env node
/**
 * Perceev probe fleet — entry point.
 *
 * R1.2.1. A long-lived Node process that drives real consumer surfaces
 * (perplexity.ai, chatgpt.com) with Playwright and reports typed outcomes. It
 * runs on a container host, NOT on Vercel: the probes need a persistent browser
 * and minutes of wall clock, neither of which a request-scoped function has.
 *
 * The hard rule of this workspace is that nothing here imports from the web
 * app. `src/app` in particular pulls in Next's runtime, which cannot load on a
 * plain container. Shared logic is COPIED, and a guard test fails the build if
 * an import ever crosses the line — the copy is the deliberate cost of the
 * fleet being deployable on its own.
 *
 * The claim is real as of R1.2.2: probe_tasks and a lease-based claim settled
 * in Postgres. R1.2.3 added the scan_runs ledger, and R1.2.23 changed the
 * GRANULARITY of what it records without changing what it guarantees: a pass
 * that claimed work still writes exactly one row, but a stretch of IDLENESS is
 * one open row heartbeated for as long as it lasts, so two idle polls in three
 * write nothing at all. An idle fleet is still distinguishable from a dead one
 * — that is what the heartbeat is for — it just no longer costs ~8,250 rows a
 * day to say so. See `runOnce` below. R1.3 brings the first real adapter, until
 * when `probeBatch` refuses out loud rather than returning plausible
 * zero-valued rows.
 */

import { resolveConfig, describeConfig, FleetConfigError } from "./config.js";
import { claimBatch, reportBatch, releaseBatch, describeClaim, CLAIM_REASONS } from "./lib/queue.js";
import { probeBatch } from "./lib/probe.js";
import {
  openRun,
  heartbeatRun,
  closeRun,
  batchSubject,
  summarizeBatchRun,
  describeRun,
  describeIdleHeartbeatPlan,
  idleHeartbeatPlan,
  normalizeRun,
  FLEET_PHASES,
  RUN_OUTCOMES,
} from "./lib/runLedger.js";

const log = (msg) => console.log(`[fleet] ${msg}`);

/**
 * How often an in-flight batch says it is still alive, when the config does not
 * say. Only reached by a caller that built a config by hand; `resolveConfig`
 * always sets it.
 */
const FALLBACK_HEARTBEAT_MS = 30_000;

/**
 * Beat the run's heartbeat while the probe is in flight.
 *
 * A probe pass is minutes of wall clock. Without this a run's heartbeat would
 * never move off its start time, every long batch would look stale, and
 * R3.3.2's sweep would reap containers that are working perfectly.
 *
 * A FAILED BEAT IS LOGGED, NOT THROWN, AND THAT IS NOT FAIL-SOFT: the
 * consequence of a missed heartbeat is not silence, it is the run going stale
 * and being reaped -- a visible state another process acts on. Tearing down a
 * live probe because one UPDATE did not land would be the worse trade.
 *
 * deps.setIntervalFn / deps.clearIntervalFn are test-only injection.
 */
function startHeartbeat(runId, config, deps, beat) {
  const every = deps.setIntervalFn || setInterval;
  const cancel = deps.clearIntervalFn || clearInterval;
  const ms = Number.isFinite(config.heartbeatMs) ? config.heartbeatMs : FALLBACK_HEARTBEAT_MS;
  const handle = every(() => {
    Promise.resolve(beat(runId, config)).catch((err) =>
      log(
        `WARNING: heartbeat for run ${runId} failed: ${err.message} -- this run will read as ` +
          `stale and may be reaped while it is still working`
      )
    );
  }, ms);
  // Never hold the process open for a heartbeat: SIGTERM must still exit.
  if (handle && typeof handle.unref === "function") handle.unref();
  return () => cancel(handle);
}

/**
 * Close a run on a path that is already failing.
 *
 * The ORIGINAL error is what the caller rethrows; a failure to write the
 * epitaph must not replace the cause of death. It is still announced, because a
 * run left open here will be reaped rather than accounted for.
 */
async function closeOrWarn(close, runId, fields, config) {
  try {
    const closed = await close(runId, fields, config);
    log(describeRun(closed));
  } catch (err) {
    log(
      `WARNING: could not close run ${runId} (${fields.outcome}/${fields.reason}): ` +
        `${err.message} -- it stays open and will be reaped instead of accounted for`
    );
  }
}

/**
 * Why an idle row stopped being the current one. Lands in the closed row's
 * detail, because "the fleet got work" and "the pod was told to stop" are
 * different ends to a stretch of idleness and a reader cannot recover which
 * from the timestamps.
 */
export const IDLE_END_REASONS = Object.freeze({
  /** A claim succeeded: the stretch ended because there is work now. */
  WORK_CLAIMED: "work_claimed",
  /** The run loop exited (SIGTERM, or `once`). Best effort -- see start(). */
  PROCESS_EXIT: "process_exit",
  /** A one-shot caller owned the stretch, so the pass closes what it opened. */
  PASS_ENDED: "pass_ended",
});

/** What one idle poll did to the ledger. Returned so a caller can assert it. */
export const IDLE_VERDICTS = Object.freeze({
  /** The first poll of a stretch: a new open row. */
  OPENED: "opened",
  /** The row was heartbeated -- the fleet said "still here, still idle". */
  BEAT: "beat",
  /** Inside the beat window, so the ledger was not written at all. */
  HELD: "held",
  /** The row was gone from under us (reaped/closed); a fresh one is open. */
  REOPENED: "reopened",
});

/**
 * The state of ONE idle stretch: the open row, and what has happened to it.
 *
 * In-process state, deliberately. `worker_id` has been stable per pod since
 * f288bca (`worker-<hostname>-<pid>`), and the only thing that may heartbeat a
 * row is the process that opened it -- so the id of the open row belongs in the
 * same process, and a restart legitimately starts a new stretch rather than
 * adopting an orphan. There is NO unique index stopping two open idle rows for
 * one worker; the guard is this object plus the reaper, and a partial unique
 * index is filed as a follow-up rather than smuggled in here.
 */
export function createIdleStretch() {
  return {
    /** The open scan_runs row, or null when the fleet is not in an idle stretch. */
    runId: null,
    /** ms clock readings, null when there is no open row -- NOT zero. */
    openedAt: null,
    lastBeatAt: null,
    /** Polls this row has seen, beats written to it, rows lost under us. */
    polls: 0,
    beats: 0,
    reopens: 0,
    /** The claim vocabulary observed during the stretch: queue_empty/all_leased. */
    reasons: {},
    lastReason: null,
    /** Measured on the last poll, or null for NOT MEASURED. Never `?? 0`. */
    lastOutstanding: null,
    lastLeasedElsewhere: null,
  };
}

/** Back to "no open row" without swapping the object a caller is holding. */
function resetIdleStretch(stretch) {
  const fresh = createIdleStretch();
  for (const key of Object.keys(fresh)) stretch[key] = fresh[key];
  return stretch;
}

/** Open the stretch's row and record the id only this process can beat. */
async function openIdleRow(stretch, verdict, config, deps, nowMs) {
  const open = deps.openRun || openRun;
  const row = await open(
    {
      phase: FLEET_PHASES.IDLE,
      workerId: config.workerId,
      detail: {
        engines: config.engines,
        opened_because: verdict,
        reason: stretch.lastReason,
        // Non-zero here means the sweep has been closing live idle rows.
        reopens: stretch.reopens,
      },
    },
    config
  );
  stretch.runId = row.id;
  stretch.openedAt = nowMs;
  // open_scan_run sets heartbeat_at to now, so the first beat is due one
  // cadence from HERE, not immediately.
  stretch.lastBeatAt = nowMs;
  stretch.polls = 1;
  stretch.beats = 0;
  log(describeRun(row));
  return verdict;
}

/**
 * Keep the idle stretch visible: open the row, or beat it, or leave it alone.
 *
 * R1.2.23. The heartbeat is driven from the poll loop rather than a timer
 * because the row only exists WHILE the loop is polling -- the moment a batch is
 * claimed the stretch is closed, so there is no window where an unbeaten row can
 * outlive its owner.
 */
async function holdIdleRow(stretch, result, config, deps) {
  const beat = deps.heartbeatRun || heartbeatRun;
  const nowMs = (deps.now || Date.now)();

  stretch.polls += 1;
  stretch.lastReason = result.reason;
  stretch.reasons[result.reason] = (stretch.reasons[result.reason] || 0) + 1;
  // Measured or NOT MEASURED. A claim that did not report a count must not be
  // recorded as having counted zero (standing rule 5, on the way in).
  stretch.lastOutstanding = Number.isFinite(result.outstanding) ? result.outstanding : null;
  stretch.lastLeasedElsewhere = Number.isFinite(result.leasedElsewhere) ? result.leasedElsewhere : null;

  if (!stretch.runId) return openIdleRow(stretch, IDLE_VERDICTS.OPENED, config, deps, nowMs);

  const beatEveryMs = Number.isFinite(config.heartbeatMs) ? config.heartbeatMs : FALLBACK_HEARTBEAT_MS;
  if (stretch.lastBeatAt !== null && nowMs - stretch.lastBeatAt < beatEveryMs) {
    // The poll that writes NOTHING -- the whole saving of R1.2.23. It is not a
    // silent skip: describeClaim() already logged this poll, the row is already
    // open and already fresh, and the count reaches the ledger as idle_polls on
    // the closed row. Nothing is measured here that is not recorded somewhere.
    return IDLE_VERDICTS.HELD;
  }

  try {
    const beaten = await beat(stretch.runId, config);
    stretch.lastBeatAt = nowMs;
    stretch.beats += 1;
    log(
      `idle run ${stretch.runId} still alive — beat ${stretch.beats} across ${stretch.polls} poll(s), ` +
        `heartbeat ${beaten.heartbeatAt}`
    );
    return IDLE_VERDICTS.BEAT;
  } catch (err) {
    // heartbeat_scan_run RAISES when the row is closed or absent, and
    // heartbeatRun passes that on. That is how this container learns the sweep
    // closed its idle row as 'reaped' -- the row is gone, so there is nothing to
    // close, and the only wrong move is to carry on writing nothing: an idle
    // fleet with no open row is indistinguishable from a dead one.
    log(
      `WARNING: idle run ${stretch.runId} could not be heartbeated (${err.message}) — the row was ` +
        `closed or reaped underneath this container. Opening a fresh idle row so this fleet does ` +
        `not read as a dead one; if this repeats, the beat cadence is losing to the sweep.`
    );
    stretch.reopens += 1;
    return openIdleRow(stretch, IDLE_VERDICTS.REOPENED, config, deps, nowMs);
  }
}

/**
 * Close the stretch's row with what it measured. Returns the id it closed, or
 * null when there was no open row.
 *
 * A failure to close is logged, never thrown: the caller is on its way to real
 * work (or out of the process), and an unclosed row is not lost -- it goes stale
 * and the sweep closes it as 'reaped'.
 */
async function closeIdleRow(stretch, endedBecause, config, deps) {
  const close = deps.closeRun || closeRun;
  const runId = stretch.runId;
  if (!runId) return null;
  const nowMs = (deps.now || Date.now)();

  const fields = {
    outcome: RUN_OUTCOMES.NOOP,
    // The claim's own vocabulary -- 'queue_empty' or 'all_leased' -- so a
    // starved fleet still never reads as a quiet one.
    reason: stretch.lastReason,
    // Measured zeroes, not absent counts: this stretch really did look.
    probesAttempted: 0,
    probesSucceeded: 0,
    errorsRecovered: 0,
    detail: {
      outstanding: stretch.lastOutstanding,
      leased_elsewhere: stretch.lastLeasedElsewhere,
      ended_because: endedBecause,
      idle_polls: stretch.polls,
      idle_beats: stretch.beats,
      idle_reopens: stretch.reopens,
      idle_reasons: stretch.reasons,
      idle_ms: stretch.openedAt === null ? null : nowMs - stretch.openedAt,
    },
  };
  // Forget the row BEFORE the write: if the close fails, the one thing this
  // process must not do is keep beating a row it believes it still owns.
  resetIdleStretch(stretch);
  await closeOrWarn(close, runId, fields, config);
  return runId;
}

/**
 * One poll: claim, probe, report. Returns how many tasks it handled.
 *
 * EVERY UNIT OF WORK WRITES EXACTLY ONE scan_runs ROW, and idleness is a unit of
 * work. That is the invariant R1.2.3 exists for: an idle container and a dead
 * one leave identical evidence if only busy passes are recorded, and the log
 * line below does not survive the container.
 *
 * R1.2.23 changed the GRANULARITY of the idle row, not the invariant. The row is
 * opened on the first idle poll, heartbeated for as long as the idleness lasts,
 * and closed as 'noop' with probes_attempted = 0 when work arrives or the
 * process exits -- a measured zero, which is still not the same row as no row at
 * all. Standing rule 1.
 *
 * `idle` is the stretch this pass belongs to. A caller that does not supply one
 * OWNS ONLY THIS PASS, so this pass closes what it opened: an idle row must
 * never outlive the thing that can heartbeat it. The long-lived loop in start()
 * supplies one, which is what makes the stretch span polls.
 */
export async function runOnce(config, deps = {}, idle = null) {
  const claim = deps.claimBatch || claimBatch;
  const probe = deps.probeBatch || probeBatch;
  const report = deps.reportBatch || reportBatch;
  const release = deps.releaseBatch || releaseBatch;
  const open = deps.openRun || openRun;
  const beat = deps.heartbeatRun || heartbeatRun;
  const close = deps.closeRun || closeRun;

  const result = await claim(config);

  // ALWAYS logged, including -- especially -- when nothing was claimed. An idle
  // fleet and a starved one produce the same zero, and only this line tells
  // them apart. Standing rule 1: measured zero must not look like never ran.
  log(describeClaim(result));

  if (result.reason !== CLAIM_REASONS.CLAIMED) {
    // The idle row. Its reason carries the claim's own vocabulary --
    // 'queue_empty' or 'all_leased' -- so the ledger keeps the distinction the
    // log line makes, and a fleet being starved never reads as a quiet one.
    //
    // A caller that supplied a stretch keeps the row open across polls; one
    // that did not owns only this pass, so the pass closes what it opened. The
    // ledger shape is the same either way -- one open row, then one closed noop
    // row -- which is why `--selftest` still proves R1.2.3 without a loop.
    if (idle) {
      await holdIdleRow(idle, result, config, deps);
      return 0;
    }
    const own = createIdleStretch();
    await holdIdleRow(own, result, config, deps);
    await closeIdleRow(own, IDLE_END_REASONS.PASS_ENDED, config, deps);
    return 0;
  }

  // Work arrived, so the idle stretch ends here rather than at the next poll:
  // a batch row and an idle row must never be open for the same worker at once,
  // or the ledger says this container was in two states.
  if (idle) await closeIdleRow(idle, IDLE_END_REASONS.WORK_CLAIMED, config, deps);

  const batch = result.tasks;
  // A claim is filtered by engine, so it can span batches and jobs; when it
  // does, batchId/scanJobId come back null and spans says how many there were.
  const subject = batchSubject(batch);

  let run = null;
  let outcomes;
  try {
    run = await open(
      {
        phase: FLEET_PHASES.BATCH,
        workerId: config.workerId,
        scanJobId: subject.scanJobId,
        batchId: subject.batchId,
        detail: {
          claimed: result.claimedCount,
          outstanding: result.outstanding,
          leased_elsewhere: result.leasedElsewhere,
          spans: subject.spans,
          engines: config.engines,
        },
      },
      config
    );
    const stopHeartbeat = startHeartbeat(run.id, config, deps, beat);
    try {
      outcomes = await probe(batch, config);
    } finally {
      stopHeartbeat();
    }
  } catch (err) {
    // The batch is leased to us and we cannot finish it. Hand it back now
    // rather than parking it for the full TTL on every failed pass.
    const ids = batch.map((t) => t.id);
    const released = await release(ids, config).catch((e) => {
      log(`could not release ${ids.length} task(s) after a failed probe: ${e.message}`);
      return null;
    });
    if (released !== null) log(`released ${released}/${ids.length} task(s) after a failed probe`);
    // run is null only when the LEDGER is what failed, and then there is no row
    // to close -- the throw below is the whole record, which is why opening a
    // run refuses rather than letting the pass continue unrecorded.
    if (run) {
      await closeOrWarn(
        close,
        run.id,
        {
          outcome: RUN_OUTCOMES.FAILED,
          reason: "probe_failed",
          probesAttempted: batch.length,
          probesSucceeded: 0,
          errorsRecovered: 0,
          error: err.message,
          detail: { released },
        },
        config
      );
    }
    throw err;
  }

  let written;
  try {
    written = await report(outcomes, config);
  } catch (err) {
    // The probes ran; the write did not. Nothing is durable, so the batch is
    // handed back the same way a failed probe hands it back: parked for the
    // full lease TTL it would starve every other worker of these tasks for
    // FLEET_LEASE_MS, and they will be re-probed either way.
    const ids = batch.map((t) => t.id);
    const released = await release(ids, config).catch((e) => {
      log(`could not release ${ids.length} task(s) after a failed report: ${e.message}`);
      return null;
    });
    if (released !== null) log(`released ${released}/${ids.length} task(s) after a failed report`);
    // Recording 0 succeeded is the truth about what is DURABLE, which is the
    // only thing a later reader can check.
    await closeOrWarn(
      close,
      run.id,
      {
        outcome: RUN_OUTCOMES.FAILED,
        reason: "report_failed",
        probesAttempted: batch.length,
        probesSucceeded: 0,
        errorsRecovered: 0,
        error: err.message,
        detail: { released },
      },
      config
    );
    throw err;
  }

  // A short write is not a successful one. rejected means our lease lapsed
  // mid-probe and those results were refused by the database.
  if (written && written.rejected && written.rejected.length) {
    log(
      `WARNING: ${written.applied}/${written.asked} outcome(s) written; ` +
        `${written.rejected.length} refused -- this worker no longer held their lease`
    );
  }

  // Counted from what LANDED, never from what we hoped: see summarizeBatchRun.
  const closed = await close(run.id, summarizeBatchRun(batch, outcomes, written), config);
  log(describeRun(closed));
  return batch.length;
}

/** The long-lived loop. Exits after one pass when `config.once` is set. */
export async function start(config, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let running = true;

  // A container host stops the process with SIGTERM. Finishing the pass in
  // flight rather than dying mid-batch is what keeps a lease from being
  // orphaned for its full duration on every deploy.
  const stop = (signal) => {
    log(`${signal} received — finishing the current pass, then exiting`);
    running = false;
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  log(`starting as ${config.workerId}; engines=${config.engines.join(",") || "(none)"}`);
  log(describeConfig(config));
  // R1.2.23: the idle row is only as safe as the cadence that beats it, so the
  // margin against the sweep is STATED at boot rather than assumed. A config
  // that cannot beat fast enough says so here, in the log the operator reads
  // first, instead of in a ledger full of rows closed as 'reaped'.
  log(describeIdleHeartbeatPlan(idleHeartbeatPlan(config)));
  // Anything the validator narrowed from a DEFAULT is announced here rather than
  // applied invisibly (R1.2.6). A value the operator SET is never narrowed —
  // resolveConfig refuses instead.
  for (const note of config.adjustments || []) log(`NOTE: ${note}`);

  // ONE stretch for the life of the loop. This is what makes idleness cost one
  // row per idle stretch instead of one row per poll (R1.2.23): runOnce opens
  // it on the first idle poll, beats it on later ones, and closes it the moment
  // a claim succeeds.
  const idle = createIdleStretch();

  while (running) {
    let handled = 0;
    try {
      handled = await runOnce(config, deps, idle);
    } catch (err) {
      // A failed pass must not kill the fleet, but it must be loud. A worker
      // that silently stops claiming looks identical to an empty queue.
      console.error(`[fleet] pass failed: ${err.message}`);
    }
    if (config.once) break;
    if (handled === 0) await sleep(config.idlePollMs);
  }

  // BEST EFFORT, and named as such. SIGTERM reaches the handler above and the
  // loop finishes its pass, so this normally closes the row properly. A SIGKILL
  // -- or a grace period shorter than the pass -- skips it, and the row is left
  // open for the sweep to close as 'reaped'.
  //
  // HOW LONG THAT TAKES IS NOT SIX MINUTES. REAP_STALE_AFTER_MS (360000) is the
  // threshold at which a row becomes ELIGIBLE to be reaped; the sweep that acts
  // on it runs from /api/scan/worker, which vercel.json schedules at `0 0 * * *`
  // -- once a day. So the honest bound is "closed here, or reaped at the next
  // sweep", and an abandoned row can read as open for up to ~24h. R3.1.1 (cron
  // every 10 minutes) is the task that would make the bound minutes; it is
  // blocked on an operator decision, and until it lands this comment must not
  // claim a number the schedule does not deliver.
  await closeIdleRow(idle, IDLE_END_REASONS.PROCESS_EXIT, config, deps);

  log("stopped");
}

/**
 * `--selftest` proves the workspace starts standalone (R1.2.1's accept)
 * without needing a database, a browser, or any credential. It boots the real
 * config path, runs one pass against stubs, and exits 0.
 */
async function selftest(resolved) {
  const config = { ...(resolved || resolveConfig(process.env, { strict: false })), once: true };
  log("selftest: config resolved");
  if (config.missing.length) {
    log(`selftest: no ${config.missing.join("/")} in this environment — using stubs`);
  }

  let reported = null;
  // The ledger is stubbed for the same reason the queue is: --selftest must
  // prove the workspace BOOTS without a database. What it still proves about
  // R1.2.3 is that a pass opens a run and closes it -- `ledgerRow` below is
  // asserted, so a runOnce that quietly stopped writing the ledger fails here.
  let ledgerRow = null;
  await start(config, {
    claimBatch: async () => ({
      owner: config.workerId,
      tasks: [{ id: "selftest-1", engine: "perplexity", query: "selftest" }],
      claimedCount: 1,
      outstanding: 1,
      leasedElsewhere: 0,
      reason: "claimed",
      leaseExpiresAt: null,
      observedAt: null,
    }),
    probeBatch: async (batch) => batch.map((t) => ({ ...t, outcome: "skipped", detail: { reason: "selftest" } })),
    reportBatch: async (outcomes) => {
      reported = outcomes;
      return { asked: outcomes.length, applied: outcomes.length, rejected: [] };
    },
    openRun: async (fields) => {
      ledgerRow = { id: "selftest-run", ...fields, open: true };
      return normalizeRun({
        id: "selftest-run",
        runner: "probe-fleet",
        phase: fields.phase,
        worker_id: fields.workerId,
        started_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
      });
    },
    heartbeatRun: async (runId) => ({ runId, heartbeatAt: new Date().toISOString() }),
    closeRun: async (runId, fields) => {
      ledgerRow = { ...ledgerRow, ...fields, open: false };
      return normalizeRun({
        id: runId,
        runner: "probe-fleet",
        phase: FLEET_PHASES.BATCH,
        outcome: fields.outcome,
        reason: fields.reason,
        probes_attempted: fields.probesAttempted,
        probes_succeeded: fields.probesSucceeded,
        errors_recovered: fields.errorsRecovered,
        started_at: new Date().toISOString(),
        heartbeat_at: new Date().toISOString(),
        ended_at: new Date().toISOString(),
      });
    },
    releaseBatch: async () => 0,
    sleep: async () => {},
  });

  if (!reported || reported.length !== 1) {
    throw new Error("selftest did not complete a pass");
  }
  if (!ledgerRow || ledgerRow.open !== false) {
    throw new Error("selftest pass left no closed scan_runs row — every pass must account for itself");
  }
  // A 'skipped' probe is not an answered one: 0 succeeded out of 1 attempted is
  // the honest summary, and printing it here means a regression that started
  // counting skips as successes would be visible in the selftest output.
  log(
    `selftest: ledger row closed as ${ledgerRow.outcome} — ` +
      `${ledgerRow.probesSucceeded}/${ledgerRow.probesAttempted} probes succeeded, ` +
      `${ledgerRow.errorsRecovered} error(s) recovered`
  );
  log("selftest: one pass completed — the workspace starts standalone");
}

const isEntry = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop());

/**
 * Boot, or refuse to (R1.2.6).
 *
 * `resolveConfig` throws SYNCHRONOUSLY, so before this it ran inside the
 * expression that built the promise and escaped the `.catch` below entirely:
 * the container died with an uncaught-exception stack trace. The exit code was
 * already 1, but "exits non-zero with the missing names listed" is only half
 * met by a message an operator has to dig a stack out of, and a validator that
 * reports FIVE problems needs all five to survive the crash legibly.
 *
 * Exported so the boot path itself is testable without spawning a process.
 */
export function bootConfig(env, { strict = true } = {}) {
  try {
    return { config: resolveConfig(env, { strict }), errorText: null, exitCode: 0 };
  } catch (err) {
    if (err instanceof FleetConfigError) {
      // Each problem on its own line, the missing names on their own, and no
      // value of any variable marked secret — see config.js.
      const lines = [
        `[fleet] fatal: the fleet refuses to start — ${err.problems.length} configuration problem(s):`,
        ...err.problems.map((p) => `[fleet]   - ${p.message}`),
      ];
      if (err.missing.length) {
        lines.push(`[fleet] required variable(s) missing or blank: ${err.missing.join(", ")}`);
      }
      return { config: null, errorText: lines.join("\n"), exitCode: 1 };
    }
    return { config: null, errorText: `[fleet] fatal: ${err.message}`, exitCode: 1 };
  }
}

if (isEntry) {
  const wantsSelftest = process.argv.includes("--selftest");
  const booted = bootConfig(process.env, { strict: !wantsSelftest });
  if (!booted.config) {
    console.error(booted.errorText);
    process.exit(booted.exitCode);
  }
  const run = wantsSelftest ? selftest(booted.config) : start(booted.config);
  run.catch((err) => {
    console.error(`[fleet] fatal: ${err.message}`);
    process.exit(1);
  });
}
