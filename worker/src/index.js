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
 * in Postgres. R1.2.3 adds the scan_runs ledger and R1.3 the first real
 * adapter, and until then `probeBatch` refuses out loud rather than returning
 * plausible zero-valued rows.
 */

import { resolveConfig } from "./config.js";
import { claimBatch, reportBatch, releaseBatch, describeClaim, CLAIM_REASONS } from "./lib/queue.js";
import { probeBatch } from "./lib/probe.js";

const log = (msg) => console.log(`[fleet] ${msg}`);

/** One poll: claim, probe, report. Returns how many tasks it handled. */
export async function runOnce(config, deps = {}) {
  const claim = deps.claimBatch || claimBatch;
  const probe = deps.probeBatch || probeBatch;
  const report = deps.reportBatch || reportBatch;
  const release = deps.releaseBatch || releaseBatch;

  const result = await claim(config);

  // ALWAYS logged, including — especially — when nothing was claimed. An idle
  // fleet and a starved one produce the same zero, and only this line tells
  // them apart. Standing rule 1: measured zero must not look like never ran.
  log(describeClaim(result));

  if (result.reason !== CLAIM_REASONS.CLAIMED) return 0;

  const batch = result.tasks;
  let outcomes;
  try {
    outcomes = await probe(batch, config);
  } catch (err) {
    // The batch is leased to us and we cannot finish it. Hand it back now
    // rather than parking it for the full TTL on every failed pass.
    const ids = batch.map((t) => t.id);
    const released = await release(ids, config).catch((e) => {
      log(`could not release ${ids.length} task(s) after a failed probe: ${e.message}`);
      return null;
    });
    if (released !== null) log(`released ${released}/${ids.length} task(s) after a failed probe`);
    throw err;
  }

  const written = await report(outcomes, config);
  // A short write is not a successful one. `rejected` means our lease lapsed
  // mid-probe and those results were refused by the database.
  if (written && written.rejected && written.rejected.length) {
    log(
      `WARNING: ${written.applied}/${written.asked} outcome(s) written; ` +
        `${written.rejected.length} refused — this worker no longer held their lease`
    );
  }
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
    sleep: async () => {},
  });

  if (!reported || reported.length !== 1) {
    throw new Error("selftest did not complete a pass");
  }
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
