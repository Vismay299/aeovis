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
import { DEVICES, RANK_SCHEDULES, devicesCount, devicesLabel, type Devices } from "../../../shared/rank-tracking.ts";
import {
  DEFAULT_LOCATION_CODE,
  formatLocationLabel,
  getKeywordDataProvider,
  isLabsLocationCode,
  resolveKeywordDataLanguage,
  resolveLabsMarket,
} from "../../../shared/keyword-locations.ts";
import { KEYWORD_METRICS_BATCH_SIZE } from "../../providers/dataforseo/keyword-metrics.ts";
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
  repo?: ReturnType<typeof createRankTrackingRepository>;
};

async function loadConfig(ctx: PricingContext, configId: string, deps?: RankTrackingQuoteDeps) {
  if (deps?.repo) {
    try {
      return await deps.repo.getConfig(ctx.brandKey, configId);
    } catch {
      return null;
    }
  }
  if (!ctx.admin) return null;
  const repo = createRankTrackingRepository(ctx.admin);
  try {
    return await repo.getConfig(ctx.brandKey, configId);
  } catch {
    return null;
  }
}

function repoFor(ctx: PricingContext, deps?: RankTrackingQuoteDeps) {
  if (deps?.repo) return deps.repo;
  return createRankTrackingRepository(ctx.admin!);
}

export async function estimateRankCheckRun(
  ctx: PricingContext,
  input: z.infer<typeof checkRunInput>,
  _deps?: RankTrackingQuoteDeps,
): Promise<PricedActionEstimateResult> {
  const config = await loadConfig(ctx, input.configId, _deps);
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
  if ((config as any).is_active === false) {
    return {
      totalUsd: 0,
      expectedUsd: 0,
      units: [],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: { code: "tracker_archived", message: "This domain was archived." },
    };
  }
  const repo = repoFor(ctx, _deps);
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
  const devices = (config as any).devices as Devices;
  const label = devicesLabel(devices);
  const est = estimateRankCheckUsd(
    keywordStrings,
    devices,
    (config as any).serp_depth,
    input.method,
  );
  const lines = [
    {
      label: `Check ${keywordStrings.length} keywords on ${label} (${input.method === "live" ? "results now" : "queue price"})`,
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
      { key: "devices", label: "devices", count: devicesCount(devices) },
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
    config = await loadConfig(ctx, input.configId, _deps);
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
  const existingCount = config && _deps?.repo ? await _deps.repo.listKeywords(ctx.brandKey, input.configId!).then((ks) => ks.length) : config ? await createRankTrackingRepository(ctx.admin!).listKeywords(ctx.brandKey, input.configId!).then((ks) => ks.length) : 0;
  const keywordCount =
    input.draft?.keywordCount ??
    (existingCount + (input.addKeywords?.length ?? 0));
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
  const label = devicesLabel(devices);
  const lines = [
    {
      label: `Each ${interval === "manual" ? "check" : interval + " check"} of ${keywordCount} keywords on ${label}`,
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

export const suggestionsRunInput = z.strictObject({
  domain: z.string().trim().min(1).max(253),
  locationCode: z.number().int().positive(),
  languageCode: z.string().min(2).max(8).optional(),
});

export const metricsRunInput = z.strictObject({
  configId: z.string().uuid(),
});

export const SUGGESTIONS_UNAVAILABLE_MESSAGE =
  "Ranked-keyword suggestions aren't available for this country. Add the keywords you want to track manually.";

function suggestionsHostname(domain: string): string {
  try {
    return normalizeTrackedDomain(domain);
  } catch {
    return domain.trim().toLowerCase();
  }
}

export async function estimateSuggestionsRun(
  ctx: PricingContext,
  input: z.infer<typeof suggestionsRunInput>,
  deps?: RankTrackingQuoteDeps,
): Promise<PricedActionEstimateResult> {
  const market = resolveLabsMarket(
    { locationCode: input.locationCode, languageCode: input.languageCode },
    { locationCode: DEFAULT_LOCATION_CODE, languageCode: "en" },
  );
  if (!isLabsLocationCode(input.locationCode)) {
    return {
      totalUsd: 0,
      expectedUsd: 0,
      units: [],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: { code: "suggestions_unavailable", message: SUGGESTIONS_UNAVAILABLE_MESSAGE },
    };
  }
  const cost = fromMicros(toMicros(dataforseoPricing.domain.rankedKeywords({ limit: 100 })));
  const warnings: Array<{ code: string; message: string }> = [
    {
      code: "cache_note",
      message: "Looking up the same domain and country again within 24 hours is free.",
    },
  ];
  if (ctx.admin) {
    try {
      const findRecent = deps?.findRecentResearch ?? findRecentResearch;
      const recent = await findRecent(ctx.admin, {
        brandKey: ctx.brandKey,
        kind: "rank_tracking.suggestions",
        researchKey: `${suggestionsHostname(input.domain)}|${market.locationCode}|${market.languageCode}`,
      });
      if (recent) {
        warnings.push({
          code: "recent_research",
          message: `You looked this up on ${recent.entryDate}: ${recent.summary}`,
        });
      }
    } catch {
      // Ignore research log lookup failures in pricing.
    }
  }
  return {
    totalUsd: cost,
    expectedUsd: cost,
    units: [{ key: "keywords", label: "Ranked keywords", count: 100 }],
    lines: [
      {
        label: "Up to 100 keywords this domain ranks for",
        quantity: 1,
        unitUsd: cost,
        totalUsd: cost,
      },
    ],
    monthly: null,
    warnings,
    blocked: null,
  };
}

function nothingToRefresh(): PricedActionEstimateResult {
  return {
    totalUsd: 0,
    expectedUsd: 0,
    units: [
      { key: "fromCache", label: "Fresh keywords", count: 0 },
      { key: "stale", label: "Stale keywords", count: 0 },
    ],
    lines: [],
    monthly: null,
    warnings: [],
    blocked: {
      code: "nothing_to_refresh",
      message: "Every keyword's stats were updated in the last 7 days.",
    },
  };
}

export async function estimateMetricsRun(
  ctx: PricingContext,
  input: z.infer<typeof metricsRunInput>,
  deps?: RankTrackingQuoteDeps & { now?: () => Date },
): Promise<PricedActionEstimateResult> {
  const config = await loadConfig(ctx, input.configId, deps);
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
  const repo = repoFor(ctx, deps);
  const keywords = await repo.listKeywords(ctx.brandKey, input.configId);

  if ((config as any).location_name != null) {
    if (keywords.length === 0) return nothingToRefresh();
    const lines: Array<{ label: string; quantity: number; unitUsd: number; totalUsd: number }> = [];
    const batches = Math.ceil(keywords.length / KEYWORD_METRICS_BATCH_SIZE);
    for (let i = 0; i < batches; i++) {
      const count = Math.min(KEYWORD_METRICS_BATCH_SIZE, keywords.length - i * KEYWORD_METRICS_BATCH_SIZE);
      const cityUsd = fromMicros(toMicros(dataforseoPricing.keywords.adsSearchVolume({})));
      const kdUsd = fromMicros(
        toMicros(dataforseoPricing.labs.keywordOverview({ keywords: new Array(count) })),
      );
      lines.push({
        label: `City volume for ${count} keywords in ${formatLocationLabel((config as any).location_name)}`,
        quantity: 1,
        unitUsd: cityUsd,
        totalUsd: cityUsd,
      });
      lines.push({
        label: `Difficulty for ${count} keywords`,
        quantity: 1,
        unitUsd: kdUsd,
        totalUsd: kdUsd,
      });
    }
    const totalUsd = fromMicros(lines.reduce((sum, line) => sum + toMicros(line.totalUsd), 0));
    return {
      totalUsd,
      expectedUsd: totalUsd,
      units: [
        { key: "fromCache", label: "Fresh keywords", count: 0 },
        { key: "stale", label: "Stale keywords", count: keywords.length },
      ],
      lines,
      monthly: null,
      warnings: [],
      blocked: null,
    };
  }

  const configRow = config as any;
  const dataLang = resolveKeywordDataLanguage(configRow.location_code, configRow.language_code);
  const now = deps?.now?.() ?? new Date();
  const cutoff = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  let fresh = 0;
  if (keywords.length > 0 && ctx.admin) {
    try {
      const lowered = Array.from(new Set(keywords.map((keyword: any) => String(keyword.keyword).toLowerCase())));
      const freshKeys = new Set<string>();
      for (let index = 0; index < lowered.length; index += 100) {
        const { data, error } = await ctx.admin
          .from("keyword_metrics")
          .select("keyword, fetched_at")
          .eq("location_code", configRow.location_code)
          .eq("language_code", dataLang)
          .in("keyword", lowered.slice(index, index + 100));
        if (error) throw error;
        for (const row of (data as Array<{ keyword: string; fetched_at: string }> | null) ?? []) {
          if (Date.parse(row.fetched_at) > Date.parse(cutoff)) freshKeys.add(String(row.keyword).toLowerCase());
        }
      }
      fresh = keywords.filter((keyword: any) => freshKeys.has(String(keyword.keyword).toLowerCase())).length;
    } catch {
      // A failed read prices every keyword as stale (never under-quotes).
      fresh = 0;
    }
  }
  const stale = keywords.length - fresh;
  if (stale === 0) return nothingToRefresh();

  const provider = getKeywordDataProvider(configRow.location_code);
  const lines: Array<{ label: string; quantity: number; unitUsd: number; totalUsd: number }> = [];
  const batches = Math.ceil(stale / KEYWORD_METRICS_BATCH_SIZE);
  for (let i = 0; i < batches; i++) {
    const count = Math.min(KEYWORD_METRICS_BATCH_SIZE, stale - i * KEYWORD_METRICS_BATCH_SIZE);
    const batchUsd =
      provider === "google_ads"
        ? fromMicros(toMicros(dataforseoPricing.keywords.adsSearchVolume({})))
        : fromMicros(
            toMicros(dataforseoPricing.labs.keywordOverview({ keywords: new Array(count) })),
          );
    lines.push({
      label: `Keyword stats for ${count} keywords`,
      quantity: 1,
      unitUsd: batchUsd,
      totalUsd: batchUsd,
    });
  }
  const totalUsd = fromMicros(lines.reduce((sum, line) => sum + toMicros(line.totalUsd), 0));
  return {
    totalUsd,
    expectedUsd: totalUsd,
    units: [
      { key: "fromCache", label: "Fresh keywords", count: fresh },
      { key: "stale", label: "Stale keywords", count: stale },
    ],
    lines,
    monthly: null,
    warnings: [],
    blocked: null,
  };
}

export const rankSuggestionsRunAction = definePricedAction({
  key: "rank_tracking.suggestions.run",
  feature: "rank_tracking.suggestions",
  input: suggestionsRunInput,
  requireApproval: false,
  estimate: (ctx, input) => estimateSuggestionsRun(ctx, input),
});

export const rankMetricsRunAction = definePricedAction({
  key: "rank_tracking.metrics.run",
  feature: "rank_tracking.metrics",
  input: metricsRunInput,
  requireApproval: true,
  estimate: (ctx, input) => estimateMetricsRun(ctx, input),
});
