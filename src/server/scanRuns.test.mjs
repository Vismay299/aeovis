import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import {
  RUN_OUTCOMES,
  RUN_OUTCOME_LIST,
  RUNNERS,
  closeScanRun,
  describeRun,
  heartbeatScanRun,
  normalizeRun,
  openScanRun,
} from "./scanRuns.js";

/**
 * R1.2.3 — the parts of the scan_runs ledger that can be proven WITHOUT a
 * database.
 *
 * WHAT THIS FILE DOES NOT PROVE, SAID PLAINLY: it does not prove the migration.
 * "The table, its indexes and its three functions exist in Postgres, the
 * open/close constraint holds, and a second close is refused" are facts about a
 * database, and a fake client has no constraints — it would agree with a
 * correct migration and with no migration at all. Those live in
 * `src/server/scanRunsLive.test.mjs`, run against a real Postgres, and announce
 * themselves loudly when they are skipped.
 *
 * What IS proven here: the not-measured-vs-zero distinction that standing rule
 * 5 turns on, the refusals, the preserved error envelope, what the fleet loop
 * writes on each of its five paths, and that the copy of the ledger shape
 * inside worker/ has not drifted from this one.
 *
 * Everything is BEHAVIOURAL: every assertion below calls the function.
 */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const WORKER_LEDGER = pathToFileURL(path.join(REPO, "worker/src/lib/runLedger.js")).href;
const WORKER_INDEX = pathToFileURL(path.join(REPO, "worker/src/index.js")).href;
const WORKER_CONFIG = pathToFileURL(path.join(REPO, "worker/src/config.js")).href;

const ledger = await import(WORKER_LEDGER);
const workerIndex = await import(WORKER_INDEX);
const workerConfig = await import(WORKER_CONFIG);

/** A scan_runs row exactly as migration 011's functions return one. */
function row(over = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    runner: "probe-fleet",
    phase: "probe_batch",
    worker_id: "fleet-1",
    scan_job_id: null,
    batch_id: null,
    brand: null,
    outcome: null,
    reason: null,
    probes_attempted: null,
    probes_succeeded: null,
    errors_recovered: null,
    error: null,
    detail: null,
    started_at: "2026-09-03T06:00:00.000Z",
    heartbeat_at: "2026-09-03T06:00:00.000Z",
    ended_at: null,
    created_at: "2026-09-03T06:00:00.000Z",
    ...over,
  };
}

/** A minimal Supabase-shaped double. Records every call; never touches a network. */
function fakeClient(rpc = {}) {
  const calls = [];
  return {
    calls,
    async rpc(name, args) {
      calls.push({ name, args });
      const handler = rpc[name];
      if (!handler) throw new Error(`fakeClient: no stub for rpc ${name}`);
      return handler(args);
    },
  };
}

// ---------------------------------------------------------------------------
// Refusals — an unrecorded run must never look like a run that went fine
// ---------------------------------------------------------------------------

test("openScanRun — no client is a refusal, not a silently skipped ledger write", async () => {
  await assert.rejects(
    () => openScanRun({ runner: RUNNERS.FLEET, phase: "probe_batch" }, { client: null }),
    /unrecorded run and a run that\s+never happened look identical/
  );
});

test("openScanRun — a run with no runner or no phase is refused before it is written", async () => {
  const client = fakeClient({ open_scan_run: () => ({ data: row(), error: null }) });
  await assert.rejects(() => openScanRun({ phase: "probing" }, { client }), /runner is required/);
  await assert.rejects(() => openScanRun({ runner: "scan-chunk" }, { client }), /phase is required/);
  assert.equal(client.calls.length, 0, "neither may reach the database");
});

test("openScanRun — a database error keeps its envelope; it never returns { error } (rule 2)", async () => {
  const client = fakeClient({
    open_scan_run: () => ({
      data: null,
      error: { message: "boom", code: "42883", details: "function open_scan_run does not exist", hint: "apply 011" },
    }),
  });
  await assert.rejects(
    () => openScanRun({ runner: RUNNERS.FLEET, phase: "idle" }, { client }),
    (err) => {
      assert.equal(err.code, "42883");
      assert.match(err.message, /function open_scan_run does not exist/);
      assert.match(err.message, /hint: apply 011/);
      assert.ok(err.cause, "the original error survives as `cause`");
      return true;
    }
  );
});

test("closeScanRun — an outcome outside the closed vocabulary never reaches the database", async () => {
  const client = fakeClient({ close_scan_run: () => ({ data: row(), error: null }) });
  await assert.rejects(
    () => closeScanRun({ runId: "r1", outcome: "done" }, { client }),
    /"done" is not a run outcome/
  );
  assert.equal(client.calls.length, 0);
});

test("closeScanRun — a non-success with no reason is refused: the discarded reason is the point", async () => {
  const client = fakeClient({ close_scan_run: () => ({ data: row(), error: null }) });
  for (const outcome of [RUN_OUTCOMES.FAILED, RUN_OUTCOMES.SKIPPED, RUN_OUTCOMES.NOOP, RUN_OUTCOMES.REAPED]) {
    await assert.rejects(
      () => closeScanRun({ runId: "r1", outcome }, { client }),
      /requires a reason/,
      `${outcome} must not be storable without a reason`
    );
  }
  assert.equal(client.calls.length, 0);
  // 'succeeded' is the one outcome that explains itself.
  await closeScanRun({ runId: "r1", outcome: RUN_OUTCOMES.SUCCEEDED }, { client });
  assert.equal(client.calls.length, 1);
});

test("heartbeatScanRun — a heartbeat that cannot confirm the run is open is refused", async () => {
  const client = fakeClient({ heartbeat_scan_run: () => ({ data: { run_id: "r1" }, error: null }) });
  await assert.rejects(
    () => heartbeatScanRun({ runId: "r1" }, { client }),
    /did not report itself open/
  );
});

// ---------------------------------------------------------------------------
// Not measured is not zero (standing rule 5), in both directions
// ---------------------------------------------------------------------------

test("closeScanRun — an omitted counter is written as NULL, and a measured zero as 0", async () => {
  const client = fakeClient({ close_scan_run: (args) => ({ data: row({ outcome: "succeeded", ended_at: "x" }), error: null, args }) });

  await closeScanRun({ runId: "r1", outcome: RUN_OUTCOMES.SUCCEEDED }, { client });
  assert.equal(client.calls[0].args.p_probes_attempted, null, "omitted means NOT MEASURED");
  assert.equal(client.calls[0].args.p_probes_succeeded, null);
  assert.equal(client.calls[0].args.p_errors_recovered, null);

  await closeScanRun(
    { runId: "r1", outcome: RUN_OUTCOMES.NOOP, reason: "queue_empty", probesAttempted: 0, probesSucceeded: 0, errorsRecovered: 0 },
    { client }
  );
  assert.equal(client.calls[1].args.p_probes_attempted, 0, "a measured zero is a 0, and must stay one");
  assert.equal(client.calls[1].args.p_probes_succeeded, 0);
  assert.equal(client.calls[1].args.p_errors_recovered, 0);
});

test("closeScanRun — a broken counter is refused, never degraded into 'not measured'", async () => {
  const client = fakeClient({ close_scan_run: () => ({ data: row({ outcome: "succeeded", ended_at: "x" }), error: null }) });
  for (const bad of [Number.NaN, "3", 1.5, -1]) {
    await assert.rejects(
      () => closeScanRun({ runId: "r1", outcome: RUN_OUTCOMES.SUCCEEDED, probesAttempted: bad }, { client }),
      /probesAttempted must be a non-negative integer or null/,
      `${JSON.stringify(bad)} must not be silently stored as NULL`
    );
  }
  assert.equal(client.calls.length, 0);
});

test("normalizeRun — absent counters come back null, never 0", () => {
  const run = normalizeRun(row({ outcome: "succeeded", ended_at: "2026-09-03T06:05:00.000Z", reason: null }));
  assert.equal(run.probesAttempted, null);
  assert.equal(run.probesSucceeded, null);
  assert.equal(run.errorsRecovered, null);
  assert.equal(run.open, false);

  const measured = normalizeRun(
    row({ outcome: "noop", reason: "queue_empty", ended_at: "z", probes_attempted: 0, probes_succeeded: 0, errors_recovered: 0 })
  );
  assert.equal(measured.probesAttempted, 0, "a measured zero survives the read as 0");
});

test("describeRun — a measured zero and an unmeasured count print different sentences", () => {
  const notMeasured = describeRun(normalizeRun(row({ outcome: "succeeded", ended_at: "z" })));
  const measuredZero = describeRun(
    normalizeRun(row({ outcome: "noop", reason: "queue_empty", ended_at: "z", probes_attempted: 0, probes_succeeded: 0, errors_recovered: 0 }))
  );
  assert.notEqual(notMeasured, measuredZero);
  assert.match(notMeasured, /probes not measured/);
  assert.match(notMeasured, /errors recovered not measured/);
  assert.match(measuredZero, /probes 0\/0/);
  assert.doesNotMatch(notMeasured, /probes 0/, "an unmeasured run must never print a zero");
});

test("normalizeRun — a half-closed row is refused, not read as a finished one", () => {
  assert.throws(
    () => normalizeRun(row({ ended_at: "2026-09-03T06:05:00.000Z" })),
    /half-closed/,
    "ended with no outcome looks finished and says nothing about how"
  );
  assert.throws(() => normalizeRun(row({ outcome: "succeeded" })), /half-closed/);
  assert.throws(() => normalizeRun(null), /the ledger returned no row/);
  assert.throws(() => normalizeRun({ runner: "x" }), /the ledger returned no row/);
});

// ---------------------------------------------------------------------------
// The pure summaries the fleet closes a pass with
// ---------------------------------------------------------------------------

test("summarizeBatchRun — a blocked probe is an error recovered, never a success", () => {
  const batch = [{ id: "t1" }, { id: "t2" }, { id: "t3" }];
  const outcomes = [
    { id: "t1", outcome: "answered" },
    { id: "t2", outcome: "blocked" },
    { id: "t3", outcome: "captcha" },
  ];
  const s = ledger.summarizeBatchRun(batch, outcomes, { asked: 3, applied: 3, rejected: [] });
  assert.equal(s.outcome, "succeeded");
  assert.equal(s.probesAttempted, 3);
  assert.equal(s.probesSucceeded, 1, "two of the three never saw an answer");
  assert.equal(s.errorsRecovered, 2);
});

test("summarizeBatchRun — an all-blocked pass records 0 succeeded out of N, not a clean pass", () => {
  const batch = [{ id: "t1" }, { id: "t2" }];
  const outcomes = [
    { id: "t1", outcome: "blocked" },
    { id: "t2", outcome: "timeout" },
  ];
  const s = ledger.summarizeBatchRun(batch, outcomes, { asked: 2, applied: 2, rejected: [] });
  assert.equal(s.probesSucceeded, 0);
  assert.equal(s.probesAttempted, 2);
  assert.equal(s.errorsRecovered, 2);
});

test("summarizeBatchRun — a refused write fails the pass and is not counted as a success", () => {
  const batch = [{ id: "t1" }, { id: "t2" }];
  const outcomes = [
    { id: "t1", outcome: "answered" },
    { id: "t2", outcome: "answered" },
  ];
  const s = ledger.summarizeBatchRun(batch, outcomes, { asked: 2, applied: 1, rejected: ["t2"] });
  assert.equal(s.outcome, "failed");
  assert.equal(s.reason, "lease_lost");
  assert.equal(s.probesAttempted, 2);
  assert.equal(s.probesSucceeded, 1, "an answer whose write was refused did not succeed");
  assert.equal(s.detail.refused, 1);
});

test("summarizeBatchRun — an absent applied count is null in the detail, never 0", () => {
  const s = ledger.summarizeBatchRun([{ id: "t1" }], [{ id: "t1", outcome: "answered" }], {});
  assert.equal(s.detail.applied, null);
  assert.equal(s.detail.asked, null);
});

test("batchSubject — a claim spanning two batches attributes itself to neither, and says so", () => {
  const one = ledger.batchSubject([
    { id: "a", batch_id: "b1", scan_job_id: "j1" },
    { id: "b", batch_id: "b1", scan_job_id: "j1" },
  ]);
  assert.equal(one.batchId, "b1");
  assert.equal(one.scanJobId, "j1");
  assert.deepEqual(one.spans, { batches: 1, jobs: 1 });

  const many = ledger.batchSubject([
    { id: "a", batch_id: "b1", scan_job_id: "j1" },
    { id: "b", batch_id: "b2", scan_job_id: "j2" },
  ]);
  assert.equal(many.batchId, null, "picking the first would attribute the pass to one arbitrary batch");
  assert.deepEqual(many.spans, { batches: 2, jobs: 2 });
});

// ---------------------------------------------------------------------------
// One-shot runOnce — the caller owns and closes the pass's row
// ---------------------------------------------------------------------------

/** The ledger stubs, recording what the loop asked for. */
function recorder() {
  const calls = [];
  let n = 0;
  return {
    calls,
    openRun: async (fields) => {
      const id = `run-${++n}`;
      calls.push({ kind: "open", id, ...fields });
      return { id, runner: "probe-fleet", phase: fields.phase, open: true, startedAt: "t0", heartbeatAt: "t0" };
    },
    heartbeatRun: async (runId) => {
      calls.push({ kind: "beat", id: runId });
      return { runId, heartbeatAt: "t1" };
    },
    closeRun: async (runId, fields) => {
      calls.push({ kind: "close", id: runId, ...fields });
      return {
        id: runId,
        runner: "probe-fleet",
        phase: "probe_batch",
        outcome: fields.outcome,
        reason: fields.reason ?? null,
        probesAttempted: fields.probesAttempted ?? null,
        probesSucceeded: fields.probesSucceeded ?? null,
        errorsRecovered: fields.errorsRecovered ?? null,
        open: false,
      };
    },
  };
}

function claimReport({ tasks = [], outstanding = 0, leased = 0 } = {}) {
  return {
    owner: "fleet-1",
    tasks,
    claimedCount: tasks.length,
    outstanding,
    leasedElsewhere: leased,
    reason: tasks.length ? "claimed" : outstanding === 0 ? "queue_empty" : "all_leased",
    leaseExpiresAt: null,
    observedAt: null,
  };
}

const CONFIG = { workerId: "fleet-1", engines: ["perplexity"], batchSize: 5, leaseMs: 180000, heartbeatMs: 20000 };

/** Run something with console.log captured. */
async function quietly(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (m) => lines.push(m);
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = orig;
  }
}

test("runOnce — an EMPTY pass still writes a run: 'noop', reason queue_empty, measured zeroes", async () => {
  const rec = recorder();
  await quietly(() =>
    workerIndex.runOnce(CONFIG, { claimBatch: async () => claimReport({ outstanding: 0 }), ...rec })
  );
  const opened = rec.calls.filter((c) => c.kind === "open");
  const closed = rec.calls.filter((c) => c.kind === "close");
  assert.equal(opened.length, 1, "a one-shot empty pass still owns one row");
  assert.equal(closed.length, 1);
  assert.equal(opened[0].phase, "idle");
  assert.equal(opened[0].workerId, "fleet-1");
  assert.equal(closed[0].outcome, "noop");
  assert.equal(closed[0].reason, "queue_empty");
  // Zero because we LOOKED and there was nothing, which is not the same fact as
  // a container that never polled — that one writes no row at all.
  assert.equal(closed[0].probesAttempted, 0);
  assert.equal(closed[0].probesSucceeded, 0);
  assert.equal(closed[0].errorsRecovered, 0);
});

test("runOnce — a STARVED pass is a different ledger row from an empty one", async () => {
  const rec = recorder();
  await quietly(() =>
    workerIndex.runOnce(CONFIG, { claimBatch: async () => claimReport({ outstanding: 12, leased: 12 }), ...rec })
  );
  const closed = rec.calls.find((c) => c.kind === "close");
  assert.equal(closed.reason, "all_leased", "contention must not be recorded as idleness");
  assert.equal(closed.detail.outstanding, 12);
  assert.equal(closed.detail.leased_elsewhere, 12);
});

test("runOnce — a claimed batch opens against its batch and job, and closes with what landed", async () => {
  const rec = recorder();
  const tasks = [
    { id: "t1", batch_id: "b1", scan_job_id: "j1" },
    { id: "t2", batch_id: "b1", scan_job_id: "j1" },
  ];
  await quietly(() =>
    workerIndex.runOnce(CONFIG, {
      claimBatch: async () => claimReport({ tasks, outstanding: 2 }),
      probeBatch: async (batch) => [
        { id: batch[0].id, outcome: "answered" },
        { id: batch[1].id, outcome: "blocked" },
      ],
      reportBatch: async () => ({ asked: 2, applied: 2, rejected: [] }),
      ...rec,
    })
  );
  const opened = rec.calls.find((c) => c.kind === "open");
  const closed = rec.calls.find((c) => c.kind === "close");
  assert.equal(opened.phase, "probe_batch");
  assert.equal(opened.batchId, "b1");
  assert.equal(opened.scanJobId, "j1");
  assert.equal(closed.outcome, "succeeded");
  assert.equal(closed.probesAttempted, 2);
  assert.equal(closed.probesSucceeded, 1, "the blocked probe is not a success");
  assert.equal(closed.errorsRecovered, 1);
});

test("runOnce — a failed probe closes the run as failed AND hands the lease back", async () => {
  const rec = recorder();
  const released = [];
  const { lines } = await quietly(async () => {
    await assert.rejects(
      () =>
        workerIndex.runOnce(CONFIG, {
          claimBatch: async () => claimReport({ tasks: [{ id: "t1" }, { id: "t2" }], outstanding: 2 }),
          probeBatch: async () => {
            throw new Error("no adapter is built yet (R1.3)");
          },
          releaseBatch: async (ids) => {
            released.push(...ids);
            return ids.length;
          },
          ...rec,
        }),
      /no adapter is built yet/
    );
  });
  assert.deepEqual(released, ["t1", "t2"]);
  const closed = rec.calls.find((c) => c.kind === "close");
  assert.equal(closed.outcome, "failed");
  assert.equal(closed.reason, "probe_failed");
  assert.equal(closed.probesAttempted, 2);
  assert.equal(closed.probesSucceeded, 0);
  assert.match(closed.error, /no adapter is built yet/);
  assert.ok(lines.length, "the pass must still say what happened");
});

test("runOnce — a failed REPORT closes the run as failed and rethrows the original error", async () => {
  const rec = recorder();
  await quietly(async () => {
    await assert.rejects(
      () =>
        workerIndex.runOnce(CONFIG, {
          claimBatch: async () => claimReport({ tasks: [{ id: "t1" }], outstanding: 1 }),
          probeBatch: async () => [{ id: "t1", outcome: "answered" }],
          reportBatch: async () => {
            throw new Error("complete_probe_tasks: connection reset");
          },
          ...rec,
        }),
      /connection reset/,
      "the cause of death must not be replaced by the epitaph"
    );
  });
  const closed = rec.calls.find((c) => c.kind === "close");
  assert.equal(closed.reason, "report_failed");
  assert.equal(closed.probesSucceeded, 0, "probes that were not durably written did not succeed");
});

test("runOnce — a ledger that cannot open refuses the pass: nothing is probed and the batch goes back", async () => {
  const released = [];
  let probed = false;
  await quietly(async () => {
    await assert.rejects(
      () =>
        workerIndex.runOnce(CONFIG, {
          claimBatch: async () => claimReport({ tasks: [{ id: "t1" }], outstanding: 1 }),
          probeBatch: async () => {
            probed = true;
            return [];
          },
          releaseBatch: async (ids) => {
            released.push(...ids);
            return ids.length;
          },
          openRun: async () => {
            throw new Error("open_scan_run: relation scan_runs does not exist");
          },
          closeRun: async () => {
            throw new Error("closeRun must not be reached — there is no run to close");
          },
          heartbeatRun: async () => ({}),
        }),
      /relation scan_runs does not exist/
    );
  });
  assert.equal(probed, false, "work must not run unrecorded");
  assert.deepEqual(released, ["t1"], "a batch we will not probe must not be parked for its TTL");
});

test("runOnce — the heartbeat beats the open run at config.heartbeatMs and is always cleared", async () => {
  const rec = recorder();
  const timers = [];
  let cleared = 0;
  await quietly(() =>
    workerIndex.runOnce(CONFIG, {
      claimBatch: async () => claimReport({ tasks: [{ id: "t1" }], outstanding: 1 }),
      probeBatch: async () => [{ id: "t1", outcome: "answered" }],
      reportBatch: async () => ({ asked: 1, applied: 1, rejected: [] }),
      setIntervalFn: (fn, ms) => {
        timers.push({ fn, ms });
        return { id: timers.length };
      },
      clearIntervalFn: () => {
        cleared += 1;
      },
      ...rec,
    })
  );
  assert.equal(timers.length, 1, "an in-flight batch must beat, or a long probe reads as a dead container");
  assert.equal(timers[0].ms, 20000, "the interval is config.heartbeatMs");
  assert.equal(cleared, 1, "and it must be cleared, or the process never exits on SIGTERM");

  // Invoked, not merely registered: a ticker wired to the wrong id proves nothing.
  await timers[0].fn();
  const beats = rec.calls.filter((c) => c.kind === "beat");
  assert.equal(beats.length, 1);
  assert.equal(beats[0].id, "run-1");
});

test("runOnce — a heartbeat that fails is announced, and does not abort a live probe", async () => {
  const rec = recorder();
  const timers = [];
  const { lines } = await quietly(async () => {
    await workerIndex.runOnce(CONFIG, {
      claimBatch: async () => claimReport({ tasks: [{ id: "t1" }], outstanding: 1 }),
      probeBatch: async () => [{ id: "t1", outcome: "answered" }],
      reportBatch: async () => ({ asked: 1, applied: 1, rejected: [] }),
      setIntervalFn: (fn, ms) => {
        timers.push({ fn, ms });
        return { id: 1 };
      },
      clearIntervalFn: () => {},
      ...rec,
      heartbeatRun: async () => {
        throw new Error("run r1 is already closed (outcome=reaped)");
      },
    });
    await timers[0].fn();
    // Let the rejection handler run.
    await new Promise((r) => setTimeout(r, 0));
  });
  assert.ok(
    lines.some((l) => /WARNING/.test(l) && /heartbeat/.test(l) && /may be reaped/.test(l)),
    `a missed heartbeat must be visible:\n${lines.join("\n")}`
  );
});

test("fleet config — heartbeatMs is clamped below the lease, so a probe cannot outlive its own liveness", () => {
  const fast = workerConfig.resolveConfig(
    {
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      FLEET_LEASE_MS: "30000",
      // R1.1.5: a 30s lease cannot hold one probe at perplexity.ai's default
      // 45s inter-probe delay plus the 60s probe timeout, so the politeness
      // budget's lease check refuses the boot before the heartbeat rule is
      // reached. Fast pacing keeps this a test about the HEARTBEAT.
      FLEET_PROBE_DELAY_MIN_MS: "0",
      FLEET_PROBE_DELAY_MAX_MS: "1000",
      FLEET_PROBE_TIMEOUT_MS: "5000",
    },
    { strict: false }
  );
  assert.ok(fast.heartbeatMs <= fast.leaseMs / 2, `${fast.heartbeatMs} must be at most half of ${fast.leaseMs}`);

  const dflt = workerConfig.resolveConfig(
    { SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" },
    { strict: false }
  );
  assert.equal(dflt.heartbeatMs, 30_000);
});

// ---------------------------------------------------------------------------
// The copy inside worker/ must not drift
// ---------------------------------------------------------------------------

test("GUARD — the fleet's copy of the ledger shape agrees with the app's", () => {
  // worker/ may not import src/, so the vocabulary and the two pure readers
  // exist twice on purpose. Duplication that is checked is a decision;
  // duplication that is trusted is a bug waiting for a deploy.
  assert.deepEqual(ledger.RUN_OUTCOMES, RUN_OUTCOMES);
  assert.deepEqual([...ledger.RUN_OUTCOME_LIST], [...RUN_OUTCOME_LIST]);
  assert.deepEqual(ledger.RUNNERS, RUNNERS);

  const cases = [
    row(),
    row({ outcome: "succeeded", ended_at: "z" }),
    row({ outcome: "noop", reason: "queue_empty", ended_at: "z", probes_attempted: 0, probes_succeeded: 0, errors_recovered: 0 }),
    row({ outcome: "failed", reason: "lease_lost", ended_at: "z", probes_attempted: 5, probes_succeeded: 2, errors_recovered: 3 }),
  ];
  for (const raw of cases) {
    assert.deepEqual(ledger.normalizeRun(raw), normalizeRun(raw));
    assert.equal(ledger.describeRun(ledger.normalizeRun(raw)), describeRun(normalizeRun(raw)));
  }
  // And they refuse the same rows, for the same reason.
  assert.throws(() => ledger.normalizeRun(row({ ended_at: "z" })), /half-closed/);
});

test("GUARD — the outcome vocabulary in both copies and in the table's CHECK is one list", async () => {
  const sql = await readFile(path.join(REPO, "supabase/migrations/011_scan_runs.sql"), "utf8");
  const check = sql.match(/CONSTRAINT scan_runs_outcome_chk[\s\S]*?\)\),/);
  assert.ok(check, "011 must constrain the outcome column");
  for (const outcome of RUN_OUTCOME_LIST) {
    assert.ok(
      check[0].includes(`'${outcome}'`),
      `the table CHECK must accept ${outcome}; a vocabulary the database does not know is not closed`
    );
  }
  const inCheck = [...check[0].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepEqual(inCheck.sort(), [...RUN_OUTCOME_LIST].sort(), "nothing beyond the vocabulary may be storable");
});

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

test("GUARD — 011 is purely additive: it alters and drops nothing that already existed", async () => {
  const sql = await readFile(path.join(REPO, "supabase/migrations/011_scan_runs.sql"), "utf8");
  const statements = sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

  assert.match(statements, /CREATE TABLE IF NOT EXISTS scan_runs/);
  assert.doesNotMatch(statements, /DROP\s/i, "a migration that drops is not additive");

  // The only ALTER permitted is the one that turns RLS on for the table this
  // migration itself creates. Anything else would be touching live customer data.
  const alters = [...statements.matchAll(/ALTER TABLE\s+(\w+)/gi)].map((m) => m[1]);
  assert.deepEqual([...new Set(alters)], ["scan_runs"]);
});

test("GUARD — the counters have no DEFAULT 0: the schema itself must express 'not measured'", async () => {
  const sql = await readFile(path.join(REPO, "supabase/migrations/011_scan_runs.sql"), "utf8");
  for (const col of ["probes_attempted", "probes_succeeded", "errors_recovered"]) {
    const line = sql.split("\n").find((l) => l.trim().startsWith(col));
    assert.ok(line, `${col} must exist`);
    assert.doesNotMatch(
      line,
      /DEFAULT/i,
      `${col} must have no default: a column that cannot say "unknown" forces every reader above it to report a confident zero`
    );
  }
});

test("GUARD — the open/closed pairing is enforced by the database, not by callers being careful", async () => {
  const sql = await readFile(path.join(REPO, "supabase/migrations/011_scan_runs.sql"), "utf8");
  assert.match(
    sql,
    /CHECK \(\(outcome IS NULL\) = \(ended_at IS NULL\)\)/,
    "without this a run can be ended with no outcome, which every reader rounds up to success"
  );
  assert.match(sql, /scan_runs_reason_chk/, "a non-success must be unable to omit its reason");
  // The three functions, by name: a table whose functions are missing is the
  // exact shape 009 shipped in.
  for (const fn of ["open_scan_run", "heartbeat_scan_run", "close_scan_run"]) {
    assert.match(sql, new RegExp(`CREATE OR REPLACE FUNCTION ${fn}`), `${fn} is part of the migration`);
  }
});

test("GUARD — the live ledger test announces itself when it does NOT run", async () => {
  const src = await readFile(path.join(REPO, "src/server/scanRunsLive.test.mjs"), "utf8");
  assert.match(src, /liveDbGate\.js/, "it must use the shared gate, not a second one");
  assert.match(src, /notRunBanner/, "a silent skip would turn a green suite into a claim nobody checked");
  assert.match(src, /skip: GATE\.reason/, "every gated case must carry its reason");
  // R3.2.4: using the shared gate is not enough — it has to be the ARMED one.
  // This file used to enforce only the first half, and the live files were
  // guarded solely because their authors also remembered to install the write
  // guard by hand. src/server/liveWriteGuard.test.mjs enforces this over the whole
  // tree; the assertion is repeated here because THIS is the file that says
  // what the live ledger test must look like.
  assert.match(
    src,
    /\barmedLiveDbGate\s*\(/,
    "it must open the gate through armedLiveDbGate, which installs the default-deny write guard before " +
      "it reports the gate open — an unguarded live test that forgets one stub writes to production"
  );
  assert.doesNotMatch(
    src,
    /\bliveDbGate\s*\(\s*(?:process\.env\s*)?\)/,
    "the bare gate reads the real environment without arming anything"
  );
});
