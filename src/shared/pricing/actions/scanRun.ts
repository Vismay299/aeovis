// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityCost.ts:60-109
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { definePricedAction, type PricingContext, type PricedActionEstimateResult } from "../pricedActions.ts";
import { formatUsd } from "../../pricing.ts";
import { toMicros, fromMicros } from "../../spend/money.ts";
import { scheduledChecksPerMonth, type AiScheduleInterval } from "../../ai-visibility-pricing.ts";
import { dispatchBudget } from "../../../server/workers/durableProbing.js";
import { resolveEnabledEngines } from "../../scoring/enginePipeline.js";
import { repairWorkflowStore } from "../../../server/db/repairWorkflow.js";
import { getScanSchedule } from "../../../server/db/analytics.js";
import { probeDaySpendToday } from "../probeDaySpend.ts";
import { capFromEnv, MAX_ESTIMATE_USD } from "../../spend/index.ts";

export const scanRunInput = z.strictObject({
  // The scan worker only ever runs the "default" panel (scanWorker.js), so pricing any other
  // panel would quote a scan that never runs.
  panelKey: z.literal("default").default("default"),
  scheduleInterval: z.enum(["daily", "weekly", "monthly"]).optional(),
});

export type ScanQuoteDeps = {
  listPanels?: (brandKey: string, kind: string) => Promise<any[]>;
  getSchedule?: (brandKey: string) => Promise<{ engines?: string | null; [k: string]: any } | null>;
  resolveEngines?: (
    schedule: { engines?: string | null } | null,
    env: Record<string, string | undefined>,
  ) => { configured: string[]; requested: string[] };
  engineStats?: (days: number) => Promise<Array<{ engine: string; median_usd: number | string }>>;
  dispatchControl?: () => Promise<{ paused?: boolean; brand_allowlist?: string[] | null } | null>;
  daySpend?: () => Promise<number>;
  position?: (brandKey: string) => Promise<{
    dailyHeadroomUsd?: number | null;
    monthlyHeadroomUsd?: number | null;
  } | null>;
};

export function resolveScanEngineNames(
  schedule: { engines?: string | null } | null,
  env: Record<string, string | undefined> = process.env,
): { configured: string[]; requested: string[] } {
  const envVal = ((schedule?.engines && String(schedule.engines).trim()) || env.ENGINES || "aio").trim();
  // Deduplicated as the worker freezes its requested names, so "aio,aio" probes once.
  const requested = [
    ...new Set(
      envVal
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const enabled = (resolveEnabledEngines as any)({ engines: requested.join(","), allowFallback: false });
  const configured = (enabled as any[]).map((e: any) => e.name);
  return { configured, requested };
}

export async function estimateScanRun(
  ctx: PricingContext,
  input: z.infer<typeof scanRunInput>,
  deps?: ScanQuoteDeps,
): Promise<PricedActionEstimateResult> {
  const panelKey = input.panelKey ?? "default";
  let blocked: { code: string; message: string; recovery?: string } | null = null;

  // The reads are independent, so they run together. Each falls back on failure: a quote with a
  // missing warning beats no quote, and the run route's own checks stay authoritative.
  const [panels, schedule, statsRows, dispatchControlData, todayCommittedSpend, positionData] =
    await Promise.all([
      loadPanels(ctx, deps),
      loadSchedule(ctx, deps),
      loadEngineStats(ctx, deps),
      loadDispatchControl(ctx, deps),
      loadDaySpend(ctx, deps),
      loadPosition(ctx, deps),
    ]);

  // 1. Panel
  const panel = Array.isArray(panels)
    ? panels.find((p: any) => p.artifact_key === panelKey && p.state === "approved")
    : null;

  let prompts = 0;
  if (!panel) {
    blocked = {
      code: "panel_not_approved",
      message: "Scans ask the questions in your approved question panel. Review and approve it first.",
      recovery: "Open Questions & evidence to approve the panel.",
    };
  } else {
    prompts = Array.isArray(panel.payload?.prompts) ? panel.payload.prompts.length : 0;
    if (prompts === 0) {
      // A zero-answer scan is refused by the worker, so it must not be approvable at $0.
      blocked = {
        code: "panel_empty",
        message: "Your approved question panel has no questions. Add questions and approve it first.",
        recovery: "Open Questions & evidence to add questions.",
      };
    }
  }

  // 2. Engines
  const { configured } = deps?.resolveEngines
    ? deps.resolveEngines(schedule, ctx.env)
    : resolveScanEngineNames(schedule, ctx.env);

  if (configured.length === 0 && !blocked) {
    blocked = {
      code: "no_engines",
      message: "No answer engines are set up for scans yet. Contact Perceev support.",
    };
  }

  // 3. Reservation
  const b = dispatchBudget(ctx.env as any);
  const reserveUsd = b.reserve ?? 1;
  const observations = prompts * configured.length;
  const totalMicros = observations * toMicros(reserveUsd);
  const totalUsd = fromMicros(totalMicros);

  const lines = [
    {
      label: `Answers reserved at ${formatUsd(reserveUsd)} each`,
      quantity: observations,
      unitUsd: reserveUsd,
      totalUsd,
    },
  ];

  const units = [
    { key: "questions", label: "questions", count: prompts },
    { key: "engines", label: "engines", count: configured.length },
    { key: "answers", label: "answers", count: observations },
  ];

  // 4. Per-scan limit
  if (b.scanCap !== null && toMicros(totalUsd) > toMicros(b.scanCap) && !blocked) {
    blocked = {
      code: "over_scan_limit",
      message: `This scan can reserve up to ${formatUsd(totalUsd)}, above the ${formatUsd(b.scanCap)} per-scan limit.`,
      recovery: "Remove questions from the panel or contact Perceev support.",
    };
  }
  // Spend holds and approvals cap out at MAX_ESTIMATE_USD, so a larger quote could never be
  // approved or reserved.
  if (toMicros(totalUsd) > toMicros(MAX_ESTIMATE_USD) && !blocked) {
    blocked = {
      code: "over_scan_limit",
      message: `This scan can reserve up to ${formatUsd(totalUsd)}, above the ${formatUsd(MAX_ESTIMATE_USD)} per-scan limit.`,
      recovery: "Remove questions from the panel or contact Perceev support.",
    };
  }

  // 5. Expected typical cost from engine_cost_stats(30)
  const statsMap = new Map<string, number>();
  for (const row of statsRows) {
    const val = Number(row.median_usd);
    if (Number.isFinite(val)) statsMap.set(row.engine.toLowerCase(), val);
  }

  let expectedUsd: number | null = null;
  if (configured.length > 0 && configured.every((eng) => statsMap.has(eng.toLowerCase()))) {
    let sumMedians = 0;
    for (const eng of configured) {
      sumMedians += statsMap.get(eng.toLowerCase())!;
    }
    const computedExpected = prompts * sumMedians;
    expectedUsd = fromMicros(toMicros(computedExpected));
  }

  // 6. Warnings
  const warnings: Array<{ code: string; message: string }> = [];

  // collection_paused
  if (
    dispatchControlData?.paused === true &&
    !(dispatchControlData.brand_allowlist ?? []).includes(ctx.brandKey)
  ) {
    warnings.push({
      code: "collection_paused",
      message:
        "Answer collection is paused for maintenance. A scan started now will wait, and may finish without answers.",
    });
  }

  // daily_capacity_low (skipped when today's spend could not be read)
  if (
    b.dayCap !== null &&
    todayCommittedSpend !== null &&
    toMicros(b.dayCap) - toMicros(todayCommittedSpend) < toMicros(totalUsd)
  ) {
    warnings.push({
      code: "daily_capacity_low",
      message: "Today's collection capacity is nearly used. This scan may finish with fewer answers.",
    });
  }

  // workspace_limit_low
  if (positionData) {
    if (
      positionData.dailyHeadroomUsd != null &&
      toMicros(positionData.dailyHeadroomUsd) < toMicros(totalUsd)
    ) {
      warnings.push({
        code: "workspace_limit_low",
        message: `This scan needs more than your workspace's remaining daily limit (${formatUsd(positionData.dailyHeadroomUsd)}).`,
      });
    } else if (
      positionData.monthlyHeadroomUsd != null &&
      toMicros(positionData.monthlyHeadroomUsd) < toMicros(totalUsd)
    ) {
      warnings.push({
        code: "workspace_limit_low",
        message: `This scan needs more than your workspace's remaining monthly limit (${formatUsd(positionData.monthlyHeadroomUsd)}).`,
      });
    }
  }

  // retry_note (always)
  warnings.push({
    code: "retry_note",
    message:
      "Each question is asked once per engine. A failed answer may be retried within this amount.",
  });

  // typical_cost (when expectedUsd is known)
  if (expectedUsd !== null) {
    warnings.push({
      code: "typical_cost",
      message: `Typical cost for this scan is about ${formatUsd(expectedUsd)}, based on recent answers.`,
    });
  }

  // 7. Monthly projection
  let monthly: {
    interval: "daily" | "weekly" | "monthly";
    runsPerMonth: number;
    totalUsd: number;
  } | null = null;
  if (input.scheduleInterval) {
    const runsPerMonth = scheduledChecksPerMonth(input.scheduleInterval as AiScheduleInterval);
    const monthlyTotalUsd = fromMicros(totalMicros * runsPerMonth);
    monthly = {
      interval: input.scheduleInterval,
      runsPerMonth,
      totalUsd: monthlyTotalUsd,
    };
  }

  return {
    totalUsd,
    expectedUsd,
    units,
    lines,
    monthly,
    warnings,
    blocked,
  };
}

export const scanRunAction = definePricedAction({
  key: "ai_visibility.scan.run",
  feature: "ai_visibility.scan",
  input: scanRunInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateScanRun(ctx, input),
});

type Position = { dailyHeadroomUsd?: number | null; monthlyHeadroomUsd?: number | null };

function hasFrom(ctx: PricingContext): boolean {
  return Boolean(ctx.admin && typeof ctx.admin.from === "function");
}

function hasRpc(ctx: PricingContext): boolean {
  return Boolean(ctx.admin && typeof ctx.admin.rpc === "function");
}

async function loadPanels(ctx: PricingContext, deps?: ScanQuoteDeps): Promise<any[]> {
  if (deps?.listPanels) return deps.listPanels(ctx.brandKey, "panel");
  if (!hasFrom(ctx)) return [];
  try {
    return await repairWorkflowStore(ctx.admin).list(ctx.brandKey, "panel");
  } catch {
    return [];
  }
}

async function loadSchedule(
  ctx: PricingContext,
  deps?: ScanQuoteDeps,
): Promise<{ engines?: string | null; [k: string]: any } | null> {
  if (deps?.getSchedule) return deps.getSchedule(ctx.brandKey);
  if (!hasFrom(ctx)) return null;
  try {
    return await getScanSchedule(ctx.brandKey, { client: ctx.admin });
  } catch {
    return null;
  }
}

async function loadEngineStats(
  ctx: PricingContext,
  deps?: ScanQuoteDeps,
): Promise<Array<{ engine: string; median_usd: number | string }>> {
  if (deps?.engineStats) return deps.engineStats(30);
  if (!hasRpc(ctx)) return [];
  try {
    const { data, error } = await ctx.admin.rpc("engine_cost_stats", { p_days: 30 });
    return !error && Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function loadDispatchControl(
  ctx: PricingContext,
  deps?: ScanQuoteDeps,
): Promise<{ paused?: boolean; brand_allowlist?: string[] | null } | null> {
  if (deps?.dispatchControl) return deps.dispatchControl();
  if (!hasFrom(ctx)) return null;
  try {
    const { data } = await ctx.admin
      .from("probe_dispatch_control")
      .select("paused, brand_allowlist")
      .eq("singleton", true)
      .maybeSingle();
    return data ?? null;
  } catch {
    return null;
  }
}

async function loadDaySpend(ctx: PricingContext, deps?: ScanQuoteDeps): Promise<number | null> {
  if (deps?.daySpend) return deps.daySpend();
  try {
    return await probeDaySpendToday(ctx.admin, ctx.now);
  } catch {
    return null;
  }
}

/**
 * Headroom under the workspace's F01 caps, computed as reserve_spend does: the
 * workspace_spend_limits row (or the SPEND_DEFAULT_* env when there is none) minus
 * f01_committed_usd since the start of the UTC day / month.
 */
async function loadPosition(ctx: PricingContext, deps?: ScanQuoteDeps): Promise<Position | null> {
  if (deps?.position) return deps.position(ctx.brandKey);
  if (!hasFrom(ctx) || !hasRpc(ctx)) return null;
  try {
    const now = ctx.now ?? new Date();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const committed = async (since: Date): Promise<number> => {
      const { data, error } = await ctx.admin.rpc("f01_committed_usd", {
        p_brand: ctx.brandKey,
        p_feature: null,
        p_since: since.toISOString(),
      });
      if (error) throw error;
      return Number(data ?? 0);
    };
    const [limitsRes, today, month] = await Promise.all([
      ctx.admin
        .from("workspace_spend_limits")
        .select("daily_cap_usd, monthly_cap_usd")
        .eq("brand_key", ctx.brandKey)
        .maybeSingle(),
      committed(dayStart),
      committed(monthStart),
    ]);
    if (limitsRes.error) throw limitsRes.error;
    const limits = limitsRes.data;
    const dailyCap = limits
      ? limits.daily_cap_usd
      : capFromEnv(ctx.env, "SPEND_DEFAULT_DAILY_CAP_USD");
    const monthlyCap = limits
      ? limits.monthly_cap_usd
      : capFromEnv(ctx.env, "SPEND_DEFAULT_MONTHLY_CAP_USD");
    const headroom = (cap: number | string | null, committedUsd: number) =>
      cap == null ? null : Math.max(0, fromMicros(toMicros(Number(cap)) - toMicros(committedUsd)));
    return {
      dailyHeadroomUsd: headroom(dailyCap, today),
      monthlyHeadroomUsd: headroom(monthlyCap, month),
    };
  } catch {
    return null;
  }
}
