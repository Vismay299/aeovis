// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/rank-tracking/services/scheduledRankChecks.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { devicesCount } from "../../shared/rank-tracking.ts";
import type { Devices } from "../../shared/rank-tracking.ts";
import type { ScheduleInterval } from "../../shared/schedule.ts";
import { quoteExceeds } from "../../shared/pricing.ts";
import { AppError } from "../http/appError.ts";
import { isFeatureEnabled } from "../features/flags.ts";
import type { FeatureName } from "../features/names.ts";
import { quote as quotePricedAction } from "../pricing/pricedActions.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";
import type { JobContext, StepOptions } from "../jobs/types.ts";
import {
  runDueSchedules,
  type DueItem,
  type Evaluation,
  type WindowPlan,
} from "../schedules/runDue.ts";
import { createRankTrackingRepository } from "./repository.ts";
import { beginRankCheckRun } from "./runGuards.ts";

export type AdmissionConfig = { id: string; keywordCount: number; devices: Devices };
export type AdmissionResult = {
  admitted: AdmissionConfig[];
  deferred: AdmissionConfig[];
  unitsStarted: number;
  stoppedByBudget: boolean;
};

/** Admit oldest due configs against the per-tick 1,000 task-unit budget. */
export function admitByUnitBudget(configs: AdmissionConfig[], budget = 1000): AdmissionResult {  const admitted: AdmissionConfig[] = [];
  const deferred: AdmissionConfig[] = [];
  let unitsStarted = 0;
  let started = 0;
  let stoppedByBudget = false;
  for (const config of configs) {
    const units = config.keywordCount * devicesCount(config.devices);
    if (started > 0 && unitsStarted + units > budget) {
      stoppedByBudget = true;
      deferred.push(config, ...configs.slice(configs.indexOf(config) + 1));
      break;
    }
    admitted.push(config);
    if (units > 0) {
      started++;
      unitsStarted += units;
    }
  }
  return { admitted, deferred, unitsStarted, stoppedByBudget };
}

/**
 * Scheduled tick (F15 §6.2.11, port of the upstream `scheduledRankChecks.ts`
 * onto F10 `runDueSchedules`). Runs every 5 minutes via
 * `rank_tracking.schedules` → `rank_tracking.schedules.tick`.
 *
 * Order per config (first failure wins): flag off → `rank_tracking_disabled`;
 * workspace inactive → `workspace_inactive`; zero keywords → `no_keywords`;
 * no stored approval → `approval_missing`; fresh F09 quote above the stored
 * approval → `price_changed`; else start a queued check through
 * `beginRankCheckRun`. Skips advance the schedule with their reason; a lost
 * compare-and-set is a `concurrent_change` skip (or a logged no-op for
 * blocks). An `already_running` start restores the slot. Never throws for a
 * single config: F10 contains per-config failures and records `start_failed`.
 */

export const SCHEDULED_TASK_UNIT_BUDGET = 1000;

export type RankScheduleItem = DueItem & {
  brandKey: string;
  approvedMaxUsd: number | null;
  keywordCount: number;
  taskUnits: number;
  devices: Devices;
};

export type RankScheduleStart = { approvedMaxUsd: number };

export type RankScheduleTickResult = {
  started: number;
  skipped: Record<string, number>;
  failed: number;
  notDue: number;
  deferred: number;
};

export type RankScheduleDeps = {
  admin?: any;
  repo?: ReturnType<typeof createRankTrackingRepository>;
  isFeatureEnabled?: (name: FeatureName, brandKey?: string) => Promise<boolean>;
  isBrandActive?: (brandKey: string) => Promise<boolean>;
  quote?: typeof quotePricedAction;
  beginRankCheckRun?: typeof beginRankCheckRun;
  enqueueJob?: (kind: string, payload: unknown, opts: Record<string, unknown>) => Promise<{ jobId: string; deduped: boolean }>;
  getJobStatus?: (jobId: string) => Promise<{ status: string }>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  logger?: Pick<Console, "error" | "warn">;
};

type TickStep = Pick<JobContext<{ at: string }>["step"], "do">;

function repoFor(deps?: RankScheduleDeps) {
  if (deps?.repo) return deps.repo;
  return createRankTrackingRepository(deps?.admin);
}

async function defaultBrandActive(admin: any, brandKey: string): Promise<boolean> {
  if (!admin?.from) {
    throw new AppError(503, "rank_tracking_unavailable", "Rank tracking could not start. Please retry.");
  }
  const { data, error } = await admin
    .from("customer_brands")
    .select("is_active")
    .eq("brand_key", brandKey)
    .maybeSingle();
  if (error) throw error;
  return data?.is_active === true;
}

export async function listRankScheduleItems(
  repo: ReturnType<typeof createRankTrackingRepository>,
  nowIso: string,
  limit = 500,
): Promise<RankScheduleItem[]> {
  const rows = await repo.listDueConfigs(nowIso, limit);
  const byBrand = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byBrand.get(row.brand_key) ?? [];
    group.push(row);
    byBrand.set(row.brand_key, group);
  }
  const counts = new Map<string, number>();
  for (const [brandKey, group] of byBrand) {
    const perBrand = await repo.keywordCounts(
      brandKey,
      group.map((row) => row.id),
    );
    for (const [id, count] of perBrand) counts.set(id, count);
  }
  return rows.map((row) => {
    const keywordCount = counts.get(row.id) ?? 0;
    return {
      key: row.id,
      brandKey: row.brand_key,
      observedNextRunAt: new Date(row.next_check_at as string).toISOString(),
      interval: row.schedule_interval as ScheduleInterval,
      approvedMaxUsd:
        row.approved_max_usd === null || row.approved_max_usd === undefined
          ? null
          : Number(row.approved_max_usd),
      keywordCount,
      taskUnits: keywordCount * devicesCount(row.devices as Devices),
      devices: row.devices as Devices,
    };
  });
}

export async function evaluateRankSchedule(
  item: RankScheduleItem,
  _plan: WindowPlan,
  deps?: RankScheduleDeps,
): Promise<Evaluation<RankScheduleStart>> {
  const checkFeature = deps?.isFeatureEnabled ?? isFeatureEnabled;
  if (!(await checkFeature("rank_tracking", item.brandKey))) {
    return { skip: "rank_tracking_disabled" };
  }
  const active = deps?.isBrandActive
    ? await deps.isBrandActive(item.brandKey)
    : await defaultBrandActive(deps?.admin, item.brandKey);
  if (!active) return { skip: "workspace_inactive" };
  if (item.keywordCount === 0) return { skip: "no_keywords" };
  if (item.approvedMaxUsd === null) return { skip: "approval_missing" };
  const quoteFn = deps?.quote ?? quotePricedAction;
  const pricingCtx = {
    brandKey: item.brandKey,
    admin: deps?.admin ?? null,
    env: deps?.env ?? process.env,
    now: deps?.now ? deps.now() : new Date(),
  } as Parameters<typeof quotePricedAction>[1];
  const fresh = await quoteFn("rank_tracking.check.run", pricingCtx, {
    configId: item.key,
    method: "queued",
  });
  if (fresh.blocked) {
    if (fresh.blocked.code === "no_keywords") return { skip: "no_keywords" };
    throw new AppError(
      503,
      "rank_tracking_unavailable",
      "Rank tracking could not be priced. Please retry.",
    );
  }
  if (quoteExceeds(fresh.totalUsd, item.approvedMaxUsd)) {
    return { skip: "price_changed" };
  }
  return { start: { approvedMaxUsd: item.approvedMaxUsd } };
}

export async function startRankSchedule(
  item: RankScheduleItem,
  plan: WindowPlan,
  start: RankScheduleStart,
  deps?: RankScheduleDeps,
): Promise<{ started: boolean; reason?: string }> {
  const repo = repoFor(deps);
  const claimed = await repo.claimConfig(
    item.brandKey,
    item.key,
    item.observedNextRunAt,
    plan.next,
    { reason: null },
  );
  if (!claimed) return { started: false, reason: "concurrent_change" };
  const begin = deps?.beginRankCheckRun ?? beginRankCheckRun;
  const begun = await begin(
    { brandKey: item.brandKey, userId: null },
    {
      configId: item.key,
      trigger: "scheduled",
      approvedMaxUsd: start.approvedMaxUsd,
    },
    {
      ...(deps?.repo ? { repo: deps.repo } : {}),
      ...(deps?.admin ? { admin: deps.admin } : {}),
      ...(deps?.enqueueJob ? { enqueueJob: deps.enqueueJob } : {}),
      ...(deps?.getJobStatus ? { getJobStatus: deps.getJobStatus } : {}),
    } as Parameters<typeof beginRankCheckRun>[2],
  );
  if (!begun.ok) {
    const restored = await repo.claimConfig(
      item.brandKey,
      item.key,
      plan.next,
      item.observedNextRunAt,
    );
    if (!restored) {
      console.warn("[rank-schedules] restore lost to concurrent change", {
        configId: item.key,
      });
    }
    return { started: false, reason: "already_running" };
  }
  return { started: true };
}

export async function blockRankSchedule(
  item: RankScheduleItem,
  plan: WindowPlan,
  reason: string,
  deps?: RankScheduleDeps,
): Promise<void> {
  const repo = repoFor(deps);
  const claimed = await repo.claimConfig(
    item.brandKey,
    item.key,
    item.observedNextRunAt,
    plan.next,
    { reason },
  );
  if (!claimed) {
    console.warn("[rank-schedules] block lost to concurrent change", {
      configId: item.key,
    });
  }
}

/** One tick: list due configs, admit by task-unit budget, run F10 `runDueSchedules`. */
export async function runRankScheduleTick(
  now: Date,
  ctx: { step: TickStep },
  deps?: RankScheduleDeps,
): Promise<RankScheduleTickResult> {
  const repo = repoFor(deps);
  const nowMs = now.getTime();
  const items = await ctx.step.do("list", DB_STEP, () =>
    listRankScheduleItems(repo, new Date(nowMs).toISOString(), 500),
  );
  const admission = admitByUnitBudget(
    items.map((item) => ({
      id: item.key,
      keywordCount: item.keywordCount,
      devices: item.devices,
    })),
    SCHEDULED_TASK_UNIT_BUDGET,
  );
  const admittedIds = new Set(admission.admitted.map((entry) => entry.id));
  const admitted = items.filter((item) => admittedIds.has(item.key));
  const stepOpts: StepOptions = { timeoutMs: 60_000, retries: 0 };
  const result = await runDueSchedules<RankScheduleItem, RankScheduleStart>({
    items: admitted,
    now: nowMs,
    evaluate: (item, plan) => evaluateRankSchedule(item, plan, deps),
    start: (item, plan, startCtx) => startRankSchedule(item, plan, startCtx, deps),
    block: (item, plan, reason) => blockRankSchedule(item, plan, reason, deps),
    wrap: (name, fn) => ctx.step.do(name, stepOpts, fn),
    logger: deps?.logger,
  });
  return { ...result, deferred: admission.deferred.length };
}
