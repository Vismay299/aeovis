import test from "node:test";
import assert from "node:assert/strict";
import {
  listDueCustomerSchedules,
  evaluateScheduledScan,
  startScheduledScan,
  blockScheduledScan,
  runDueCustomerSchedules,
  type DueCustomerSchedule,
  type ScanStartContext,
  type AiVisibilityScheduleDeps,
} from "./aiVisibilitySchedules.ts";
import { type WindowPlan } from "./runDue.ts";
import { SpendRefused } from "../../shared/spend/index.ts";

function makeFakeAdmin(overrides: {
  brands?: Record<string, { is_active: boolean }>;
  dispatchControl?: { paused?: boolean; brand_allowlist?: string[] | null };
  schedules?: any[];
  rpcResponses?: Record<string, any>;
} = {}) {
  return {
    from: (table: string) => {
      let filterCol: string;
      let filterVal: any;
      let orderCol: string;
      let ascending = true;
      let limitCount: number | null = null;
      let lteCol: string;
      let lteVal: any;

      const builder: any = {
        select: (_cols: string) => builder,
        eq: (col: string, val: any) => {
          if (col === "brand_key" || col === "brand") {
            filterCol = col;
            filterVal = val;
          }
          return builder;
        },
        lte: (col: string, val: any) => {
          lteCol = col;
          lteVal = val;
          return builder;
        },
        order: (col: string, opts: { ascending: boolean }) => {
          orderCol = col;
          ascending = opts?.ascending ?? true;
          return builder;
        },
        limit: (n: number) => {
          limitCount = n;
          return builder;
        },
        maybeSingle: async () => {
          if (table === "customer_brands") {
            const b = overrides.brands?.[filterVal] ?? { is_active: true };
            return { data: b, error: null };
          }
          if (table === "probe_dispatch_control") {
            return { data: overrides.dispatchControl ?? { paused: false, brand_allowlist: null }, error: null };
          }
          return { data: null, error: null };
        },
        then: (resolve: any) => {
          if (table === "scan_schedules") {
            let list = overrides.schedules ?? [];
            if (lteVal) {
              list = list.filter((r) => new Date(r.next_run_at).getTime() <= new Date(lteVal).getTime());
            }
            if (limitCount !== null) {
              list = list.slice(0, limitCount);
            }
            resolve({ data: list, error: null });
            return;
          }
          resolve({ data: [], error: null });
        },
      };
      return builder;
    },
    rpc: async (fn: string, args: any) => {
      if (overrides.rpcResponses?.[fn]) {
        const resp = overrides.rpcResponses[fn];
        if (typeof resp === "function") return resp(args);
        return resp;
      }
      return { data: { started: true }, error: null };
    },
  } as any;
}

function makeRow(over: Partial<DueCustomerSchedule> = {}): DueCustomerSchedule {
  return {
    key: "offcult.in",
    observedNextRunAt: "2026-10-20T03:30:00.000Z",
    interval: "weekly",
    approvedMaxUsd: 25,
    userId: null,
    ...over,
  };
}

function makePlan(over: Partial<WindowPlan> = {}): WindowPlan {
  return {
    run: "2026-10-20T03:30:00.000Z",
    missed: [],
    next: "2026-10-27T03:30:00.000Z",
    ...over,
  };
}

function makeBaseQuote(totalUsd = 20, blocked: any = null): any {
  return {
    action: "ai_visibility.scan.run",
    totalUsd,
    expectedUsd: 15,
    monthly: { interval: "weekly", runsPerMonth: 4, totalUsd: totalUsd * 4 },
    warnings: [],
    blocked,
    units: [],
    lines: [],
  };
}

test("listDueCustomerSchedules respects limit and orders by next_run_at asc", async () => {
  const rows = [];
  for (let i = 1; i <= 15; i++) {
    rows.push({
      brand: `brand-${i}.com`,
      next_run_at: new Date(Date.now() - (16 - i) * 1000).toISOString(),
      schedule_interval: "weekly",
      approved_max_usd: 20,
    });
  }
  const admin = makeFakeAdmin({ schedules: rows });
  const due = await listDueCustomerSchedules(admin, new Date(), 10);
  assert.equal(due.length, 10);
  assert.equal(due[0].key, "brand-1.com");
  assert.equal(due[9].key, "brand-10.com");
});

test("listDueCustomerSchedules maps customer_updated_by into userId", async () => {
  const dueAt = new Date(Date.now() - 60_000).toISOString();
  const admin = makeFakeAdmin({
    schedules: [
      {
        brand: "with-user.com",
        next_run_at: dueAt,
        schedule_interval: "weekly",
        approved_max_usd: 20,
        customer_updated_by: "user-schedule-owner",
      },
      {
        brand: "no-user.com",
        next_run_at: dueAt,
        schedule_interval: "weekly",
        approved_max_usd: 20,
        customer_updated_by: null,
      },
    ],
  });
  const due = await listDueCustomerSchedules(admin, new Date(), 10);
  assert.equal(due.find((row) => row.key === "with-user.com")?.userId, "user-schedule-owner");
  assert.equal(due.find((row) => row.key === "no-user.com")?.userId, null);
});

test("skip reason 1: scheduling_disabled when isFeatureEnabled is false", async () => {
  const admin = makeFakeAdmin();
  const deps: AiVisibilityScheduleDeps = {
    isFeatureEnabled: async () => false,
  };
  const evalResult = await evaluateScheduledScan(admin, makeRow(), makePlan(), deps);
  assert.deepEqual(evalResult, { skip: "scheduling_disabled" });
});

test("skip reason 2: workspace_inactive when customer_brands.is_active is false", async () => {
  const admin = makeFakeAdmin({
    brands: { "offcult.in": { is_active: false } },
  });
  const deps: AiVisibilityScheduleDeps = {
    isFeatureEnabled: async () => true,
  };
  const evalResult = await evaluateScheduledScan(admin, makeRow(), makePlan(), deps);
  assert.deepEqual(evalResult, { skip: "workspace_inactive" });
});

test("skip reason 3: dispatch_paused and brand_not_allowlisted", async () => {
  const admin = makeFakeAdmin();

  // Dispatch paused with no allowlist -> dispatch_paused
  const deps1: AiVisibilityScheduleDeps = {
    isFeatureEnabled: async () => true,
    dispatchControl: async () => ({ paused: true, brand_allowlist: [] }),
  };
  const r1 = await evaluateScheduledScan(admin, makeRow(), makePlan(), deps1);
  assert.deepEqual(r1, { skip: "dispatch_paused" });

  // Dispatch paused with allowlist not containing this brand -> brand_not_allowlisted
  const deps2: AiVisibilityScheduleDeps = {
    isFeatureEnabled: async () => true,
    dispatchControl: async () => ({ paused: true, brand_allowlist: ["other.com"] }),
  };
  const r2 = await evaluateScheduledScan(admin, makeRow(), makePlan(), deps2);
  assert.deepEqual(r2, { skip: "brand_not_allowlisted" });

  // Dispatch paused but brand IS in allowlist -> continues
  let reserveCalled = false;
  const deps3: AiVisibilityScheduleDeps = {
    isFeatureEnabled: async () => true,
    dispatchControl: async () => ({ paused: true, brand_allowlist: ["offcult.in"] }),
    quote: async () => makeBaseQuote(20),
    dispatchBudget: () => ({ dayCap: null }),
    reserveSpend: async () => {
      reserveCalled = true;
      return { holdId: "hold-1", existing: false };
    },
  };
  const r3 = await evaluateScheduledScan(admin, makeRow(), makePlan(), deps3);
  assert.ok("start" in r3);
  assert.equal(reserveCalled, true);
});

test("skip reason 4: panel_not_approved, no_engines, over_scan_limit from quote blocked", async () => {
  const admin = makeFakeAdmin();
  for (const code of ["panel_not_approved", "no_engines", "over_scan_limit"]) {
    const deps: AiVisibilityScheduleDeps = {
      isFeatureEnabled: async () => true,
      quote: async () => makeBaseQuote(20, { code, message: "blocked" }),
    };
    const res = await evaluateScheduledScan(admin, makeRow(), makePlan(), deps);
    assert.deepEqual(res, { skip: code });
  }
});

test("skip reason 5: price_changed when quote exceeds approved_max_usd", async () => {
  const admin = makeFakeAdmin();
  const deps: AiVisibilityScheduleDeps = {
    isFeatureEnabled: async () => true,
    quote: async () => makeBaseQuote(30), // approvedMaxUsd is 25
  };
  const res = await evaluateScheduledScan(admin, makeRow({ approvedMaxUsd: 25 }), makePlan(), deps);
  assert.deepEqual(res, { skip: "price_changed" });
});

test("skip reason 6: daily_capacity_reached when day spend + quote > dayCap", async () => {
  const admin = makeFakeAdmin();
  const deps: AiVisibilityScheduleDeps = {
    isFeatureEnabled: async () => true,
    quote: async () => makeBaseQuote(20),
    dispatchBudget: () => ({ dayCap: 100 }),
    probeDaySpendToday: async () => 85, // 85 + 20 = 105 > 100
  };
  const res = await evaluateScheduledScan(admin, makeRow(), makePlan(), deps);
  assert.deepEqual(res, { skip: "daily_capacity_reached" });
});

test("skip reason 7: spend refusals map accurately", async () => {
  const admin = makeFakeAdmin();
  const refusalCases = [
    { errorReason: "daily_cap", expectedSkip: "daily_cap" },
    { errorReason: "workspace_cap", expectedSkip: "workspace_cap" },
    { errorReason: "feature_disabled", expectedSkip: "feature_disabled" },
    { errorReason: "over_approved_max", expectedSkip: "price_changed" },
  ];

  for (const { errorReason, expectedSkip } of refusalCases) {
    const deps: AiVisibilityScheduleDeps = {
      isFeatureEnabled: async () => true,
      quote: async () => makeBaseQuote(20),
      dispatchBudget: () => ({ dayCap: null }),
      reserveSpend: async () => {
        throw new SpendRefused(errorReason as any, {
          scope: "workspace",
          limitUsd: 100,
          estimateUsd: 20,
        });
      },
    };
    const res = await evaluateScheduledScan(admin, makeRow(), makePlan(), deps);
    assert.deepEqual(res, { skip: expectedSkip });
  }
});

test("startScheduledScan: successful start wakes worker once and keeps hold", async () => {
  const admin = makeFakeAdmin();
  let rpcArgs: any = null;
  let wokeJobId: string | null = null;
  let releasedHold: string | null = null;

  const ctx: ScanStartContext = {
    jobId: "00000000-0000-0000-0000-000000000001",
    holdId: "hold-123",
    quote: makeBaseQuote(20),
  };

  const deps: AiVisibilityScheduleDeps = {
    startWindowRpc: async (_client, args) => {
      rpcArgs = args;
      return { started: true };
    },
    wakeScanWorker: (jobId) => {
      wokeJobId = jobId;
      return { fired: true, reason: null };
    },
    releaseSpend: async (holdId) => {
      releasedHold = holdId;
      return true;
    },
  };

  const startRes = await startScheduledScan(admin, makeRow(), makePlan(), ctx, deps);
  assert.equal(startRes.started, true);
  assert.equal(wokeJobId, ctx.jobId);
  assert.equal(releasedHold, null); // hold is preserved
  assert.equal(rpcArgs.brand, "offcult.in");
  assert.equal(rpcArgs.jobId, ctx.jobId);
  assert.equal(rpcArgs.approvedMaxUsd, 25);
});

test("startScheduledScan: started:false releases the hold with schedule_<reason>", async () => {
  const admin = makeFakeAdmin();
  let released: { holdId: string; reason: string } | null = null;

  const ctx: ScanStartContext = {
    jobId: "00000000-0000-0000-0000-000000000002",
    holdId: "hold-456",
    quote: makeBaseQuote(20),
  };

  const deps: AiVisibilityScheduleDeps = {
    startWindowRpc: async () => ({ started: false, reason: "active_scan_overlap" }),
    releaseSpend: async (holdId, reason) => {
      released = { holdId, reason };
      return true;
    },
  };

  const res = await startScheduledScan(admin, makeRow(), makePlan(), ctx, deps);
  assert.equal(res.started, false);
  assert.equal(res.reason, "active_scan_overlap");
  assert.deepEqual(released, { holdId: "hold-456", reason: "schedule_active_scan_overlap" });
});

test("startScheduledScan: thrown 23505 unique violation maps to active_scan_overlap and blocks", async () => {
  const admin = makeFakeAdmin();
  let released: { holdId: string; reason: string } | null = null;
  let blockedReason: string | null = null;

  const ctx: ScanStartContext = {
    jobId: "00000000-0000-0000-0000-000000000003",
    holdId: "hold-789",
    quote: makeBaseQuote(20),
  };

  const deps: AiVisibilityScheduleDeps = {
    startWindowRpc: async () => {
      const err: any = new Error("duplicate key value violates unique constraint scan_jobs_one_running_per_workspace");
      err.code = "23505";
      throw err;
    },
    releaseSpend: async (holdId, reason) => {
      released = { holdId, reason };
      return true;
    },
    blockWindowRpc: async (_admin, args) => {
      blockedReason = args.reason;
      return { blocked: true, reason: args.reason };
    },
  };

  const res = await startScheduledScan(admin, makeRow(), makePlan(), ctx, deps);
  assert.equal(res.started, false);
  assert.equal(res.reason, "active_scan_overlap");
  assert.deepEqual(released, { holdId: "hold-789", reason: "schedule_start_failed" });
  assert.equal(blockedReason, "active_scan_overlap");
});

test("startScheduledScan: unexpected thrown RPC error releases hold and rethrows", async () => {
  const admin = makeFakeAdmin();
  let released: { holdId: string; reason: string } | null = null;

  const ctx: ScanStartContext = {
    jobId: "00000000-0000-0000-0000-000000000004",
    holdId: "hold-boom",
    quote: makeBaseQuote(20),
  };

  const deps: AiVisibilityScheduleDeps = {
    startWindowRpc: async () => {
      throw new Error("connection failure");
    },
    releaseSpend: async (holdId, reason) => {
      released = { holdId, reason };
      return true;
    },
  };

  await assert.rejects(
    () => startScheduledScan(admin, makeRow(), makePlan(), ctx, deps),
    /connection failure/,
  );
  assert.deepEqual(released, { holdId: "hold-boom", reason: "schedule_start_failed" });
});

test("runDueCustomerSchedules: ported test 1 - schedule advances even when start cannot happen", async () => {
  const admin = makeFakeAdmin();
  const blocks: string[] = [];

  const items: DueCustomerSchedule[] = [
    makeRow({ key: "skip-me.com" }),
  ];

  const deps: AiVisibilityScheduleDeps = {
    isFeatureEnabled: async () => false, // will skip with scheduling_disabled
    blockWindowRpc: async (_c, args) => {
      blocks.push(`${args.brand}:${args.reason}`);
      return { blocked: true, reason: args.reason };
    },
  };

  const res = await runDueCustomerSchedules(admin, items, new Date("2026-10-21T00:00:00.000Z"), { deps });
  assert.equal(res.started, 0);
  assert.equal(res.skipped.scheduling_disabled, 1);
  assert.deepEqual(blocks, ["skip-me.com:scheduling_disabled"]);
});

test("runDueCustomerSchedules: ported test 2 - a spend refusal is recorded without creating a job", async () => {
  const admin = makeFakeAdmin();
  const blocks: string[] = [];
  let rpcCalled = false;

  const items: DueCustomerSchedule[] = [
    makeRow({ key: "cap-me.com" }),
  ];

  const deps: AiVisibilityScheduleDeps = {
    isFeatureEnabled: async () => true,
    quote: async () => makeBaseQuote(20),
    dispatchBudget: () => ({ dayCap: null }),
    reserveSpend: async () => {
      throw new SpendRefused("workspace_cap", { scope: "workspace", limitUsd: 100, estimateUsd: 20 });
    },
    startWindowRpc: async () => {
      rpcCalled = true;
      return { started: true };
    },
    blockWindowRpc: async (_c, args) => {
      blocks.push(`${args.brand}:${args.reason}`);
      return { blocked: true, reason: args.reason };
    },
  };

  const res = await runDueCustomerSchedules(admin, items, new Date("2026-10-21T00:00:00.000Z"), { deps });
  assert.equal(res.started, 0);
  assert.equal(res.skipped.workspace_cap, 1);
  assert.equal(rpcCalled, false);
  assert.deepEqual(blocks, ["cap-me.com:workspace_cap"]);
});
