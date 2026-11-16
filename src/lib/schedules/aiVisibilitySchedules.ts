// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/scheduledAiVisibility.ts:16-83
//   src/server/features/ai-visibility/repositories/AiVisibilityRepository.ts:226-243, 263-277
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { type ScheduleInterval } from "../../shared/schedule.ts";
import { quoteExceeds, type PriceQuote } from "../../shared/pricing.ts";
import { isFeatureEnabled } from "../features/flags.ts";
import type { FeatureName } from "../features/names.ts";
import { quote as quotePricedAction, type PricingContext } from "../pricing/pricedActions.ts";
import { dispatchBudget } from "../workers/durableProbing.js";
import { probeDaySpendToday } from "../pricing/probeDaySpend.ts";
import { reserveSpend, releaseSpend, SpendRefused } from "../spend/index.ts";
import { makeSelfContinue } from "../selfContinue.js";
import { captureServerEvent } from "../telemetry/server.ts";
import { runDueSchedules, type DueItem, type Evaluation, type WindowPlan } from "./runDue.ts";

export type DueCustomerSchedule = DueItem & {
  approvedMaxUsd: number;
  /**
   * The person who last saved the schedule (`scan_schedules.customer_updated_by`,
   * migration 085). A scheduled window has no acting user, so this is the
   * consenting identity `schedule:skipped` carries; null sends nothing.
   */
  userId: string | null;
};

export type ScanStartContext = {
  jobId: string;
  holdId: string;
  quote: PriceQuote;
};

export const wakeScanWorker = makeSelfContinue({
  routePath: "/api/scan/worker",
  label: "customer-schedule",
});

export type AiVisibilityScheduleDeps = {
  isFeatureEnabled?: (name: FeatureName, brandKey?: string) => Promise<boolean>;
  dispatchControl?: (admin: SupabaseClient) => Promise<{ paused?: boolean; brand_allowlist?: string[] | null } | null>;
  quote?: (key: string, ctx: PricingContext, rawInput: unknown) => Promise<PriceQuote>;
  dispatchBudget?: (env: Record<string, string | undefined>) => { dayCap: number | null; burstCap?: number | null };
  probeDaySpendToday?: (admin: SupabaseClient) => Promise<number>;
  reserveSpend?: typeof reserveSpend;
  releaseSpend?: typeof releaseSpend;
  randomUUID?: () => string;
  startWindowRpc?: (
    admin: SupabaseClient,
    args: {
      brand: string;
      now: string;
      observedNext: string;
      windowAt: string;
      missed: string[];
      next: string;
      jobId: string;
      approvedMaxUsd: number;
      quote: PriceQuote;
    },
  ) => Promise<{ started: boolean; reason?: string }>;
  blockWindowRpc?: (
    admin: SupabaseClient,
    args: {
      brand: string;
      now: string;
      observedNext: string;
      windowAt: string;
      missed: string[];
      next: string;
      reason: string;
    },
  ) => Promise<{ blocked: boolean; reason: string }>;
  wakeScanWorker?: (jobId: string) => { fired: boolean; reason: string | null };
  env?: Record<string, string | undefined>;
  now?: () => Date;
};

export async function listDueCustomerSchedules(
  admin: SupabaseClient,
  now: Date | number | string,
  limit = 10,
): Promise<DueCustomerSchedule[]> {
  const nowIso =
    typeof now === "string"
      ? now
      : (now instanceof Date ? now : new Date(now)).toISOString();

  const { data, error } = await admin
    .from("scan_schedules")
    .select("brand, next_run_at, schedule_interval, approved_max_usd, customer_updated_by")
    .eq("managed_by", "customer")
    .eq("enabled", true)
    .lte("next_run_at", nowIso)
    .order("next_run_at", { ascending: true })
    .limit(limit);

  if (error) throw error;

  return (data || []).map((row: any) => ({
    key: row.brand,
    observedNextRunAt: new Date(row.next_run_at).toISOString(),
    interval: row.schedule_interval as ScheduleInterval,
    approvedMaxUsd: Number(row.approved_max_usd),
    userId: row.customer_updated_by ?? null,
  }));
}

export async function evaluateScheduledScan(
  admin: SupabaseClient,
  row: DueCustomerSchedule,
  _plan: WindowPlan,
  deps?: AiVisibilityScheduleDeps,
): Promise<Evaluation<ScanStartContext>> {
  const env = deps?.env ?? process.env;
  const now = deps?.now ? deps.now() : new Date();

  // 1. isFeatureEnabled("customer_scheduling", brand) false -> scheduling_disabled
  const checkFeature = deps?.isFeatureEnabled ?? isFeatureEnabled;
  const enabled = await checkFeature("customer_scheduling", row.key);
  if (!enabled) {
    return { skip: "scheduling_disabled" };
  }

  // 2. customer_brands.is_active false -> workspace_inactive
  const { data: brandRow, error: brandErr } = await admin
    .from("customer_brands")
    .select("is_active")
    .eq("brand_key", row.key)
    .maybeSingle();

  if (brandErr || !brandRow || brandRow.is_active !== true) {
    return { skip: "workspace_inactive" };
  }

  // 3. probe_dispatch_control (singleton): paused and brand not in brand_allowlist ->
  // brand_not_allowlisted when allowlist is non-empty, else dispatch_paused
  let dispatchControlData: { paused?: boolean; brand_allowlist?: string[] | null } | null = null;
  if (deps?.dispatchControl) {
    dispatchControlData = await deps.dispatchControl(admin);
  } else {
    try {
      const { data } = await admin
        .from("probe_dispatch_control")
        .select("paused, brand_allowlist")
        .eq("singleton", true)
        .maybeSingle();
      dispatchControlData = data ?? null;
    } catch {
      dispatchControlData = null;
    }
  }

  if (dispatchControlData?.paused) {
    const rawAllow = dispatchControlData.brand_allowlist;
    const allowlist = Array.isArray(rawAllow)
      ? rawAllow.map((b) => String(b).trim()).filter(Boolean)
      : [];
    if (!allowlist.includes(row.key)) {
      return {
        skip: allowlist.length > 0 ? "brand_not_allowlisted" : "dispatch_paused",
      };
    }
  }

  // 4. quote = await quote("ai_visibility.scan.run", ctx, { panelKey: "default" })
  const quoteFn = deps?.quote ?? quotePricedAction;
  const pricingCtx: PricingContext = {
    brandKey: row.key,
    admin,
    env,
    now,
  };

  const quoteResult = await quoteFn("ai_visibility.scan.run", pricingCtx, {
    panelKey: "default",
  });

  if (quoteResult.blocked) {
    const code = quoteResult.blocked.code;
    if (code === "panel_not_approved" || code === "no_engines" || code === "over_scan_limit") {
      return { skip: code };
    }
  }

  // 5. quoteExceeds(quote.totalUsd, row.approved_max_usd) -> price_changed
  if (quoteExceeds(quoteResult.totalUsd, row.approvedMaxUsd)) {
    return { skip: "price_changed" };
  }

  // 6. b = dispatchBudget(env); b.dayCap !== null and probeDaySpendToday(admin) + quote.totalUsd > b.dayCap -> daily_capacity_reached
  const budgetFn = deps?.dispatchBudget ?? dispatchBudget;
  const b = budgetFn(env as any);
  if (b.dayCap !== null && b.dayCap !== undefined) {
    const probeDaySpendFn = deps?.probeDaySpendToday ?? probeDaySpendToday;
    const todaySpend = await probeDaySpendFn(admin);
    if (todaySpend + quoteResult.totalUsd > b.dayCap) {
      return { skip: "daily_capacity_reached" };
    }
  }

  // 7. jobId = crypto.randomUUID(); reserveSpend(...)
  const uuidGen = deps?.randomUUID ?? crypto.randomUUID;
  const jobId = uuidGen();
  const reserveFn = deps?.reserveSpend ?? reserveSpend;

  let holdId: string;
  try {
    const hold = await reserveFn({
      brandKey: row.key,
      feature: "ai_visibility.scan" as any,
      estimateUsd: Math.max(quoteResult.totalUsd, 0.000001),
      maxUsd: row.approvedMaxUsd,
      idempotencyKey: "scan:" + jobId,
      ttlSeconds: 86340,
      subject: { kind: "scan_job", id: jobId },
    });
    holdId = hold.holdId;
  } catch (error) {
    if (error instanceof SpendRefused) {
      const reason = error.reason === "over_approved_max" ? "price_changed" : error.reason;
      return { skip: reason };
    }
    throw error;
  }

  // 8. -> { start: { jobId, holdId, quote } }
  return {
    start: {
      jobId,
      holdId,
      quote: quoteResult,
    },
  };
}

export async function startScheduledScan(
  admin: SupabaseClient,
  row: DueCustomerSchedule,
  plan: WindowPlan,
  ctx: ScanStartContext,
  deps?: AiVisibilityScheduleDeps,
): Promise<{ started: boolean; reason?: string }> {
  const releaseFn = deps?.releaseSpend ?? releaseSpend;
  const wakeFn = deps?.wakeScanWorker ?? wakeScanWorker;
  const nowIso = (deps?.now ? deps.now() : new Date()).toISOString();

  let rpcResult: { started: boolean; reason?: string };

  try {
    if (deps?.startWindowRpc) {
      rpcResult = await deps.startWindowRpc(admin, {
        brand: row.key,
        now: nowIso,
        observedNext: row.observedNextRunAt,
        windowAt: plan.run,
        missed: plan.missed,
        next: plan.next,
        jobId: ctx.jobId,
        approvedMaxUsd: row.approvedMaxUsd,
        quote: ctx.quote,
      });
    } else {
      const { data, error } = await admin.rpc("start_customer_window", {
        p_brand: row.key,
        p_now: nowIso,
        p_observed_next: row.observedNextRunAt,
        p_window_at: plan.run,
        p_missed: plan.missed,
        p_next: plan.next,
        p_job_id: ctx.jobId,
        p_approved_max: row.approvedMaxUsd,
        p_quote: ctx.quote,
      });

      if (error) {
        throw error;
      }
      rpcResult = data as { started: boolean; reason?: string };
    }
  } catch (err: any) {
    await releaseFn(ctx.holdId, "schedule_start_failed").catch(() => {});

    // Check for 23505 unique violation on scan_jobs_one_running_per_workspace
    const isOverlap =
      err?.code === "23505" ||
      String(err?.message || "").includes("23505") ||
      String(err?.message || "").includes("scan_jobs_one_running_per_workspace");

    if (isOverlap) {
      await blockScheduledScan(admin, row, plan, "active_scan_overlap", deps);
      return { started: false, reason: "active_scan_overlap" };
    }

    throw err;
  }

  if (!rpcResult.started) {
    await releaseFn(ctx.holdId, "schedule_" + (rpcResult.reason || "unknown")).catch(() => {});
    return rpcResult;
  }

  wakeFn(ctx.jobId);
  return { started: true };
}

export async function blockScheduledScan(
  admin: SupabaseClient,
  row: DueCustomerSchedule,
  plan: WindowPlan,
  reason: string,
  deps?: AiVisibilityScheduleDeps,
): Promise<void> {
  const nowIso = (deps?.now ? deps.now() : new Date()).toISOString();

  // F26 §6.2.7 `schedule:skipped { reason }`, after the skip is recorded. A
  // scheduled window has no acting user; the person who last saved the schedule
  // (`customer_updated_by`) is the consenting identity. A row with no user still
  // sends nothing — that is the consent gate working, not a missing event.
  const captureSkip = () => {
    try {
      void captureServerEvent({
        name: "schedule:skipped",
        props: { reason },
        userId: row.userId ?? null,
        brandKey: row.key,
      }).catch(() => {});
    } catch {
      // Telemetry never changes whether the window is blocked.
    }
  };

  if (deps?.blockWindowRpc) {
    await deps.blockWindowRpc(admin, {
      brand: row.key,
      now: nowIso,
      observedNext: row.observedNextRunAt,
      windowAt: plan.run,
      missed: plan.missed,
      next: plan.next,
      reason,
    });
    captureSkip();
    return;
  }

  const { error } = await admin.rpc("block_customer_window", {
    p_brand: row.key,
    p_now: nowIso,
    p_observed_next: row.observedNextRunAt,
    p_window_at: plan.run,
    p_missed: plan.missed,
    p_next: plan.next,
    p_reason: reason,
  });

  if (error) throw error;
  captureSkip();
}

export function createAiVisibilityScheduleAdapter(
  admin: SupabaseClient,
  deps?: AiVisibilityScheduleDeps,
) {
  return {
    evaluate: (item: DueCustomerSchedule, plan: WindowPlan) =>
      evaluateScheduledScan(admin, item, plan, deps),
    start: (item: DueCustomerSchedule, plan: WindowPlan, ctx: ScanStartContext) =>
      startScheduledScan(admin, item, plan, ctx, deps),
    block: (item: DueCustomerSchedule, plan: WindowPlan, reason: string) =>
      blockScheduledScan(admin, item, plan, reason, deps),
  };
}

export async function runDueCustomerSchedules(
  admin: SupabaseClient,
  items: DueCustomerSchedule[],
  now: number | Date,
  options: {
    wrap?: (name: string, fn: () => Promise<void>) => Promise<void>;
    logger?: Pick<Console, "error" | "warn">;
    deps?: AiVisibilityScheduleDeps;
  } = {},
) {
  const adapter = createAiVisibilityScheduleAdapter(admin, options.deps);
  const nowMs = typeof now === "number" ? now : now.getTime();

  return runDueSchedules<DueCustomerSchedule, ScanStartContext>({
    items,
    now: nowMs,
    evaluate: adapter.evaluate,
    start: adapter.start,
    block: adapter.block,
    wrap: options.wrap,
    logger: options.logger,
  });
}
