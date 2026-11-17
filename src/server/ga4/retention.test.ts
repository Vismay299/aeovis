import test from "node:test";
import assert from "node:assert/strict";
import { createMemoryJobStore } from "../jobs/memoryStore.ts";
import { listPeriodics } from "../jobs/periodic.ts";
import { getJobDefinition } from "../jobs/registry.ts";
import { runJob } from "../jobs/runner.ts";
import { enqueueSystemJob } from "../jobs/enqueue.ts";
import { registerGa4RetentionJobs } from "./retention.ts";

const AT = Date.parse("2026-10-22T09:00:00.000Z");

test("ga4.retention: job and periodic are registered", () => {
  const store = createMemoryJobStore({ now: () => AT });
  registerGa4RetentionJobs({ store });

  const def = getJobDefinition("ga4.retention");
  assert.ok(def, "ga4.retention job must be registered");

  const periodics = listPeriodics();
  const periodic = periodics.find((t) => t.name === "ga4.retention");
  assert.ok(periodic, "ga4.retention periodic must be defined");
  assert.equal(periodic?.everySeconds, 86_400);
});

test("ga4.retention periodic: enqueues daily job with YYYY-MM-DD dedupe key", async () => {
  const store = createMemoryJobStore({ now: () => AT });
  registerGa4RetentionJobs({ store });

  const periodic = listPeriodics().find((t) => t.name === "ga4.retention");
  assert.ok(periodic);

  await periodic.run(new Date(AT));
  await periodic.run(new Date(AT + 3600_000)); // Same day

  const jobs = [...store.jobs.values()].filter((j) => j.kind === "ga4.retention");
  assert.equal(jobs.length, 1, "only 1 job enqueued for same day");
  assert.equal(jobs[0].dedupe_key, "ga4.retention:2026-10-22");
});

test("ga4.retention job: executes purge and prune-attempts steps", async () => {
  const store = createMemoryJobStore({ now: () => AT });

  let rpcCalled = false;
  const mockAdmin = {
    rpc: async (fn: string) => {
      if (fn === "ga4_list_unused_grants") {
        return { data: [], error: null };
      }
      if (fn === "prune_ga4_oauth_attempts") {
        rpcCalled = true;
        return { data: 5, error: null };
      }
      throw new Error(`Unexpected rpc: ${fn}`);
    },
  };

  registerGa4RetentionJobs({ store, admin: mockAdmin });

  const { jobId } = await enqueueSystemJob(
    "ga4.retention",
    {},
    { dedupeKey: "ga4.retention:test-run" },
    { store, now: () => AT, selfContinue: () => undefined },
  );

  await store.claimDue("worker-1", 1, 300, jobId);
  const claimed = (await store.getJob(jobId)) as NonNullable<Awaited<ReturnType<typeof store.getJob>>>;

  await runJob(claimed, {
    store,
    owner: "worker-1",
    deadlineMs: AT + 240_000,
    now: () => AT,
    selfContinue: () => undefined,
  });

  const finished = await store.getJob(jobId);
  assert.equal(finished?.status, "completed");
  assert.deepEqual(finished?.result, {
    purged: 0,
    revoked: 0,
    attempts: 5,
  });
  assert.equal(rpcCalled, true);
});
