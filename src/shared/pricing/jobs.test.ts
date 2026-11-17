import test from "node:test";
import assert from "node:assert/strict";
import { enqueueSystemJob } from "../../server/jobs/enqueue.ts";
import { createMemoryJobStore } from "../../server/jobs/memoryStore.ts";
import { listPeriodics } from "../../server/jobs/periodic.ts";
import { getJobDefinition } from "../../server/jobs/registry.ts";
import { runJob } from "../../server/jobs/runner.ts";
import {
  PRICING_RETENTION_KIND,
  registerPricingJobs,
  resetPricingJobDeps,
  retentionCutoff,
} from "./jobs.ts";

const AT = Date.parse("2026-10-25T09:00:00.000Z");

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

test("pricing.retention job kind and periodic are registered", () => {
  const definition = getJobDefinition(PRICING_RETENTION_KIND);
  assert.ok(definition, "pricing.retention job must be registered");

  const periodic = listPeriodics().find((task) => task.name === PRICING_RETENTION_KIND);
  assert.ok(periodic, "pricing.retention periodic must be registered");
  assert.equal(periodic.everySeconds, 86_400, "cadence must be 24h (86,400s)");
});

test("periodic enqueues pricing.retention with per-day dedupe key", async () => {
  const store = memoryStore();
  registerPricingJobs({
    store,
    selfContinue: () => undefined,
  });

  const periodic = listPeriodics().find((task) => task.name === PRICING_RETENTION_KIND);
  assert.ok(periodic);

  const testNow = new Date("2026-10-25T14:30:00.000Z");
  await periodic.run(testNow);

  const jobs = [...store.jobs.values()].filter(
    (job) => job.kind === PRICING_RETENTION_KIND,
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].kind, PRICING_RETENTION_KIND);
  assert.equal(jobs[0].dedupe_key, `pricing.retention:2026-10-25`);

  resetPricingJobDeps();
});

test("retentionCutoff computes ISO timestamp 395 days before now", () => {
  const now = new Date("2026-10-25T09:00:00.000Z");
  const cutoff = retentionCutoff(now);
  const cutoffDate = new Date(cutoff);
  const diffDays = Math.round(
    (now.getTime() - cutoffDate.getTime()) / (24 * 60 * 60 * 1000),
  );
  assert.equal(diffDays, 395);
});

test("pricing.retention job runs prune step with correct RPC args and completes", async () => {
  const store = memoryStore();
  const { calls, pruner } = recorder(42);

  registerPricingJobs({
    store,
    pruner,
    now: () => new Date(AT),
    selfContinue: () => undefined,
  });

  const { jobId } = await enqueueSystemJob(
    PRICING_RETENTION_KIND,
    {},
    { dedupeKey: "pricing.retention:qa-test" },
    { store, now: () => AT, selfContinue: () => undefined },
  );

  await store.claimDue("qa-worker", 1, 300, jobId);
  const claimed = (await store.getJob(jobId)) as NonNullable<
    Awaited<ReturnType<typeof store.getJob>>
  >;

  const outcome = await runJob(claimed, {
    store,
    owner: "qa-worker",
    deadlineMs: AT + 240_000,
    now: () => AT,
    selfContinue: () => undefined,
  });

  assert.equal(outcome, "completed");

  const finishedJob = await store.getJob(jobId);
  assert.equal(finishedJob?.status, "completed");
  assert.deepEqual(finishedJob?.result, { pruned: 42 });

  // Verify step was executed and recorded
  assert.equal(calls.length, 1);
  assert.equal(calls[0].limit, 5000);
  assert.equal(calls[0].before, retentionCutoff(new Date(AT)));

  const steps = [...store.steps.values()].filter((s) => s.job_id === jobId);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].name, "prune");
  assert.equal(steps[0].status, "completed");

  resetPricingJobDeps();
});
