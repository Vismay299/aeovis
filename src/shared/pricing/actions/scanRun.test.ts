import test from "node:test";
import assert from "node:assert/strict";
import {
  estimateScanRun,
  resolveScanEngineNames,
  scanRunInput,
  type ScanQuoteDeps,
} from "./scanRun.ts";
import type { PricingContext } from "../pricedActions.ts";

function fakeContext(over: Partial<PricingContext> = {}): PricingContext {
  return {
    brandKey: "offcult.in",
    admin: {} as any,
    env: {},
    now: new Date("2026-10-21T09:30:00.000Z"),
    ...over,
  };
}

function make30PromptsPanel() {
  const prompts = [];
  for (let i = 1; i <= 28; i++) {
    prompts.push({ text: `Question ${i}`, purpose: "commercial" });
  }
  prompts.push({ text: "Diagnostic 1", purpose: "diagnostic" });
  prompts.push({ text: "Diagnostic 2", purpose: "diagnostic" });
  return [
    {
      artifact_key: "default",
      state: "approved",
      payload: { prompts },
    },
  ];
}

test("reserve 0.2 × 30 prompts (incl. 2 diagnostics) × 4 configured engines = 24.0 exactly", async () => {
  const ctx = fakeContext({
    env: { SCAN_PROBE_RESERVATION_USD: "0.2" },
  });
  const deps: ScanQuoteDeps = {
    listPanels: async () => make30PromptsPanel(),
    getSchedule: async () => ({ engines: "chatgpt,gemini,perplexity,aio" }),
    resolveEngines: () => ({
      configured: ["chatgpt", "gemini", "perplexity", "aio"],
      requested: ["chatgpt", "gemini", "perplexity", "aio"],
    }),
    engineStats: async () => [
      { engine: "chatgpt", median_usd: "0.05" },
      { engine: "gemini", median_usd: "0.05" },
      { engine: "perplexity", median_usd: "0.08" },
      { engine: "aio", median_usd: "0.06" },
    ],
  };

  const res = await estimateScanRun(ctx, { panelKey: "default" }, deps);
  assert.equal(res.blocked, null);
  assert.equal(res.totalUsd, 24.0);
  assert.deepEqual(res.units, [
    { key: "questions", label: "questions", count: 30 },
    { key: "engines", label: "engines", count: 4 },
    { key: "answers", label: "answers", count: 120 },
  ]);
  assert.deepEqual(res.lines, [
    {
      label: "Answers reserved at $0.20 each",
      quantity: 120,
      unitUsd: 0.2,
      totalUsd: 24.0,
    },
  ]);
  // Expected: 30 * (0.05 + 0.05 + 0.08 + 0.06) = 30 * 0.24 = 7.20
  assert.equal(res.expectedUsd, 7.2);
});

test("one unconfigured engine is excluded from quote observations", async () => {
  const ctx = fakeContext({
    env: { SCAN_PROBE_RESERVATION_USD: "0.2" },
  });
  const deps: ScanQuoteDeps = {
    listPanels: async () => make30PromptsPanel(),
    resolveEngines: () => ({
      configured: ["chatgpt", "gemini", "aio"], // perplexity excluded as unconfigured
      requested: ["chatgpt", "gemini", "perplexity", "aio"],
    }),
  };

  const res = await estimateScanRun(ctx, { panelKey: "default" }, deps);
  assert.equal(res.units.find((u) => u.key === "engines")?.count, 3);
  assert.equal(res.units.find((u) => u.key === "answers")?.count, 90);
  assert.equal(res.totalUsd, 18.0);
});

test("reserve defaults to 1 when SCAN_PROBE_RESERVATION_USD is not set", async () => {
  const ctx = fakeContext({
    env: {},
  });
  const deps: ScanQuoteDeps = {
    listPanels: async () => [
      {
        artifact_key: "default",
        state: "approved",
        payload: {
          prompts: Array.from({ length: 10 }, (_, i) => ({ text: `Q${i}` })),
        },
      },
    ],
    resolveEngines: () => ({
      configured: ["chatgpt", "aio"],
      requested: ["chatgpt", "aio"],
    }),
  };

  const res = await estimateScanRun(ctx, { panelKey: "default" }, deps);
  assert.equal(res.totalUsd, 20.0);
  assert.equal(res.lines[0].unitUsd, 1.0);
});

test("0.333333 × 7 exact via micros", async () => {
  const ctx = fakeContext({
    env: { SCAN_PROBE_RESERVATION_USD: "0.333333" },
  });
  const deps: ScanQuoteDeps = {
    listPanels: async () => [
      {
        artifact_key: "default",
        state: "approved",
        payload: {
          prompts: Array.from({ length: 7 }, (_, i) => ({ text: `Q${i}` })),
        },
      },
    ],
    resolveEngines: () => ({
      configured: ["aio"],
      requested: ["aio"],
    }),
  };

  const res = await estimateScanRun(ctx, { panelKey: "default" }, deps);
  // 7 * 333333 micros = 2333331 micros = 2.333331
  assert.equal(res.totalUsd, 2.333331);
});

test("blocked panel_not_approved when no approved panel exists", async () => {
  const ctx = fakeContext();
  const deps: ScanQuoteDeps = {
    listPanels: async () => [],
    resolveEngines: () => ({ configured: ["aio"], requested: ["aio"] }),
  };

  const res = await estimateScanRun(ctx, { panelKey: "default" }, deps);
  assert.deepEqual(res.blocked, {
    code: "panel_not_approved",
    message: "Scans ask the questions in your approved question panel. Review and approve it first.",
    recovery: "Open Questions & evidence to approve the panel.",
  });
});

test("blocked no_engines when 0 engines are configured", async () => {
  const ctx = fakeContext();
  const deps: ScanQuoteDeps = {
    listPanels: async () => make30PromptsPanel(),
    resolveEngines: () => ({ configured: [], requested: ["aio", "chatgpt"] }),
  };

  const res = await estimateScanRun(ctx, { panelKey: "default" }, deps);
  assert.deepEqual(res.blocked, {
    code: "no_engines",
    message: "No answer engines are set up for scans yet. Contact Perceev support.",
  });
});

test("blocked over_scan_limit when quote exceeds SCAN_MAX_COST_PER_SCAN", async () => {
  const ctx = fakeContext({
    env: {
      SCAN_PROBE_RESERVATION_USD: "0.2",
      SCAN_MAX_COST_PER_SCAN: "20",
    },
  });
  const deps: ScanQuoteDeps = {
    listPanels: async () => make30PromptsPanel(),
    resolveEngines: () => ({
      configured: ["chatgpt", "gemini", "perplexity", "aio"],
      requested: ["chatgpt", "gemini", "perplexity", "aio"],
    }),
  };

  const res = await estimateScanRun(ctx, { panelKey: "default" }, deps);
  assert.equal(res.totalUsd, 24.0);
  assert.deepEqual(res.blocked, {
    code: "over_scan_limit",
    message: "This scan can reserve up to $24.00, above the $20.00 per-scan limit.",
    recovery: "Remove questions from the panel or contact Perceev support.",
  });
});

test("warnings: collection_paused when dispatch paused and brand not in allowlist", async () => {
  const ctx = fakeContext({ brandKey: "offcult.in" });
  const deps: ScanQuoteDeps = {
    listPanels: async () => make30PromptsPanel(),
    resolveEngines: () => ({ configured: ["aio"], requested: ["aio"] }),
    dispatchControl: async () => ({
      paused: true,
      brand_allowlist: ["allowed-other.in"],
    }),
  };

  const res = await estimateScanRun(ctx, { panelKey: "default" }, deps);
  const warn = res.warnings.find((w) => w.code === "collection_paused");
  assert.ok(warn);
  assert.equal(
    warn.message,
    "Answer collection is paused for maintenance. A scan started now will wait, and may finish without answers.",
  );
});

test("warnings: daily_capacity_low when remaining platform capacity is below quote", async () => {
  const ctx = fakeContext({
    env: {
      SCAN_PROBE_RESERVATION_USD: "1",
      SCAN_MAX_COST_PER_DAY: "100",
    },
  });
  const deps: ScanQuoteDeps = {
    listPanels: async () => make30PromptsPanel(), // 30 prompts * 1 engine * $1 = $30
    resolveEngines: () => ({ configured: ["aio"], requested: ["aio"] }),
    daySpend: async () => 80, // remaining capacity = 100 - 80 = 20 < 30
  };

  const res = await estimateScanRun(ctx, { panelKey: "default" }, deps);
  const warn = res.warnings.find((w) => w.code === "daily_capacity_low");
  assert.ok(warn);
  assert.equal(
    warn.message,
    "Today's collection capacity is nearly used. This scan may finish with fewer answers.",
  );
});

test("warnings: workspace_limit_low when daily or monthly headroom is below quote", async () => {
  const ctx = fakeContext({
    env: { SCAN_PROBE_RESERVATION_USD: "0.2" },
  });
  // 30 prompts * 4 engines * 0.2 = $24.00
  const depsDaily: ScanQuoteDeps = {
    listPanels: async () => make30PromptsPanel(),
    resolveEngines: () => ({
      configured: ["chatgpt", "gemini", "perplexity", "aio"],
      requested: ["chatgpt", "gemini", "perplexity", "aio"],
    }),
    position: async () => ({
      dailyHeadroomUsd: 15.0,
      monthlyHeadroomUsd: 200.0,
    }),
  };

  const resDaily = await estimateScanRun(ctx, { panelKey: "default" }, depsDaily);
  const warnDaily = resDaily.warnings.find((w) => w.code === "workspace_limit_low");
  assert.ok(warnDaily);
  assert.equal(
    warnDaily.message,
    "This scan needs more than your workspace's remaining daily limit ($15.00).",
  );

  const depsMonthly: ScanQuoteDeps = {
    listPanels: async () => make30PromptsPanel(),
    resolveEngines: () => ({
      configured: ["chatgpt", "gemini", "perplexity", "aio"],
      requested: ["chatgpt", "gemini", "perplexity", "aio"],
    }),
    position: async () => ({
      dailyHeadroomUsd: 50.0,
      monthlyHeadroomUsd: 18.5,
    }),
  };

  const resMonthly = await estimateScanRun(ctx, { panelKey: "default" }, depsMonthly);
  const warnMonthly = resMonthly.warnings.find((w) => w.code === "workspace_limit_low");
  assert.ok(warnMonthly);
  assert.equal(
    warnMonthly.message,
    "This scan needs more than your workspace's remaining monthly limit ($18.50).",
  );
});

test("expectedUsd is null when only 3 of 4 engines have stats rows", async () => {
  const ctx = fakeContext({
    env: { SCAN_PROBE_RESERVATION_USD: "0.2" },
  });
  const deps: ScanQuoteDeps = {
    listPanels: async () => make30PromptsPanel(),
    resolveEngines: () => ({
      configured: ["chatgpt", "gemini", "perplexity", "aio"],
      requested: ["chatgpt", "gemini", "perplexity", "aio"],
    }),
    engineStats: async () => [
      { engine: "chatgpt", median_usd: "0.05" },
      { engine: "gemini", median_usd: "0.05" },
      { engine: "aio", median_usd: "0.06" },
      // perplexity missing!
    ],
  };

  const res = await estimateScanRun(ctx, { panelKey: "default" }, deps);
  assert.equal(res.expectedUsd, null);
  assert.equal(res.warnings.some((w) => w.code === "typical_cost"), false);
});

test("monthly projection handles daily (30), weekly (4), and monthly (1)", async () => {
  const ctx = fakeContext({
    env: { SCAN_PROBE_RESERVATION_USD: "0.2" },
  });
  const deps: ScanQuoteDeps = {
    listPanels: async () => make30PromptsPanel(), // 24.0 per run
    resolveEngines: () => ({
      configured: ["chatgpt", "gemini", "perplexity", "aio"],
      requested: ["chatgpt", "gemini", "perplexity", "aio"],
    }),
  };

  const resDaily = await estimateScanRun(ctx, { panelKey: "default", scheduleInterval: "daily" }, deps);
  assert.deepEqual(resDaily.monthly, {
    interval: "daily",
    runsPerMonth: 30,
    totalUsd: 720.0,
  });

  const resWeekly = await estimateScanRun(ctx, { panelKey: "default", scheduleInterval: "weekly" }, deps);
  assert.deepEqual(resWeekly.monthly, {
    interval: "weekly",
    runsPerMonth: 4,
    totalUsd: 96.0,
  });

  const resMonthly = await estimateScanRun(ctx, { panelKey: "default", scheduleInterval: "monthly" }, deps);
  assert.deepEqual(resMonthly.monthly, {
    interval: "monthly",
    runsPerMonth: 1,
    totalUsd: 24.0,
  });
});

test("blocked panel_empty when the approved panel has no questions", async () => {
  const deps: ScanQuoteDeps = {
    listPanels: async () => [{ artifact_key: "default", state: "approved", payload: { prompts: [] } }],
    resolveEngines: () => ({ configured: ["aio"], requested: ["aio"] }),
  };
  const res = await estimateScanRun(fakeContext(), { panelKey: "default" }, deps);
  assert.equal(res.totalUsd, 0);
  assert.equal(res.blocked?.code, "panel_empty");
});

test("blocked over_scan_limit above the $1,000 spend maximum even with no SCAN_MAX_COST_PER_SCAN", async () => {
  const prompts = Array.from({ length: 300 }, (_, i) => ({ text: `Q${i}`, purpose: "commercial" }));
  const deps: ScanQuoteDeps = {
    listPanels: async () => [{ artifact_key: "default", state: "approved", payload: { prompts } }],
    resolveEngines: () => ({ configured: ["chatgpt", "gemini", "perplexity", "aio"], requested: [] }),
  };
  const res = await estimateScanRun(fakeContext(), { panelKey: "default" }, deps);
  assert.equal(res.totalUsd, 1200);
  assert.equal(res.blocked?.code, "over_scan_limit");
  assert.match(res.blocked!.message, /\$1,000(\.00)? per-scan limit/);
});

test("resolveScanEngineNames deduplicates repeated engine names", () => {
  const { requested } = resolveScanEngineNames({ engines: "aio, AIO,aio" }, {});
  assert.deepEqual(requested, ["aio"]);
});

test("panelKey other than default is rejected, because the worker only runs the default panel", () => {
  assert.equal(scanRunInput.safeParse({ panelKey: "q4" }).success, false);
  assert.equal(scanRunInput.parse({}).panelKey, "default");
});

test("daily_capacity_low is skipped when today's spend cannot be read", async () => {
  const deps: ScanQuoteDeps = {
    listPanels: async () => make30PromptsPanel(),
    resolveEngines: () => ({ configured: ["aio"], requested: ["aio"] }),
    daySpend: async () => null as any,
  };
  const res = await estimateScanRun(fakeContext({ env: { SCAN_MAX_COST_PER_DAY: "1" } }), { panelKey: "default" }, deps);
  assert.equal(res.warnings.some((w) => w.code === "daily_capacity_low"), false);
});

function positionAdmin(o: {
  limits: { daily_cap_usd: number | null; monthly_cap_usd: number | null } | null;
  today: number;
  month: number;
}) {
  const rpcCalls: any[] = [];
  const admin: any = {
    from(table: string) {
      const q: any = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () =>
          table === "workspace_spend_limits" ? { data: o.limits, error: null } : { data: null, error: null },
      };
      return q;
    },
    async rpc(name: string, args: any) {
      rpcCalls.push({ name, args });
      if (name !== "f01_committed_usd") return { data: null, error: null };
      return { data: args.p_since.slice(8, 10) === "01" ? o.month : o.today, error: null };
    },
  };
  return { admin, rpcCalls };
}

test("workspace_limit_low reads workspace_spend_limits and f01_committed_usd (no missing RPC)", async () => {
  const { admin, rpcCalls } = positionAdmin({ limits: { daily_cap_usd: 10, monthly_cap_usd: null }, today: 8, month: 8 });
  const deps: ScanQuoteDeps = {
    listPanels: async () => make30PromptsPanel(),
    resolveEngines: () => ({ configured: ["aio"], requested: ["aio"] }),
    daySpend: async () => 0,
  };
  // ctx.now is the 21st, so the day and month starts differ.
  const res = await estimateScanRun(fakeContext({ admin, env: { SCAN_PROBE_RESERVATION_USD: "0.2" } }), { panelKey: "default" }, deps);
  assert.equal(rpcCalls.some((c) => c.name === "workspace_spend_position"), false);
  assert.ok(rpcCalls.some((c) => c.name === "f01_committed_usd" && c.args.p_feature === null));
  const w = res.warnings.find((x) => x.code === "workspace_limit_low");
  assert.ok(w, "expected workspace_limit_low");
  assert.match(w!.message, /remaining daily limit \(\$2\.00\)/);
});

test("workspace_limit_low falls back to SPEND_DEFAULT_* when the workspace has no limits row", async () => {
  const { admin } = positionAdmin({ limits: null, today: 0, month: 95 });
  const deps: ScanQuoteDeps = {
    listPanels: async () => make30PromptsPanel(),
    resolveEngines: () => ({ configured: ["aio"], requested: ["aio"] }),
    daySpend: async () => 0,
  };
  const res = await estimateScanRun(
    fakeContext({ admin, env: { SCAN_PROBE_RESERVATION_USD: "0.2", SPEND_DEFAULT_MONTHLY_CAP_USD: "100" } }),
    { panelKey: "default" },
    deps,
  );
  const w = res.warnings.find((x) => x.code === "workspace_limit_low");
  assert.ok(w, "expected workspace_limit_low");
  assert.match(w!.message, /remaining monthly limit \(\$5\.00\)/);
});
