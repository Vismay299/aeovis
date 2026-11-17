import test from "node:test";
import assert from "node:assert/strict";
import { enqueueSystemJob } from "../jobs/enqueue.ts";
import { createMemoryJobStore } from "../jobs/memoryStore.ts";
import { listPeriodics } from "../jobs/periodic.ts";
import { getJobDefinition } from "../jobs/registry.ts";
import { runJob } from "../jobs/runner.ts";
import {
  PROJECT_CONTEXT_RETENTION_KIND,
  registerProjectContextJobs,
  retentionCutoff,
} from "./jobs.ts";

const AT = Date.parse("2026-10-25T09:00:00.000Z");
const CUTOFF = "2026-07-27";

function memoryStore() {
  return createMemoryJobStore({ now: () => AT });
}

function recorder(deleted: number) {
  const calls: { before: string; limit: number }[] = [];
  return {
    calls,
    pruner: async (before: string, limit: number) => {
      calls.push({ before, limit });
      return deleted;
    },
  };
}

async function runRetention(
  store: ReturnType<typeof memoryStore>,
  pruner: (before: string, limit: number) => Promise<number>,
) {
  registerProjectContextJobs({ store, pruner, now: () => new Date(AT), selfContinue: () => undefined });
  const { jobId } = await enqueueSystemJob(
    PROJECT_CONTEXT_RETENTION_KIND,
    {},
    { dedupeKey: `${PROJECT_CONTEXT_RETENTION_KIND}:qa-test` },
    { store, now: () => AT, selfContinue: () => undefined },
  );
  await store.claimDue("qa-owner", 1, 300, jobId);
  const claimed = (await store.getJob(jobId)) as NonNullable<Awaited<ReturnType<typeof store.getJob>>>;
  const outcome = await runJob(claimed, {
    store,
    owner: "qa-owner",
    deadlineMs: AT + 240_000,
    now: () => AT,
    selfContinue: () => undefined,
  });
  const finished = await store.getJob(jobId);
  const stepNames = [...store.steps.values()]
    .filter((step) => step.job_id === jobId)
    .map((step) => step.name)
    .sort((left, right) => Number(left.slice("prune-".length)) - Number(right.slice("prune-".length)));
  return { outcome, finished, stepNames };
}

test("the retention job kind is registered", () => {
  assert.ok(getJobDefinition(PROJECT_CONTEXT_RETENTION_KIND), "project_context.retention must be registered");
});

test("the periodic runs daily and dedupes on the UTC day", async () => {
  const store = memoryStore();
  registerProjectContextJobs({ store, now: () => new Date(AT), selfContinue: () => undefined });
  const periodic = listPeriodics().find((task) => task.name === PROJECT_CONTEXT_RETENTION_KIND);
  assert.ok(periodic, "the daily periodic must be defined");
  assert.equal(periodic?.everySeconds, 86_400);

  await periodic?.run(new Date(AT));
  await periodic?.run(new Date(AT + 6 * 3_600_000));
  const sameDay = [...store.jobs.values()].filter((job) => job.kind === PROJECT_CONTEXT_RETENTION_KIND);
  assert.equal(sameDay.length, 1, "the same UTC day enqueues once");
  assert.equal(sameDay[0].dedupe_key, `${PROJECT_CONTEXT_RETENTION_KIND}:2026-10-25`);

  await periodic?.run(new Date(AT + 86_400_000));
  const nextDay = [...store.jobs.values()].filter((job) => job.kind === PROJECT_CONTEXT_RETENTION_KIND);
  assert.equal(nextDay.length, 2, "the next day enqueues again");
  assert.equal(nextDay[1].dedupe_key, `${PROJECT_CONTEXT_RETENTION_KIND}:2026-10-26`);
});

test("a short pass stops after one prune step and reports what it deleted", async () => {
  const store = memoryStore();
  const { calls, pruner } = recorder(100);
  const { outcome, finished, stepNames } = await runRetention(store, pruner);

  assert.equal(outcome, "completed");
  assert.deepEqual(finished?.result, { pruned: 100 });
  assert.deepEqual(stepNames, ["prune-1"]);
  assert.deepEqual(calls, [{ before: CUTOFF, limit: 5_000 }]);
});

test("full passes keep pruning and stop at ten", async () => {
  const store = memoryStore();
  const { calls, pruner } = recorder(5_000);
  const { outcome, finished, stepNames } = await runRetention(store, pruner);

  assert.equal(outcome, "completed");
  assert.deepEqual(finished?.result, { pruned: 50_000 });
  assert.deepEqual(stepNames, Array.from({ length: 10 }, (_unused, index) => `prune-${index + 1}`));
  assert.equal(calls.length, 10);
});

test("every pass prunes rows older than ninety days before the run's UTC day", () => {
  assert.equal(CUTOFF, "2026-07-27");
  assert.equal(retentionCutoff(new Date(AT)), CUTOFF);
  // A run just after midnight UTC already uses the new day.
  assert.equal(retentionCutoff(new Date("2026-10-25T00:00:01.000Z")), CUTOFF);
  assert.equal(retentionCutoff(new Date("2026-10-26T00:00:01.000Z")), "2026-07-28");
});

test("re-registering the retention job is idempotent, so importing kinds.ts cannot throw", () => {
  assert.doesNotThrow(() => registerProjectContextJobs());
  assert.doesNotThrow(() => registerProjectContextJobs({ store: memoryStore() }));
  assert.equal(listPeriodics().filter((task) => task.name === PROJECT_CONTEXT_RETENTION_KIND).length, 1);
});
