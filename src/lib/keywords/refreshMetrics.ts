// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/keywords/services/research/refresh-metrics.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import type { JobContext } from "../jobs/types.ts";
import { DB_STEP, SINGLE_ATTEMPT } from "../jobs/stepConfigs.ts";
import { jobStepKey, StepFailedError } from "../jobs/runner.ts";
import { getKeywordDataProvider } from "../../shared/keyword-locations.ts";
import { normalizeIntent } from "./helpers.ts";
import {
  fetchKeywordMetricsForList,
  type KeywordMetricsClient,
} from "../providers/dataforseo/keyword-metrics.ts";
import {
  upsertKeywordMetrics,
  type KeywordMetricUpsert,
} from "./metricsStore.ts";
import { appendResearch } from "../projectContext/service.ts";
import { createSavedKeywordsRepository, type SavedKeywordsRepository } from "./repository.ts";
import { dataforseoPricing } from "../pricing/dataforseo.ts";
import { getSupabaseAdmin } from "../supabase/admin.js";
import { createLabsClient } from "../providers/dataforseo/labs.ts";
import { createGoogleAdsClient } from "../providers/dataforseo/google-ads.ts";

export const refreshMetricsPayloadSchema = z.strictObject({
  approvedMaxUsd: z.number().positive(),
  requestedBy: z.string().uuid(),
});

export type RefreshMetricsPayload = z.infer<typeof refreshMetricsPayloadSchema>;

export type RefreshMetricsDeps = {
  repo?: SavedKeywordsRepository;
  admin?: any;
  client?: KeywordMetricsClient;
  fetchKeywordMetricsForList?: typeof fetchKeywordMetricsForList;
  upsertKeywordMetrics?: typeof upsertKeywordMetrics;
  appendResearch?: typeof appendResearch;
  now?: () => Date;
};

export type RefreshPlanOutput = {
  startedAt: string;
  before: string;
  markets: Array<{
    locationCode: number;
    languageCode: string;
    stale: number;
    fresh: number;
    batches: number;
  }>;
  fresh: number;
};

export type BatchResultOutput = {
  requested: number;
  updated: number;
  estimateUsd: number;
};

export type RefreshJobResult = {
  updated: number;
  requested: number;
  skippedFresh: number;
  failedBatches: number;
  totalBatches: number;
  stoppedFor?: "over_approved_max";
};

export async function runRefreshMetricsJob(
  ctx: JobContext<RefreshMetricsPayload>,
  deps?: RefreshMetricsDeps,
): Promise<{
  status: "completed" | "partial";
  result: RefreshJobResult;
}> {
  const admin = deps?.admin ?? (typeof getSupabaseAdmin === "function" ? getSupabaseAdmin() : null);
  const repo = deps?.repo ?? (admin ? createSavedKeywordsRepository(admin) : null);
  if (!repo) {
    throw new Error("Saved keywords repository is unavailable.");
  }

  const client: KeywordMetricsClient = deps?.client ?? {
    labs: createLabsClient().labs,
    ads: createGoogleAdsClient(),
  };
  const fetchMetrics = deps?.fetchKeywordMetricsForList ?? fetchKeywordMetricsForList;
  const doUpsert = deps?.upsertKeywordMetrics ?? upsertKeywordMetrics;
  const doAppendResearch = deps?.appendResearch ?? appendResearch;
  const nowFn = deps?.now ?? (() => new Date());

  const brandKey = ctx.brandKey;
  const approvedMaxUsd = ctx.payload.approvedMaxUsd;
  const requestedBy = ctx.payload.requestedBy;

  // Step 1: plan (DB_STEP)
  const plan = await ctx.step.do<RefreshPlanOutput>("plan", DB_STEP, async () => {
    const startedAt = nowFn().toISOString();
    const before = new Date(new Date(startedAt).getTime() - 7 * 86_400_000).toISOString();
    const staleSummary = await repo.staleMarkets(brandKey, before, startedAt);
    return {
      startedAt,
      before,
      markets: staleSummary.markets,
      fresh: staleSummary.fresh,
    };
  });

  const totalBatches = plan.markets.reduce((sum, m) => sum + m.batches, 0);

  let totalRequested = 0;
  let totalUpdated = 0;
  let failedBatches = 0;
  let completedBatches = 0;
  let accumulatedEstimateUsd = 0;
  let stoppedFor: "over_approved_max" | undefined;

  for (const market of plan.markets) {
    if (stoppedFor) break;

    const provider = getKeywordDataProvider(market.locationCode);
    const source = provider === "google_ads" ? "google_ads" : "labs";

    for (let i = 0; i < market.batches; i++) {
      // Calculate batch estimate
      const remainingStale = market.stale - i * 700;
      const batchKeywordCount = Math.max(1, Math.min(700, remainingStale));
      const nextBatchEstimate =
        provider === "google_ads"
          ? dataforseoPricing.keywords.adsSearchVolume({})
          : dataforseoPricing.labs.keywordOverview({
              keywords: new Array(batchKeywordCount),
            });

      // Guard: Over-approved check
      if (accumulatedEstimateUsd + nextBatchEstimate > approvedMaxUsd) {
        stoppedFor = "over_approved_max";
        break;
      }

      const stepName = `batch:${market.locationCode}:${market.languageCode}:${i}`;
      try {
        const batchOutput = await ctx.step.do<BatchResultOutput>(
          stepName,
          SINGLE_ATTEMPT,
          async () => {
            const offset = i * 700;
            const limit = 700;
            const keywords = await repo.staleBatch(
              brandKey,
              market,
              plan.before,
              plan.startedAt,
              offset,
              limit,
            );

            if (keywords.length === 0) {
              return { requested: 0, updated: 0, estimateUsd: 0 };
            }

            const rows = await fetchMetrics(client, {
              keywords,
              locationCode: market.locationCode,
              languageCode: market.languageCode,
              call: (tag) => ({
                brandKey,
                feature: "keywords.metrics_refresh",
                idempotencyKey: `${jobStepKey(ctx, stepName)}:${tag}`,
                maxUsd: approvedMaxUsd,
                jobId: ctx.jobId,
              }),
            });

            if (admin && rows.length > 0) {
              const upsertRows: KeywordMetricUpsert[] = rows.map((r) => ({
                keyword: r.keyword,
                location_code: market.locationCode,
                language_code: market.languageCode,
                search_volume: r.searchVolume,
                cpc: r.cpc,
                competition: r.competition,
                keyword_difficulty: r.keywordDifficulty,
                intent: normalizeIntent(r.intent),
                monthly_searches: r.monthlySearches ?? [],
                source,
              }));
              await doUpsert(admin, upsertRows);
            }

            return {
              requested: keywords.length,
              updated: rows.length,
              estimateUsd: nextBatchEstimate,
            };
          },
        );

        totalRequested += batchOutput.requested;
        totalUpdated += batchOutput.updated;
        accumulatedEstimateUsd += batchOutput.estimateUsd;
      } catch (err) {
        failedBatches++;
        accumulatedEstimateUsd += nextBatchEstimate;
      }

      completedBatches++;
      await ctx.progress(completedBatches, totalBatches, "Updating keyword stats");
    }
  }

  // Step 3: log (DB_STEP)
  if (admin && totalUpdated > 0) {
    try {
      await ctx.step.do("log", DB_STEP, async () => {
        await doAppendResearch(admin, {
          brandKey,
          kind: "keywords.metrics_refresh",
          summary: `Updated stats for ${totalUpdated} saved keywords.`,
          jobId: ctx.jobId,
          author: "user",
          actorUserId: requestedBy,
        });
      });
    } catch {
      // Step log failures should not fail job
    }
  }

  const status = failedBatches > 0 || stoppedFor !== undefined ? "partial" : "completed";

  return {
    status,
    result: {
      updated: totalUpdated,
      requested: totalRequested,
      skippedFresh: plan.fresh,
      failedBatches,
      totalBatches,
      ...(stoppedFor ? { stoppedFor } : {}),
    },
  };
}
