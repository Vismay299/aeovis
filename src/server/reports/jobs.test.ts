// F23-AC-25 unit half: the daily reports.retention job prunes share-view rows
// older than 395 days through prune_report_share_views. The SQL itself is
// exercised by `node scripts/qa/check-f23-db.mjs --group retention`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { getJobDefinition } from "../jobs/registry.ts";
import { listPeriodics } from "../jobs/periodic.ts";
import { createMemoryJobStore } from "../jobs/memoryStore.ts";
import { runJob } from "../jobs/runner.ts";
import {
  REPORTS_MAX_PRUNE_STEPS,
  REPORTS_PRUNE_BATCH_LIMIT,
  REPORTS_RETENTION_DAYS,
  REPORTS_RETENTION_KIND,
  registerReportJobs,
} from "./jobs.ts";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const DAY = 86_400_000;
let seq = 0;

async function runRetention(
  store: ReturnType<typeof createMemoryJobStore>,
  admin: unknown
): Promise<{ outcome: string | null; jobId: string }> {
  registerReportJobs({ admin, now: () => NOW, store, selfContinue: () => {} });
  const { jobId } = await store.enqueue({
    kind: REPORTS_RETENTION_KIND,
    brandKey: null,
    payload: {},
    trigger: "system",
    dedupeKey: `${REPORTS_RETENTION_KIND}:${(seq += 1)}`,
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
  registerReportJobs();
  assert.ok(getJobDefinition(REPORTS_RETENTION_KIND));
  const periodic = listPeriodics().find((entry) => entry.name === REPORTS_RETENTION_KIND);
  assert.equal(periodic?.everySeconds, 86_400);
  assert.equal(REPORTS_RETENTION_DAYS, 395);
  assert.equal(REPORTS_PRUNE_BATCH_LIMIT, 5_000);
  assert.equal(REPORTS_MAX_PRUNE_STEPS, 20);
});

test("the periodic enqueues one dated system job, deduped per day", async () => {
  const store = createMemoryJobStore();
  registerReportJobs({ store, selfContinue: () => {} });
  const periodic = listPeriodics().find((entry) => entry.name === REPORTS_RETENTION_KIND);
  await periodic?.run(new Date("2026-11-17T03:00:00.000Z"));
  await periodic?.run(new Date("2026-11-17T21:00:00.000Z"));
  const jobs = await store.claimDue("worker:1", 5, 300);
  assert.equal(jobs.length, 1, "the same day dedupes");
  assert.equal(jobs[0]?.kind, REPORTS_RETENTION_KIND);
  assert.equal(jobs[0]?.dedupe_key, "reports.retention:2026-11-17");
});

test("prunes with a date 395 days back and a batch of 5,000, stopping on a short batch", async () => {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const answers = [REPORTS_PRUNE_BATCH_LIMIT, 40];
  const admin = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      calls.push({ fn, args });
      return { data: answers[calls.length - 1] ?? 0, error: null };
    },
  };
  const store = createMemoryJobStore();
  const { outcome, jobId } = await runRetention(store, admin);

  assert.equal(outcome, "completed");
  assert.equal(calls.length, 2, "a second batch runs only while the first hit the limit");
  assert.equal(calls[0]?.fn, "prune_report_share_views");
  assert.equal(calls[0]?.args.p_limit, REPORTS_PRUNE_BATCH_LIMIT);
  assert.equal(calls[0]?.args.p_before, new Date(NOW - REPORTS_RETENTION_DAYS * DAY).toISOString().slice(0, 10));
  const job = await store.getJob(jobId);
  assert.deepEqual((job as { result?: unknown } | null)?.result, { views: 5_040 });
});

test("one short batch is enough", async () => {
  let calls = 0;
  const admin = {
    rpc: async () => {
      calls += 1;
      return { data: 2, error: null };
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
      return { data: REPORTS_PRUNE_BATCH_LIMIT, error: null };
    },
  };
  const { outcome } = await runRetention(createMemoryJobStore(), admin);
  assert.equal(outcome, "completed");
  assert.equal(calls, REPORTS_MAX_PRUNE_STEPS);
});

test("a database without migrations 150-151 yet completes with nothing pruned", async () => {
  for (const code of ["PGRST202", "42883"]) {
    let calls = 0;
    const admin = {
      rpc: async () => {
        calls += 1;
        return { data: null, error: { code, message: "function prune_report_share_views does not exist" } };
      },
    };
    const store = createMemoryJobStore();
    const { outcome, jobId } = await runRetention(store, admin);
    assert.equal(outcome, "completed", code);
    assert.equal(calls, 1, "no second batch after a missing function");
    const job = await store.getJob(jobId);
    assert.deepEqual((job as { result?: unknown } | null)?.result, { views: 0 });
  }
});

test("any other database error still fails the job", async () => {
  const admin = {
    rpc: async () => ({ data: null, error: { code: "57014", message: "canceling statement due to statement timeout" } }),
  };
  const { outcome } = await runRetention(createMemoryJobStore(), admin);
  assert.notEqual(outcome, "completed");
});

test("a numeric string from the driver is counted", async () => {
  const admin = {
    rpc: async () => ({ data: "12", error: null }),
  };
  const store = createMemoryJobStore();
  const { jobId } = await runRetention(store, admin);
  const job = await store.getJob(jobId);
  assert.deepEqual((job as { result?: unknown } | null)?.result, { views: 12 });
});
