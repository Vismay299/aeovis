import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryJobStore } from "./memoryStore.ts";
import { registerMaintenanceJobs } from "./maintenance.ts";
import { listPeriodics } from "./periodic.ts";
import { getJobDefinition } from "./registry.ts";
import { runJob } from "./runner.ts";
import { enqueueSystemJob } from "./enqueue.ts";

const AT = Date.parse("2026-10-21T09:00:00.000Z");

test("maintenance: cache.retention kind is registered", () => {
  registerMaintenanceJobs({ store: createMemoryJobStore({ now: () => AT }) });
  const def = getJobDefinition("cache.retention");
  assert.ok(def, "cache.retention must be registered");
});

test("maintenance: cache.retention periodic runs hourly with an hour-scoped dedupe key", async () => {
  const store = createMemoryJobStore({ now: () => AT });
  registerMaintenanceJobs({ store });
  const periodics = listPeriodics();
  const periodic = periodics.find((task) => task.name === "cache.retention");
  assert.ok(periodic, "cache.retention periodic must be defined");
  assert.equal(periodic?.everySeconds, 3_600);

  await periodic?.run(new Date(AT));
  await periodic?.run(new Date(AT + 30 * 60_000));
  const jobs = [...store.jobs.values()].filter((job) => job.kind === "cache.retention");
  assert.equal(jobs.length, 1, "the same hour enqueues once");
  assert.equal(jobs[0].dedupe_key, `cache.retention:${new Date(AT).toISOString().slice(0, 13)}`);

  await periodic?.run(new Date(AT + 60 * 60_000));
  const after = [...store.jobs.values()].filter((job) => job.kind === "cache.retention");
  assert.equal(after.length, 2, "the next hour enqueues again");
});

test("maintenance: cache.retention prunes expired rows then deletes bodies in batches via prune-1…", async () => {
  const store = createMemoryJobStore({ now: () => AT });
  registerMaintenanceJobs({ store });
  for (let n = 0; n < 250; n += 1) {
    store.prunedCachePaths.push(`provider-cache/qa/${n}.json`);
  }
  const { jobId } = await enqueueSystemJob(
    "cache.retention",
    {},
    { dedupeKey: "cache.retention:qa-test" },
    { store, now: () => AT, selfContinue: () => undefined }
  );
  await store.claimDue("qa-owner", 1, 300, jobId);
  const claimed = (await store.getJob(jobId)) as NonNullable<Awaited<ReturnType<typeof store.getJob>>>;
  const outcome = await runJob(
    claimed,
    {
      store,
      owner: "qa-owner",
      deadlineMs: AT + 240_000,
      now: () => AT,
      selfContinue: () => undefined,
    }
  );
  assert.equal(outcome, "completed");
  const finished = await store.getJob(jobId);
  assert.deepEqual(finished?.result, { pruned: 250 });
  assert.deepEqual(
    store.removedCacheBodies.map((batch) => batch.length),
    [100, 100, 50],
    "storage deletes go in batches of 100"
  );
  const stepNames = [...store.steps.values()].filter((step) => step.job_id === jobId).map((step) => step.name);
  assert.deepEqual(stepNames, ["prune-1", "prune-2", "prune-3", "prune-4"]);
});
