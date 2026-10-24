import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryJobStore } from "./memoryStore.ts";
import type { MemoryJobStore } from "./memoryStore.ts";
import { definePeriodic, runDuePeriodics } from "./periodic.ts";
import type { PeriodicDeps } from "./periodic.ts";

const NAME = "test.periodic";
const AT = Date.parse("2026-10-21T09:00:00.000Z");
const INTERVAL_SECONDS = 60;
const INTERVAL_MS = INTERVAL_SECONDS * 1000;

const runs: Date[] = [];
let behaviour: (now: Date) => Promise<void> = async () => {};

definePeriodic({
  name: NAME,
  everySeconds: INTERVAL_SECONDS,
  run: (now) => {
    runs.push(now);
    return behaviour(now);
  },
});

type Harness = {
  store: MemoryJobStore;
  lines: unknown[][];
  deps: PeriodicDeps;
};

function harness(): Harness {
  runs.length = 0;
  behaviour = async () => {};
  const lines: unknown[][] = [];
  const store = createMemoryJobStore({ now: () => AT });
  const logger = {
    error: (...args: unknown[]) => {
      lines.push(args);
    },
    warn: (...args: unknown[]) => {
      lines.push(args);
    },
  };
  return { store, lines, deps: { store, logger } };
}

test("periodic: claims the next slot before running the task", async () => {
  const h = harness();
  const seen: (number | null)[] = [];
  behaviour = async () => {
    seen.push(h.store.periodics.get(NAME)?.next_run_at ?? null);
  };

  const report = await runDuePeriodics(new Date(AT), h.deps);
  assert.deepEqual(report, { due: 1, ran: 1, failed: 0, errors: [] });
  assert.deepEqual(seen, [AT + INTERVAL_MS], "the slot is advanced before the task body runs");
  assert.equal(h.store.periodics.get(NAME)?.next_run_at, AT + INTERVAL_MS);

  const again = await runDuePeriodics(new Date(AT), h.deps);
  assert.equal(again.due, 0, "a task whose slot is in the future is not claimed again");
  assert.equal(runs.length, 1);
});

test("periodic: a throwing task keeps the advanced slot and records last_error", async () => {
  const h = harness();
  behaviour = async () => {
    throw new Error("enqueue failed");
  };

  const report = await runDuePeriodics(new Date(AT), h.deps);
  assert.equal(report.due, 1);
  assert.equal(report.ran, 0);
  assert.equal(report.failed, 1);
  assert.deepEqual(report.errors, [{ name: NAME, reason: "enqueue failed" }]);
  assert.deepEqual(h.lines, [["[jobs] periodic failed", { name: NAME, reason: "enqueue failed" }]]);

  const row = h.store.periodics.get(NAME);
  assert.equal(row?.next_run_at, AT + INTERVAL_MS, "the slot stays advanced");
  assert.equal(row?.last_error, "enqueue failed");
  assert.equal(row?.last_finished_at, null);
});

test("periodic: missed slots collapse into one catch-up run", async () => {
  const h = harness();
  assert.equal((await runDuePeriodics(new Date(AT), h.deps)).ran, 1);

  const late = AT + 5 * INTERVAL_MS;
  const report = await runDuePeriodics(new Date(late), h.deps);
  assert.equal(report.due, 1);
  assert.equal(report.ran, 1);
  assert.deepEqual(runs, [new Date(AT), new Date(late)]);
  assert.equal(h.store.periodics.get(NAME)?.next_run_at, AT + 6 * INTERVAL_MS);
});
