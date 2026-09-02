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
 * Today this is the workspace and the loop. The claim/probe/report stages are
 * stubs that say so: R1.2.2 adds the probe_tasks queue and lease-based
 * claiming, R1.2.3 the scan_runs ledger, and R1.3 the first real adapter.
 * A stub that pretends to work would be the exact failure this rebuild exists
 * to remove, so each one refuses out loud instead.
 */

import { resolveConfig } from "./config.js";
import { claimBatch, reportBatch } from "./lib/queue.js";
import { probeBatch } from "./lib/probe.js";

const log = (msg) => console.log(`[fleet] ${msg}`);

/** One poll: claim, probe, report. Returns how many tasks it handled. */
export async function runOnce(config, deps = {}) {
  const claim = deps.claimBatch || claimBatch;
  const probe = deps.probeBatch || probeBatch;
  const report = deps.reportBatch || reportBatch;

  const batch = await claim(config);
  if (!batch || batch.length === 0) return 0;

  log(`claimed ${batch.length} task(s)`);
  const outcomes = await probe(batch, config);
  await report(outcomes, config);
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
    claimBatch: async () => [{ id: "selftest-1", engine: "perplexity", query: "selftest" }],
    probeBatch: async (batch) => batch.map((t) => ({ ...t, outcome: "skipped", reason: "selftest" })),
    reportBatch: async (outcomes) => {
      reported = outcomes;
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
