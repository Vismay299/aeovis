// F17-AC-16 retention half: the daily local.retention job prunes fetches, items,
// grids and searches older than 395 days through prune_local_seo. The SQL itself
// is exercised by `node scripts/qa/check-f17-db.mjs --only retention`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { getJobDefinition } from "../jobs/registry.ts";
import { listPeriodics } from "../jobs/periodic.ts";
import { createMemoryJobStore } from "../jobs/memoryStore.ts";
import { runJob } from "../jobs/runner.ts";
import {
  LOCAL_MAX_PRUNE_STEPS,
  LOCAL_PRUNE_BATCH_LIMIT,
  LOCAL_RETENTION_DAYS,
  registerLocalRetentionJobs,
} from "./jobs.ts";

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const DAY = 86_400_000;
let jobSeq = 0;

async function runRetention(store: ReturnType<typeof createMemoryJobStore>, admin: unknown): Promise<{ outcome: string | null; jobId: string }> {
  registerLocalRetentionJobs({ admin, now: () => NOW, store });
  const { jobId } = await store.enqueue({
    kind: "local.retention",
    brandKey: null,
    payload: {},
    trigger: "system",
    dedupeKey: `local.retention:${jobSeq += 1}`,
    singleActiveKey: null,
    runAt: null,
    createdBy: null,
    deadlineSeconds: 1800,
    maxInvocations: 10,
  });
  assert.ok(jobId);
  const claimed = await store.claimDue("worker:1", 1, 300, jobId);
  assert.equal(claimed.length, 1);
  const outcome = await runJob(claimed[0]!, {
    store,
    owner: "worker:1",
    deadlineMs: Date.now() + 600_000,
    now: () => Date.now(),
    selfContinue: () => {},
  });
  return { outcome, jobId: jobId as string };
}

test("the retention job and its daily periodic are defined", () => {
  registerLocalRetentionJobs();
  assert.ok(getJobDefinition("local.retention"));
  const periodic = listPeriodics().find((p) => p.name === "local.retention");
  assert.equal(periodic?.everySeconds, 86_400);
  assert.equal(LOCAL_RETENTION_DAYS, 395);
});

test("the periodic enqueues one dated system job (deduped per day)", async () => {
  const store = createMemoryJobStore();
  registerLocalRetentionJobs({ store });
  const periodic = listPeriodics().find((p) => p.name === "local.retention");
  await periodic?.run(new Date("2026-11-10T03:00:00.000Z"));
  await periodic?.run(new Date("2026-11-10T21:00:00.000Z"));
  const job = await store.claimDue("worker:1", 5, 300);
  assert.equal(job.length, 1, "the same day dedupes");
  assert.equal(job[0]?.kind, "local.retention");
  assert.equal(job[0]?.dedupe_key, "local.retention:2026-11-10");
});

test("prunes with now minus 395 days and a batch of 1000, stopping when a batch is short", async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const answers = [
    { fetches: 1000, grids: 12, searches: 0 },
    { fetches: 40, grids: 0, searches: 3 },
  ];
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: answers[calls.length - 1] ?? { fetches: 0, grids: 0, searches: 0 }, error: null };
    },
  };
  const store = createMemoryJobStore();
  const { outcome, jobId } = await runRetention(store, admin);
  assert.equal(outcome, "completed");
  assert.equal(calls.length, 2, "a second batch runs only while a table hit the limit");
  assert.equal(calls[0]?.fn, "prune_local_seo");
  assert.equal(calls[0]?.args.p_limit, LOCAL_PRUNE_BATCH_LIMIT);
  assert.equal(calls[0]?.args.p_before, new Date(NOW - 395 * DAY).toISOString());
  const job = await store.getJob(jobId);
  assert.deepEqual((job as { result?: unknown } | null)?.result, { fetches: 1040, grids: 12, searches: 3 });
});

test("one short batch is enough", async () => {
  let calls = 0;
  const admin = {
    rpc: async () => {
      calls += 1;
      return { data: { fetches: 2, grids: 0, searches: 1 }, error: null };
    },
  };
  const { outcome } = await runRetention(createMemoryJobStore(), admin);
  assert.equal(outcome, "completed");
  assert.equal(calls, 1);
});

test("never runs more than 20 prune steps", async () => {
  let calls = 0;
  const admin = {
    rpc: async () => {
      calls += 1;
      return { data: { fetches: 1000, grids: 1000, searches: 1000 }, error: null };
    },
  };
  const { outcome } = await runRetention(createMemoryJobStore(), admin);
  assert.equal(outcome, "completed");
  assert.equal(calls, LOCAL_MAX_PRUNE_STEPS);
});
