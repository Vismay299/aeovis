// §6.3.1 — the claim half of one tick, against the in-memory store.
//
// `claim_due_jobs` takes only `run_at <= now()`, so a continuation fired for a
// job that is a second or two short of due would otherwise claim nothing and
// hand the job back to the cron for a whole minute. These tests pin the wait
// that closes that gap, and its bounds.
import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryJobStore } from "./memoryStore.ts";
import type { MemoryJobStore } from "./memoryStore.ts";
import { defineJob } from "./registry.ts";
import { runTick, TICK_BUDGET_MS } from "./tick.ts";
import type { TickDeps } from "./tick.ts";

const BRAND = "qa-brand.example";
const AT = Date.parse("2026-10-22T09:00:00.000Z");

defineJob("test.tick_gap", async () => ({}));

type Harness = {
  store: MemoryJobStore;
  waits: number[];
  deps: TickDeps;
};

function harness(): Harness {
  let now = AT;
  const waits: number[] = [];
  const store = createMemoryJobStore({ now: () => now });
  return {
    store,
    waits,
    deps: {
      store,
      now: () => now,
      wait: async (ms: number) => {
        waits.push(ms);
        now += ms;
      },
      env: {},
      selfContinue: () => undefined,
      selfContinueTick: () => undefined,
      logger: { error: () => undefined, warn: () => undefined, log: () => undefined },
      owner: "tick:qa",
    },
  };
}

async function queueAt(h: Harness, runAt: Date): Promise<string> {
  const { jobId } = await h.store.enqueue({
    kind: "test.tick_gap",
    brandKey: BRAND,
    payload: {},
    trigger: "manual",
    dedupeKey: null,
    singleActiveKey: null,
    runAt,
    createdBy: null,
    deadlineSeconds: 86_400,
    maxInvocations: null,
  });
  assert.ok(jobId, "the job must be enqueued");
  return jobId;
}

test("tick: a targeted continuation waits out a sub-5 s gap and then claims its job", async () => {
  const h = harness();
  const jobId = await queueAt(h, new Date(AT + 3_000));

  const report = await runTick({ jobId, startedAt: AT }, h.deps);
  assert.deepEqual(h.waits, [3_000]);
  assert.equal(report.claimed, 1);
  assert.equal(report.completed, 1);
  assert.equal(h.store.jobs.get(jobId)?.status, "completed");
});

test("tick: a targeted continuation never waits for a job further out than the window", async () => {
  const h = harness();
  const jobId = await queueAt(h, new Date(AT + 30_000));

  const report = await runTick({ jobId, startedAt: AT }, h.deps);
  assert.deepEqual(h.waits, [], "a long wait belongs to the cron, not to this invocation");
  assert.equal(report.claimed, 0);
  assert.equal(h.store.jobs.get(jobId)?.status, "queued");
});

test("tick: an untargeted tick waits for nothing", async () => {
  const h = harness();
  await queueAt(h, new Date(AT + 2_000));

  const report = await runTick({ startedAt: AT }, h.deps);
  assert.deepEqual(h.waits, []);
  assert.equal(report.claimed, 0);
});

test("tick: the batch continue fires for a yielded job that is due and not for one still ahead", async () => {
  const dueNow = harness();
  let ticks = 0;
  dueNow.deps.selfContinueTick = () => {
    ticks += 1;
  };
  const jobId = await queueAt(dueNow, new Date(AT));
  // A tick with no budget left yields every job it claimed at run_at = now().
  const report = await runTick({ jobId, startedAt: AT - TICK_BUDGET_MS }, dueNow.deps);
  assert.equal(report.yielded, 1);
  assert.equal(ticks, 1);

  const ahead = harness();
  let aheadTicks = 0;
  ahead.deps.selfContinueTick = () => {
    aheadTicks += 1;
  };
  const other = await queueAt(ahead, new Date(AT));
  // The same job, reported three seconds short of due: a batch tick claims
  // nothing for a future run_at, and the runner's own per-job continue has it.
  ahead.deps.store = {
    ...ahead.store,
    getJob: async (id: string) => {
      const row = await ahead.store.getJob(id);
      return row === null ? null : { ...row, run_at: new Date(AT + 3_000).toISOString() };
    },
  };
  const aheadReport = await runTick({ jobId: other, startedAt: AT - TICK_BUDGET_MS }, ahead.deps);
  assert.equal(aheadReport.yielded, 1);
  assert.equal(aheadTicks, 0);
});
