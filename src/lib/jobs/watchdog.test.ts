import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryJobStore } from "./memoryStore.ts";
import type { JobStore } from "./store.ts";
import { runWatchdog } from "./watchdog.ts";

function quiet(): { lines: unknown[][]; error: (...args: unknown[]) => void; warn: (...args: unknown[]) => void } {
  const lines: unknown[][] = [];
  return {
    lines,
    error: (...args: unknown[]) => {
      lines.push(args);
    },
    warn: (...args: unknown[]) => {
      lines.push(args);
    },
  };
}

test("watchdog: sweeps reconcile_stale_jobs(100) then expire_spend_holds(500)", async () => {
  const calls: string[] = [];
  const store: JobStore = {
    ...createMemoryJobStore(),
    reconcileStale: async (limit: number) => {
      calls.push(`reconcile_stale_jobs:${limit}`);
      return { deadlineExceeded: 2, invocationLimit: 1 };
    },
    expireSpendHolds: async (limit: number) => {
      calls.push(`expire_spend_holds:${limit}`);
      return 7;
    },
  };

  const logger = quiet();
  const report = await runWatchdog({ store, logger });
  assert.deepEqual(calls, ["reconcile_stale_jobs:100", "expire_spend_holds:500"]);
  assert.deepEqual(report, { deadlineExceeded: 2, invocationLimit: 1, expiredHolds: 7, errors: [] });
  assert.deepEqual(logger.lines, []);
});

test("watchdog: a failed reconcile still expires holds, then rethrows the reconcile error", async () => {
  const failure = new Error("reconcile_stale_jobs failed");
  const calls: string[] = [];
  let holds = 0;
  const store: JobStore = {
    ...createMemoryJobStore(),
    reconcileStale: async () => {
      calls.push("reconcile_stale_jobs");
      throw failure;
    },
    expireSpendHolds: async () => {
      calls.push("expire_spend_holds");
      holds += 1;
      return 6;
    },
  };

  const logger = quiet();
  await assert.rejects(runWatchdog({ store, logger }), (err: unknown) => err === failure);
  assert.deepEqual(calls, ["reconcile_stale_jobs", "expire_spend_holds"]);
  assert.equal(holds, 1, "the hold sweep still runs");
  assert.deepEqual(logger.lines, [["[jobs] watchdog reconcile failed", { reason: "reconcile_stale_jobs failed" }]]);
});

test("watchdog: a failed hold expiry keeps the reconcile counts and rethrows the expiry error", async () => {
  const failure = new Error("expire_spend_holds failed");
  const calls: string[] = [];
  const store: JobStore = {
    ...createMemoryJobStore(),
    reconcileStale: async () => {
      calls.push("reconcile_stale_jobs");
      return { deadlineExceeded: 3, invocationLimit: 0 };
    },
    expireSpendHolds: async () => {
      calls.push("expire_spend_holds");
      throw failure;
    },
  };

  const logger = quiet();
  await assert.rejects(runWatchdog({ store, logger }), (err: unknown) => err === failure);
  assert.deepEqual(calls, ["reconcile_stale_jobs", "expire_spend_holds"]);
  assert.deepEqual(logger.lines, [["[jobs] watchdog hold expiry failed", { reason: "expire_spend_holds failed" }]]);
});
