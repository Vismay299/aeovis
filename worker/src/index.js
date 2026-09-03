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
 * in Postgres. R1.2.3 adds the scan_runs ledger — every pass of the loop below
 * writes exactly one row, whether it claimed work or not — and R1.3 brings the
 * first real adapter, until when `probeBatch` refuses out loud rather than
 * returning plausible zero-valued rows.
 */

import { resolveConfig } from "./config.js";
import { claimBatch, reportBatch, releaseBatch, describeClaim, CLAIM_REASONS } from "./lib/queue.js";
import { probeBatch } from "./lib/probe.js";
import {
  openRun,
  heartbeatRun,
  closeRun,
  batchSubject,
  summarizeBatchRun,
  describeRun,
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
 * One poll: claim, probe, report. Returns how many tasks it handled.
 *
 * EVERY PASS WRITES EXACTLY ONE scan_runs ROW, including the passes that claim
 * nothing. That is the invariant R1.2.3 exists for: an idle container and a
 * dead one leave identical evidence if only busy passes are recorded, and the
 * log line below does not survive the container. An empty pass closes as 'noop'
 * with probes_attempted = 0 -- a measured zero, which is not the same row as no
 * row at all. Standing rule 1.
 */
export async function runOnce(config, deps = {}) {
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
    const idle = await open(
      { phase: FLEET_PHASES.IDLE, workerId: config.workerId, detail: { engines: config.engines } },
      config
    );
    const closed = await close(
      idle.id,
      {
        outcome: RUN_OUTCOMES.NOOP,
        reason: result.reason,
        // Measured zeroes, not absent counts: this pass really did look.
        probesAttempted: 0,
        probesSucceeded: 0,
        errorsRecovered: 0,
        detail: { outstanding: result.outstanding, leased_elsewhere: result.leasedElsewhere },
      },
      config
    );
    log(describeRun(closed));
    return 0;
  }

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
    // The probes ran; the write did not. Recording 0 succeeded is the truth
    // about what is DURABLE, which is the only thing a later reader can check.
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

  while (running) {
    let handled = 0;
    try {
      handled = await runOnce(config, deps);
    } catch (err) {
      // A failed pass must not kill the fleet, but it must be loud. A worker
      // that silently stops claiming looks identical to an empty queue.
      console.error(`[fleet] pass failed: ${err.message}`);
    }
    if (config.once) break;
    if (handled === 0) await sleep(config.idlePollMs);
  }

  log("stopped");
}

/**
 * `--selftest` proves the workspace starts standalone (R1.2.1's accept)
 * without needing a database, a browser, or any credential. It boots the real
 * config path, runs one pass against stubs, and exits 0.
 */
async function selftest() {
  const config = { ...resolveConfig(process.env, { strict: false }), once: true };
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

if (isEntry) {
  const wantsSelftest = process.argv.includes("--selftest");
  const run = wantsSelftest ? selftest() : start(resolveConfig(process.env));
  run.catch((err) => {
    console.error(`[fleet] fatal: ${err.message}`);
    process.exit(1);
  });
}
