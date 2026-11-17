// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu): src/server/features/rank-tracking/services/scheduledRankChecks.test.ts.
import test from "node:test";
import assert from "node:assert/strict";
import {
  admitByUnitBudget,
  evaluateRankSchedule,
  listRankScheduleItems,
  runRankScheduleTick,
  SCHEDULED_TASK_UNIT_BUDGET,
  type RankScheduleDeps,
} from "./schedules.ts";
import { planWindows } from "../schedule.ts";
import { createMemoryRankTrackingRepository } from "./memoryRepository.ts";
import "./jobs.ts";
import { getJobDefinition } from "../../server/jobs/registry.ts";
import { listPeriodics } from "../../server/jobs/periodic.ts";
import {
  RANK_RETENTION_KIND,
  RANK_SCHEDULES_PERIODIC_NAME,
  RANK_SCHEDULES_TICK_KIND,
} from "./jobs.ts";

test("zero-unit configs are admitted without consuming the budget", () => {
  const result = admitByUnitBudget([
    { id: "empty", keywordCount: 0, devices: "both" },
    { id: "one", keywordCount: 10, devices: "mobile" },
  ], 10);
  assert.deepEqual(result.admitted.map((config) => config.id), ["empty", "one"]);
  assert.equal(result.unitsStarted, 10);
});

test("first non-empty config is admitted even when it exceeds the budget", () => {
  const result = admitByUnitBudget([
    { id: "large", keywordCount: 1000, devices: "both" },
    { id: "next", keywordCount: 1, devices: "mobile" },
  ], 1000);
  assert.deepEqual(result.admitted.map((config) => config.id), ["large"]);
  assert.deepEqual(result.deferred.map((config) => config.id), ["next"]);
});

test("the first overflow defers the rest of the list", () => {
  const result = admitByUnitBudget([
    { id: "a", keywordCount: 600, devices: "mobile" },
    { id: "b", keywordCount: 401, devices: "mobile" },
    { id: "c", keywordCount: 0, devices: "mobile" },
  ], 1000);
  assert.deepEqual(result.admitted.map((config) => config.id), ["a"]);
  assert.deepEqual(result.deferred.map((config) => config.id), ["b", "c"]);
  assert.equal(result.stoppedByBudget, true);
});

const TICK_AT = new Date("2026-11-14T00:05:00.000Z");

async function dueConfig(
  repo: ReturnType<typeof createMemoryRankTrackingRepository>,
  brand: string,
  opts: {
    domain?: string;
    keywords?: string[];
    approved?: number | null;
    devices?: "both" | "desktop" | "mobile";
    next?: string;
    active?: boolean;
  } = {},
) {
  const cfg = await repo.insertConfig({
    brand_key: brand,
    domain: opts.domain ?? `${brand}.example`,
    location_code: 2840,
    language_code: "en",
    location_name: null,
    devices: opts.devices ?? "mobile",
    serp_depth: 10,
    schedule_interval: "weekly",
    is_active: opts.active ?? true,
    next_check_at: opts.next ?? new Date(TICK_AT.getTime() - 60_000).toISOString(),
    last_checked_at: null,
    last_skip_reason: null,
    last_skip_at: null,
    approved_max_usd: "approved" in opts ? (opts.approved ?? null) : 10,
    approval_id: null,
    created_by: null,
  } as any);
  const ids = opts.keywords?.length
    ? await repo.addKeywords(brand, cfg.id, opts.keywords.map((keyword) => ({ keyword })))
    : [];
  return { cfg, ids };
}

function tickCtx() {
  const steps: string[] = [];
  const ctx: any = {
    brandKey: "",
    jobId: "tick-1",
    payload: { at: TICK_AT.toISOString() },
    progress: async () => {},
    step: {
      do: async (name: string, _opts: any, fn: () => Promise<any>) => {
        steps.push(name);
        return fn();
      },
      sleep: async () => {},
    },
  };
  return { steps, ctx };
}

function tickDeps(
  repo: ReturnType<typeof createMemoryRankTrackingRepository>,
  overrides: Record<string, any> = {},
) {
  const quoteCalls: any[] = [];
  const begun: any[] = [];
  let beginResult: any = { ok: true, runId: "run-1", jobId: "job-1" };
  const deps: any = {
    repo,
    isFeatureEnabled: async () => true,
    isBrandActive: async () => true,
    quote: async (...args: any[]) => {
      quoteCalls.push(args);
      return { totalUsd: 0.05, blocked: null };
    },
    beginRankCheckRun: async (...args: any[]) => {
      begun.push(args);
      return beginResult;
    },
    now: () => new Date(TICK_AT.getTime()),
    logger: { error: () => {}, warn: () => {} },
    ...overrides,
  };
  return {
    deps,
    quoteCalls,
    begun,
    setBeginResult: (next: any) => {
      beginResult = next;
    },
  };
}

test("flag off advances with rank_tracking_disabled and starts nothing", async () => {
  const repo = createMemoryRankTrackingRepository();
  const { cfg } = await dueConfig(repo, "brand-a", { keywords: ["kw1"] });
  const before = cfg.next_check_at;
  const kit = tickDeps(repo, { isFeatureEnabled: async () => false });
  const { ctx } = tickCtx();
  const out = await runRankScheduleTick(TICK_AT, ctx, kit.deps);
  assert.equal(out.started, 0);
  assert.deepEqual(out.skipped, { rank_tracking_disabled: 1 });
  assert.equal(kit.begun.length, 0, "no check may start when the flag is off");
  assert.equal(kit.quoteCalls.length, 0, "no pricing call when the flag is off");
  const after = await repo.getConfig("brand-a", cfg.id);
  assert.notEqual(after?.next_check_at, before);
  assert.equal(after?.last_skip_reason, "rank_tracking_disabled");
});

test("claims the slot and starts a due scheduled check", async () => {
  const repo = createMemoryRankTrackingRepository();
  const { cfg } = await dueConfig(repo, "brand-b", { keywords: ["kw1", "kw2"] });
  const kit = tickDeps(repo);
  const { steps, ctx } = tickCtx();
  const out = await runRankScheduleTick(TICK_AT, ctx, kit.deps);
  assert.equal(out.started, 1);
  assert.deepEqual(out.skipped, {});
  assert.equal(steps[0], "list");
  const plan = planWindows(cfg.next_check_at as string, "weekly", TICK_AT.getTime());
  assert.ok(steps.includes(`window:${cfg.id}:${plan.run}`));
  assert.equal(kit.begun.length, 1);
  assert.deepEqual(kit.begun[0][0], { brandKey: "brand-b", userId: null });
  assert.deepEqual(kit.begun[0][1], {
    configId: cfg.id,
    trigger: "scheduled",
    approvedMaxUsd: 10,
  });
  const after = await repo.getConfig("brand-b", cfg.id);
  assert.equal(after?.next_check_at, plan.next);
});

test("a lost compare-and-set skips with concurrent_change and the rest still runs", async () => {
  const repo = createMemoryRankTrackingRepository();
  // Oldest due first: the edited config sorts before the healthy one.
  const edited = await dueConfig(repo, "brand-c1", {
    keywords: ["a"],
    next: new Date(TICK_AT.getTime() - 120_000).toISOString(),
  });
  const healthy = await dueConfig(repo, "brand-c2", {
    keywords: ["b"],
    next: new Date(TICK_AT.getTime() - 60_000).toISOString(),
  });
  const origClaim = repo.claimConfig.bind(repo);
  let calls = 0;
  repo.claimConfig = (async (...args: any[]) => {
    calls += 1;
    if (calls === 1) return false;
    return (origClaim as any)(...args);
  }) as typeof repo.claimConfig;
  const kit = tickDeps(repo);
  const { ctx } = tickCtx();
  const out = await runRankScheduleTick(TICK_AT, ctx, kit.deps);
  assert.deepEqual(out.skipped, { concurrent_change: 1 });
  assert.equal(out.started, 1);
  assert.equal(kit.begun.length, 1);
  assert.equal(kit.begun[0][1].configId, healthy.cfg.id);
  const untouched = await repo.getConfig("brand-c1", edited.cfg.id);
  assert.equal(untouched?.next_check_at, edited.cfg.next_check_at);
});

test("a per-config quote failure is contained as start_failed", async () => {
  const repo = createMemoryRankTrackingRepository();
  const bad = await dueConfig(repo, "brand-d1", {
    keywords: ["a"],
    next: new Date(TICK_AT.getTime() - 120_000).toISOString(),
  });
  await dueConfig(repo, "brand-d2", {
    keywords: ["b"],
    next: new Date(TICK_AT.getTime() - 60_000).toISOString(),
  });
  const kit = tickDeps(repo, {
    quote: async (_key: string, _ctx: unknown, input: any) => {
      if (input.configId === bad.cfg.id) throw new Error("pricing blip");
      return { totalUsd: 0.05, blocked: null };
    },
  });
  const { ctx } = tickCtx();
  const out = await runRankScheduleTick(TICK_AT, ctx, kit.deps);
  assert.equal(out.started, 1);
  assert.deepEqual(out.skipped, { start_failed: 1 });
  assert.equal(out.failed, 0, "the block advance must not fail the tick");
  const blocked = await repo.getConfig("brand-d1", bad.cfg.id);
  assert.equal(blocked?.last_skip_reason, "start_failed");
});

test("already_running restores the slot without touching the skip reason", async () => {
  const repo = createMemoryRankTrackingRepository();
  const { cfg } = await dueConfig(repo, "brand-e", { keywords: ["kw1"] });
  await repo.updateConfig("brand-e", cfg.id, { last_skip_reason: null } as any);
  const kit = tickDeps(repo);
  kit.setBeginResult({ ok: false, reason: "already_running", activeRunId: "run-x" });
  const { ctx } = tickCtx();
  const out = await runRankScheduleTick(TICK_AT, ctx, kit.deps);
  assert.equal(out.started, 0);
  assert.deepEqual(out.skipped, { already_running: 1 });
  const after = await repo.getConfig("brand-e", cfg.id);
  assert.equal(after?.next_check_at, cfg.next_check_at, "slot restored");
  assert.equal(after?.last_skip_reason, null);
});

test("missing approval advances with approval_missing before any pricing", async () => {
  const repo = createMemoryRankTrackingRepository();
  await dueConfig(repo, "brand-f", { keywords: ["kw1"], approved: null });
  const kit = tickDeps(repo);
  const { ctx } = tickCtx();
  const out = await runRankScheduleTick(TICK_AT, ctx, kit.deps);
  assert.deepEqual(out.skipped, { approval_missing: 1 });
  assert.equal(out.started, 0);
  assert.equal(kit.quoteCalls.length, 0, "no pricing call without an approval");
  assert.equal(kit.begun.length, 0);
});

test("a fresh quote above the approval advances with price_changed", async () => {
  const repo = createMemoryRankTrackingRepository();
  await dueConfig(repo, "brand-g", { keywords: ["kw1"], approved: 1 });
  const kit = tickDeps(repo, {
    quote: async () => ({ totalUsd: 5, blocked: null }),
  });
  const { ctx } = tickCtx();
  const out = await runRankScheduleTick(TICK_AT, ctx, kit.deps);
  assert.deepEqual(out.skipped, { price_changed: 1 });
  assert.equal(out.started, 0);
  assert.equal(kit.begun.length, 0, "never above the approved maximum");
});

test("zero-keyword configs advance with no_keywords and consume no budget", async () => {
  const repo = createMemoryRankTrackingRepository();
  await dueConfig(repo, "brand-h", { keywords: [] });
  const kit = tickDeps(repo);
  const { ctx } = tickCtx();
  const out = await runRankScheduleTick(TICK_AT, ctx, kit.deps);
  assert.deepEqual(out.skipped, { no_keywords: 1 });
  assert.equal(kit.quoteCalls.length, 0);
  assert.equal(kit.begun.length, 0);
});

test("an inactive workspace advances with workspace_inactive", async () => {
  const repo = createMemoryRankTrackingRepository();
  await dueConfig(repo, "brand-i", { keywords: ["kw1"] });
  const kit = tickDeps(repo, { isBrandActive: async () => false });
  const { ctx } = tickCtx();
  const out = await runRankScheduleTick(TICK_AT, ctx, kit.deps);
  assert.deepEqual(out.skipped, { workspace_inactive: 1 });
  assert.equal(kit.quoteCalls.length, 0);
  assert.equal(kit.begun.length, 0);
});

test("a missed window runs once at the latest due slot", async () => {
  const repo = createMemoryRankTrackingRepository();
  const observed = new Date(TICK_AT.getTime() - 21 * 86_400_000).toISOString();
  const { cfg } = await dueConfig(repo, "brand-j", { keywords: ["kw1"], next: observed });
  const kit = tickDeps(repo);
  const { ctx } = tickCtx();
  const out = await runRankScheduleTick(TICK_AT, ctx, kit.deps);
  assert.equal(out.started, 1);
  assert.deepEqual(out.skipped, {});
  const plan = planWindows(observed, "weekly", TICK_AT.getTime());
  assert.ok(plan.run !== null, "three weeks late is still due");
  const after = await repo.getConfig("brand-j", cfg.id);
  assert.equal(after?.next_check_at, plan.next);
});

test("scheduled runs start through the queued method", async () => {
  const repo = createMemoryRankTrackingRepository();
  const { cfg } = await dueConfig(repo, "brand-k", { keywords: ["kw1"] });
  const enqueued: any[] = [];
  const kit = tickDeps(repo, {
    beginRankCheckRun: undefined as never,
    enqueueJob: async (kind: string, payload: unknown, opts: Record<string, unknown>) => {
      enqueued.push({ kind, payload, opts });
      return { jobId: "job-9", deduped: false };
    },
  });
  delete (kit.deps as any).beginRankCheckRun;
  const { ctx } = tickCtx();
  const out = await runRankScheduleTick(TICK_AT, ctx, kit.deps);
  assert.equal(out.started, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].kind, "rank_tracking.check");
  assert.equal(enqueued[0].opts.singleActiveKey, `rank_tracking.check:${cfg.id}`);
  assert.equal(enqueued[0].opts.trigger, "scheduled");
  const run = await repo.getActiveRun("brand-k", cfg.id);
  assert.equal(run?.method, "queued");
  assert.equal(run?.trigger, "scheduled");
  assert.equal(Number(run?.approved_max_usd), 10);
});

test("listRankScheduleItems carries units and approvals for admission", async () => {
  const repo = createMemoryRankTrackingRepository();
  const { cfg } = await dueConfig(repo, "brand-l", {
    keywords: ["a", "b", "c"],
    devices: "both",
    approved: 2.5,
  });
  const items = await listRankScheduleItems(
    repo,
    TICK_AT.toISOString(),
    500,
  );
  const item = items.find((entry) => entry.key === cfg.id);
  assert.ok(item);
  assert.equal(item?.keywordCount, 3);
  assert.equal(item?.taskUnits, 6);
  assert.equal(item?.approvedMaxUsd, 2.5);
  assert.equal(item?.interval, "weekly");
});

test("evaluateRankSchedule refuses in spec order", async () => {
  const repo = createMemoryRankTrackingRepository();
  const { cfg } = await dueConfig(repo, "brand-m", { keywords: ["kw1"], approved: null });
  const [item] = await listRankScheduleItems(repo, TICK_AT.toISOString(), 500);
  assert.equal(item.key, cfg.id);
  // Flag off wins over everything else.
  const flagOff = await evaluateRankSchedule(item, { run: null, missed: [], next: "" } as never, tickDeps(repo, { isFeatureEnabled: async () => false }).deps);
  assert.deepEqual(flagOff, { skip: "rank_tracking_disabled" });
  // Inactive workspace wins over approval checks.
  const inactive = await evaluateRankSchedule(item, { run: null, missed: [], next: "" } as never, tickDeps(repo, { isBrandActive: async () => false }).deps);
  assert.deepEqual(inactive, { skip: "workspace_inactive" });
});

test("rank_tracking schedule and retention jobs and periodics are registered", async () => {
  const tick = getJobDefinition(RANK_SCHEDULES_TICK_KIND);
  assert.ok(tick, "tick kind registered");
  assert.equal(tick?.deadlineSeconds, 240);
  assert.equal(tick?.pollAfterSeconds, 20);
  const retention = getJobDefinition(RANK_RETENTION_KIND);
  assert.ok(retention, "retention kind registered");
  const periodics = listPeriodics();
  const schedules = periodics.find((task) => task.name === RANK_SCHEDULES_PERIODIC_NAME);
  assert.ok(schedules);
  assert.equal(schedules?.everySeconds, 300);
  const prune = periodics.find((task) => task.name === RANK_RETENTION_KIND);
  assert.ok(prune);
  assert.equal(prune?.everySeconds, 86_400);
  assert.equal(SCHEDULED_TASK_UNIT_BUDGET, 1000);
});
