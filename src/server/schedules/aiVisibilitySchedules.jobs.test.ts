import test from "node:test";
import assert from "node:assert/strict";
import {
  SCHEDULES_TICK_KIND,
  SCHEDULES_PERIODIC_NAME,
  registerAiVisibilityScheduleJobs,
  resetAiVisibilityScheduleJobDeps,
} from "./aiVisibilitySchedules.jobs.ts";
import { getJobDefinition } from "../jobs/registry.ts";
import { listPeriodics } from "../jobs/periodic.ts";
import type { DueCustomerSchedule } from "./aiVisibilitySchedules.ts";

test("periodic ai_visibility.schedules is defined with 300s interval", () => {
  const p = listPeriodics().find((t) => t.name === SCHEDULES_PERIODIC_NAME);
  assert.ok(p, "periodic should be registered");
  assert.equal(p.everySeconds, 300);
});

test("ai_visibility.schedules.tick job definition has correct options", () => {
  const def = getJobDefinition(SCHEDULES_TICK_KIND);
  assert.ok(def, "job definition should exist");
  assert.equal(def.deadlineSeconds, 240);
  assert.equal(def.pollAfterSeconds, 20);
});

test("periodic run enqueues tick job with correct dedupeKey and singleActiveKey", async () => {
  const p = listPeriodics().find((t) => t.name === SCHEDULES_PERIODIC_NAME);
  assert.ok(p);

  const enqueued: any[] = [];
  const fakeStore = {
    enqueue: async (job: any) => {
      enqueued.push(job);
      return { jobId: "job-1", deduped: false };
    },
  } as any;

  registerAiVisibilityScheduleJobs({
    store: fakeStore,
  });

  const now = new Date(1730000000000);
  await p.run(now);

  assert.equal(enqueued.length, 1);
  const q = enqueued[0];
  assert.equal(q.kind, SCHEDULES_TICK_KIND);
  assert.equal(q.singleActiveKey, SCHEDULES_PERIODIC_NAME);
  const expectedSlot = Math.floor(now.getTime() / 300000);
  assert.equal(q.dedupeKey, `${SCHEDULES_PERIODIC_NAME}:${expectedSlot}`);

  resetAiVisibilityScheduleJobDeps();
});

test("ai_visibility.schedules.tick handler processes due items via step.do", async () => {
  const def = getJobDefinition(SCHEDULES_TICK_KIND);
  assert.ok(def);

  const dueItems: DueCustomerSchedule[] = [
    {
      key: "due-start.com",
      observedNextRunAt: "2026-10-20T03:30:00.000Z",
      interval: "weekly",
      approvedMaxUsd: 20,
      userId: null,
    },
    {
      key: "due-skip.com",
      observedNextRunAt: "2026-10-20T03:30:00.000Z",
      interval: "weekly",
      approvedMaxUsd: 20,
      userId: null,
    },
  ];

  const stepsExecuted: string[] = [];

  const fakeCtx: any = {
    jobId: "tick-job-1",
    brandKey: "system",
    payload: {},
    trigger: { type: "system" },
    step: {
      do: async (name: string, _opts: any, fn: () => Promise<any>) => {
        stepsExecuted.push(name);
        return fn();
      },
      sleep: async () => {},
    },
  };

  const scheduleDeps: any = {
    isFeatureEnabled: async (_f: string, brand: string) => {
      // due-start is enabled, due-skip is disabled
      return brand === "due-start.com";
    },
    quote: async () => ({
      action: "ai_visibility.scan.run",
      totalUsd: 15,
      expectedUsd: 10,
      monthly: { interval: "weekly", runsPerMonth: 4, totalUsd: 60 },
      warnings: [],
      blocked: null,
      units: [],
      lines: [],
    }),
    dispatchBudget: () => ({ dayCap: null }),
    reserveSpend: async () => ({ holdId: "hold-ok", existing: false }),
    releaseSpend: async () => {},
    startWindowRpc: async () => ({ started: true }),
    blockWindowRpc: async () => ({ blocked: true, reason: "scheduling_disabled" }),
    wakeScanWorker: () => ({ fired: true, reason: null }),
  };

  const fakeAdmin = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: { is_active: true }, error: null }),
        }),
      }),
    }),
  } as any;

  registerAiVisibilityScheduleJobs({
    admin: fakeAdmin,
    now: () => new Date("2026-10-21T00:00:00.000Z"),
    listDue: async () => dueItems,
    scheduleDeps,
  });

  const res = await def.handler(fakeCtx);
  assert.equal(res.status, "completed");
  const r = res.result as any;
  assert.equal(r.started, 1);
  assert.equal(r.skipped.scheduling_disabled, 1);
  assert.equal(r.failed, 0);

  // Check step names executed: "list", then windows and blocks
  assert.ok(stepsExecuted.includes("list"));
  assert.ok(stepsExecuted.some((s) => s.startsWith("window:due-start.com:")));
  assert.ok(stepsExecuted.some((s) => s.startsWith("window:due-skip.com:")));
  assert.ok(stepsExecuted.some((s) => s.startsWith("block:due-skip.com:")));

  resetAiVisibilityScheduleJobDeps();
});
