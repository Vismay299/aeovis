// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/rank-tracking/ (cost helpers)
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import {
  definePricedAction,
  type PricingContext,
  type PricedActionEstimateResult,
} from "../pricedActions.ts";
import { dataforseoPricing } from "../dataforseo.ts";
import { fromMicros, toMicros } from "../../spend/money.ts";
import { DEVICES, RANK_SCHEDULES, type Devices } from "../../../shared/rank-tracking.ts";
import { estimateRankCheckUsd } from "../../rank-tracking/cost.ts";
import { normalizeTrackedDomain, resolveTrackerMarket } from "../../rank-tracking/market.ts";
import { createRankTrackingRepository } from "../../rank-tracking/repository.ts";
import { findRecentResearch } from "../../projectContext/service.ts";

const checkRunInput = z.strictObject({
  configId: z.string().uuid(),
  keywordIds: z.array(z.string().uuid()).min(1).max(1000).optional(),
  method: z.enum(["live", "queued"]).default("live"),
});

const configSaveInput = z.strictObject({
  configId: z.string().uuid().optional(),
  draft: z.strictObject({ keywordCount: z.number().int().min(0).max(1000) }).optional(),
  addKeywords: z.array(z.string().trim().min(1).max(200)).max(1000).optional(),
  devices: z.enum(DEVICES).optional(),
  serpDepth: z.number().int().min(10).max(100).refine((v) => v % 10 === 0, "multiple of 10").optional(),
  scheduleInterval: z.enum(RANK_SCHEDULES),
}).refine((v) => (v.configId ? 1 : 0) + (v.draft ? 1 : 0) === 1, {
  message: "exactly one of configId or draft",
});

export type RankTrackingQuoteDeps = {
  findRecentResearch?: typeof findRecentResearch;
};

async function loadConfig(ctx: PricingContext, configId: string) {
  if (!ctx.admin) return null;
  const repo = createRankTrackingRepository(ctx.admin);
  try {
    return await repo.getConfig(ctx.brandKey, configId);
  } catch {
    return null;
  }
}

export async function estimateRankCheckRun(
  ctx: PricingContext,
  input: z.infer<typeof checkRunInput>,
  _deps?: RankTrackingQuoteDeps,
): Promise<PricedActionEstimateResult> {
  const config = await loadConfig(ctx, input.configId);
  if (!config) {
    return {
      totalUsd: 0,
      expectedUsd: 0,
      units: [],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: { code: "tracker_not_found", message: "This tracked domain does not exist." },
    };
  }
  const repo = createRankTrackingRepository(ctx.admin!);
  const keywords = await repo.listKeywords(ctx.brandKey, input.configId);
  const ids = input.keywordIds ? new Set(input.keywordIds) : null;
  const chosen = ids ? keywords.filter((k: any) => ids.has(k.id)) : keywords;
  const keywordStrings = chosen.map((k: any) => k.keyword);
  if (keywordStrings.length === 0) {
    return {
      totalUsd: 0,
      expectedUsd: 0,
      units: [],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: { code: "no_keywords", message: "Add keywords before checking rankings." },
    };
  }
  const est = estimateRankCheckUsd(
    keywordStrings,
    config.devices as Devices,
    config.serp_depth,
    input.method,
  );
  const lines = [
    {
      label: `Check ${keywordStrings.length} keywords on ${config.devices} (${input.method === "live" ? "results now" : "queue price"})`,
      quantity: est.pairs,
      unitUsd: fromMicros(toMicros(est.checkUsd) / Math.max(1, est.pairs)),
      totalUsd: est.checkUsd,
    },
  ];
  if (est.retryUsd > 0) {
    lines.push({
      label: "Re-checks of results that look wrong (up to 2 rounds)",
      quantity: 1,
      unitUsd: est.retryUsd,
      totalUsd: est.retryUsd,
    });
  }
  return {
    totalUsd: est.totalUsd,
    expectedUsd: est.checkUsd,
    units: [
      { key: "keywords", label: "keywords", count: keywordStrings.length },
      { key: "devices", label: "devices", count: input.method === "live" ? 1 : 1 },
      { key: "checks", label: "checks", count: est.pairs },
    ],
    lines,
    monthly: null,
    warnings: [
      {
        code: "retry_note",
        message:
          "Results that look wrong (an error, or 10 or more positions worse than before) are checked again, up to 2 more times. Most checks need no re-check.",
      },
      {
        code: "stop_early_note",
        message: "A check stops at the results page where your site appears, so you are usually charged for fewer pages.",
      },
    ],
    blocked: null,
  };
}

export async function estimateConfigSave(
  ctx: PricingContext,
  input: z.infer<typeof configSaveInput>,
  _deps?: RankTrackingQuoteDeps,
): Promise<PricedActionEstimateResult> {
  let config: any = null;
  if (input.configId) {
    config = await loadConfig(ctx, input.configId);
    if (!config) {
      return {
        totalUsd: 0,
        expectedUsd: 0,
        units: [],
        lines: [],
        monthly: null,
        warnings: [],
        blocked: { code: "tracker_not_found", message: "This tracked domain does not exist." },
      };
    }
  }
  const devices = (input.devices ?? config?.devices ?? "mobile") as Devices;
  const depth = input.serpDepth ?? config?.serp_depth ?? 40;
  const interval = input.scheduleInterval;
  const keywordCount =
    input.draft?.keywordCount ??
    ((config?.keyword_count ?? 0) + (input.addKeywords?.length ?? 0));
  if (keywordCount > 1000) {
    return {
      totalUsd: 0,
      expectedUsd: 0,
      units: [],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: { code: "keyword_limit", message: "A domain can track up to 1,000 keywords." },
    };
  }
  const keywords = Array.from({ length: Math.max(1, keywordCount || 1) }, () => "keyword");
  const method = interval === "manual" ? "live" : "queued";
  const est = estimateRankCheckUsd(keywords, devices, depth, method);
  const lines = [
    {
      label: `Each ${interval === "manual" ? "check" : interval + " check"} of ${keywordCount} keywords on ${devices}`,
      quantity: est.pairs,
      unitUsd: fromMicros(toMicros(est.checkUsd) / Math.max(1, est.pairs)),
      totalUsd: est.checkUsd,
    },
  ];
  if (est.retryUsd > 0 && interval !== "manual") {
    lines.push({
      label: "Re-checks of results that look wrong (up to 2 rounds)",
      quantity: 1,
      unitUsd: est.retryUsd,
      totalUsd: est.retryUsd,
    });
  }
  const runsPerMonth =
    interval === "daily" ? 30 : interval === "weekly" ? 4 : interval === "monthly" ? 1 : 0;
  const monthly =
    interval === "manual"
      ? null
      : { interval, runsPerMonth, totalUsd: est.totalUsd * runsPerMonth };
  const warnings: Array<{ code: string; message: string }> = [
    {
      code: "retry_note",
      message:
        "Results that look wrong (an error, or 10 or more positions worse than before) are checked again, up to 2 more times. Most checks need no re-check.",
    },
  ];
  if (interval === "daily") {
    warnings.push({ code: "daily_note", message: "Daily checks cost about 7 times as much as weekly." });
  }
  if (devices === "both") {
    warnings.push({ code: "both_devices_note", message: "Tracking both devices doubles the cost of every check." });
  }
  if (interval !== "manual") {
    warnings.push({
      code: "schedule_note",
      message: "Each scheduled check reserves up to this amount and is charged only for result pages crawled.",
    });
  }
  return {
    totalUsd: est.totalUsd,
    expectedUsd: est.checkUsd,
    units: [
      { key: "keywords", label: "keywords", count: keywordCount },
      { key: "devices", label: "devices", count: devices === "both" ? 2 : 1 },
    ],
    lines,
    monthly,
    warnings,
    blocked: null,
  };
}

export const rankCheckRunAction = definePricedAction({
  key: "rank_tracking.check.run",
  feature: "rank_tracking.check",
  input: checkRunInput,
  requireApproval: true,
  estimate: (ctx, input) => estimateRankCheckRun(ctx, input),
});

export const rankConfigSaveAction = definePricedAction({
  key: "rank_tracking.config.save",
  feature: "rank_tracking.check",
  input: configSaveInput,
  requireApproval: true,
  estimate: (ctx, input) => estimateConfigSave(ctx, input),
});
