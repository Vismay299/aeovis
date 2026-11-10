// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/client.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../../http/appError.ts";
import { keepAlive as defaultKeepAlive } from "../../keepAlive.js";
import {
  metered as defaultMetered,
  reserveSpend as defaultReserveSpend,
  settleSpendBatch as defaultSettleSpendBatch,
  releaseSpend as defaultReleaseSpend,
  usd6,
  type SpendCost,
  type SpendDeps,
} from "../../spend/index.ts";
import {
  AmbiguousCallError,
  ChargedCallError,
  UnbilledCallError,
} from "../../spend/errors.ts";
import type { SpendFeature } from "../../../shared/spend-features.ts";
import { dataforseoEndpoint, type DataforseoApiResponse } from "./envelope.ts";
import {
  dataforseoPricing,
  SERP_ANALYSIS_DEPTH,
} from "../../pricing/dataforseo.ts";
import {
  fetchLiveSerp,
  fetchLocalSerp,
  fetchRankCheckSerp,
  postLocalSerpTasks,
  postRankCheckTasks,
  type FetchLiveSerpInput,
  type FetchRankCheckSerpInput,
  type LocalSerpInput,
  type PostedRankCheckTask,
  type PostLocalSerpInput,
  type PostRankCheckInput,
  type RankCheckResult,
  type SerpLiveItem,
} from "./serp.ts";
import {
  fetchLlmAggregatedMetrics,
  fetchLlmCrossAggregatedMetrics,
  fetchLlmMentionsSearch,
  fetchLlmTopPages,
  type LlmAggregatedMetricsInput,
  type LlmCrossAggregatedMetricsInput,
  type LlmMentionsSearchInput,
  type LlmTopPagesInput,
} from "./ai.ts";
import type {
  LlmAggregatedTotal,
  LlmCrossAggregatedItem,
  LlmMentionItem,
  LlmTopPagesItem,
} from "./llmSchemas.ts";

export type DataforseoCallContext = {
  brandKey: string;
  idempotencyKey: string;
  maxUsd?: number;
  jobId?: string;
  ttlSeconds?: number;
  feature?: SpendFeature;
};

export type Metered<I, T> = (
  ctx: DataforseoCallContext,
  input: I,
) => Promise<T>;

export type MeteredBatch<I, T> = (
  ctx: DataforseoCallContext,
  inputs: I[],
) => Promise<PromiseSettledResult<T>[]>;

export function meter<I, T>(
  fetcher: (input: I) => Promise<DataforseoApiResponse<T>>,
  estimate: (input: I) => number,
  defaultFeature: SpendFeature | null,
  deps?: { metered?: typeof defaultMetered; spendDeps?: SpendDeps },
): Metered<I, T> {
  const meteredFn = deps?.metered ?? defaultMetered;

  return async (ctx: DataforseoCallContext, input: I): Promise<T> => {
    const feature = ctx.feature ?? defaultFeature;
    if (!feature) {
      throw new AppError(
        500,
        "spend_feature_required",
        "A spend feature is required for metered DataForSEO calls.",
      );
    }
    const estimateUsd = usd6(estimate(input));
    return await meteredFn(
      {
        brandKey: ctx.brandKey,
        feature,
        estimateUsd,
        maxUsd: ctx.maxUsd,
        idempotencyKey: ctx.idempotencyKey,
        jobId: ctx.jobId,
        ttlSeconds: ctx.ttlSeconds,
      },
      async () => {
        const r = await fetcher(input);
        return {
          value: r.data,
          actualUsd: r.billing.costUsd,
          provider: "dataforseo",
          endpoint: dataforseoEndpoint(r.billing.path),
          billed: true,
          units: 1,
        };
      },
      deps?.spendDeps,
    );
  };
}

export function meterBatch<I, T>(
  fetcher: (input: I) => Promise<DataforseoApiResponse<T>>,
  estimate: (input: I) => number,
  defaultFeature: SpendFeature | null,
  deps?: {
    reserveSpend?: typeof defaultReserveSpend;
    settleSpendBatch?: typeof defaultSettleSpendBatch;
    releaseSpend?: typeof defaultReleaseSpend;
    keepAlive?: typeof defaultKeepAlive;
    spendDeps?: SpendDeps;
  },
): MeteredBatch<I, T> {
  const reserveSpendFn = deps?.reserveSpend ?? defaultReserveSpend;
  const settleSpendBatchFn = deps?.settleSpendBatch ?? defaultSettleSpendBatch;
  const releaseSpendFn = deps?.releaseSpend ?? defaultReleaseSpend;
  const keepAliveFn = deps?.keepAlive ?? defaultKeepAlive;

  return async (
    ctx: DataforseoCallContext,
    inputs: I[],
  ): Promise<PromiseSettledResult<T>[]> => {
    if (inputs.length === 0) return [];
    const feature = ctx.feature ?? defaultFeature;
    if (!feature) {
      throw new AppError(
        500,
        "spend_feature_required",
        "A spend feature is required for metered DataForSEO calls.",
      );
    }

    const callEstimates = inputs.map((input) => usd6(estimate(input)));
    const totalEstimateUsd = usd6(callEstimates.reduce((sum, e) => sum + e, 0));

    const { holdId, existing } = await reserveSpendFn(
      {
        brandKey: ctx.brandKey,
        feature,
        estimateUsd: totalEstimateUsd,
        maxUsd: ctx.maxUsd,
        idempotencyKey: ctx.idempotencyKey,
        jobId: ctx.jobId,
        ttlSeconds: ctx.ttlSeconds,
      },
      deps?.spendDeps,
    );

    if (existing) {
      throw new AppError(
        409,
        "duplicate_paid_call",
        "This paid request was already made.",
      );
    }

    const work = (async (): Promise<PromiseSettledResult<T>[]> => {
      const billedCosts: Array<SpendCost | null> = inputs.map(() => null);

      const settled = await Promise.allSettled(
        inputs.map(async (input, index) => {
          try {
            const result = await fetcher(input);
            billedCosts[index] = {
              provider: "dataforseo",
              endpoint: dataforseoEndpoint(result.billing.path),
              actualUsd: usd6(result.billing.costUsd),
              costSource: "provider_reported",
              units: 1,
            };
            return result.data;
          } catch (error) {
            if (error instanceof ChargedCallError) {
              billedCosts[index] = {
                provider: error.provider || "dataforseo",
                endpoint: error.endpoint || "/dataforseo",
                actualUsd: usd6(error.actualUsd),
                costSource: "provider_reported",
                units: 1,
              };
              throw error;
            }
            if (error instanceof AmbiguousCallError) {
              billedCosts[index] = {
                provider: "dataforseo",
                endpoint: "/dataforseo",
                actualUsd: null,
                costSource: "provider_reported",
                units: 1,
              };
              throw error;
            }
            if (error instanceof UnbilledCallError) {
              throw error;
            }
            billedCosts[index] = {
              provider: "dataforseo",
              endpoint: "/dataforseo",
              actualUsd: null,
              costSource: "provider_reported",
              units: 1,
            };
            throw error;
          }
        }),
      );

      const activeCosts = billedCosts.filter((c): c is SpendCost => c !== null);
      if (activeCosts.length > 0) {
        await settleSpendBatchFn(holdId, activeCosts, deps?.spendDeps);
      } else {
        await releaseSpendFn(holdId, "not_billed", deps?.spendDeps);
      }

      return settled;
    })();

    keepAliveFn(work, { label: "meterBatch:" + feature });
    return await work;
  };
}

export type DataforseoClientDeps = {
  spendDeps?: SpendDeps;
  metered?: typeof defaultMetered;
  reserveSpend?: typeof defaultReserveSpend;
  settleSpendBatch?: typeof defaultSettleSpendBatch;
  releaseSpend?: typeof defaultReleaseSpend;
  keepAlive?: typeof defaultKeepAlive;
  fetchers?: {
    fetchLiveSerp?: typeof fetchLiveSerp;
    fetchRankCheckSerp?: typeof fetchRankCheckSerp;
    postRankCheckTasks?: typeof postRankCheckTasks;
    fetchLocalSerp?: typeof fetchLocalSerp;
    postLocalSerpTasks?: typeof postLocalSerpTasks;
    fetchLlmMentionsSearch?: typeof fetchLlmMentionsSearch;
    fetchLlmAggregatedMetrics?: typeof fetchLlmAggregatedMetrics;
    fetchLlmTopPages?: typeof fetchLlmTopPages;
    fetchLlmCrossAggregatedMetrics?: typeof fetchLlmCrossAggregatedMetrics;
  };
};

export function createDataforseoClient(deps?: DataforseoClientDeps) {
  const f = deps?.fetchers;
  const liveSerp = f?.fetchLiveSerp ?? fetchLiveSerp;
  const rankCheckSerp = f?.fetchRankCheckSerp ?? fetchRankCheckSerp;
  const rankCheckTaskPost = f?.postRankCheckTasks ?? postRankCheckTasks;
  const localSerp = f?.fetchLocalSerp ?? fetchLocalSerp;
  const localTaskPost = f?.postLocalSerpTasks ?? postLocalSerpTasks;

  const mentionsSearch = f?.fetchLlmMentionsSearch ?? fetchLlmMentionsSearch;
  const aggregatedMetrics =
    f?.fetchLlmAggregatedMetrics ?? fetchLlmAggregatedMetrics;
  const topPages = f?.fetchLlmTopPages ?? fetchLlmTopPages;
  const crossAggregatedMetrics =
    f?.fetchLlmCrossAggregatedMetrics ?? fetchLlmCrossAggregatedMetrics;

  const meterDeps = { metered: deps?.metered, spendDeps: deps?.spendDeps };
  const batchDeps = {
    reserveSpend: deps?.reserveSpend,
    settleSpendBatch: deps?.settleSpendBatch,
    releaseSpend: deps?.releaseSpend,
    keepAlive: deps?.keepAlive,
    spendDeps: deps?.spendDeps,
  };

  return {
    serp: {
      live: meter(
        liveSerp,
        (i: FetchLiveSerpInput) =>
          dataforseoPricing.serp.live({
            depth: i.depth ?? SERP_ANALYSIS_DEPTH,
            keyword: i.keyword,
          }),
        null,
        meterDeps,
      ),
      rankCheckBatch: meterBatch(
        rankCheckSerp,
        (i: FetchRankCheckSerpInput) => dataforseoPricing.serp.rankCheck(i),
        null,
        batchDeps,
      ),
      rankCheckTaskPost: meter(
        rankCheckTaskPost,
        (i: PostRankCheckInput) =>
          dataforseoPricing.serp.rankCheckTaskPost(i),
        null,
        meterDeps,
      ),
      local: meter(
        localSerp,
        (i: LocalSerpInput) => dataforseoPricing.serp.local(i),
        null,
        meterDeps,
      ),
      localTaskPost: meter(
        localTaskPost,
        (i: PostLocalSerpInput) => dataforseoPricing.serp.localTaskPost(i),
        null,
        meterDeps,
      ),
    },
    aiSearch: {
      mentionsSearch: meter(
        mentionsSearch,
        (i: LlmMentionsSearchInput) =>
          dataforseoPricing.aiSearch.mentionsSearch(i),
        null,
        meterDeps,
      ),
      aggregatedMetrics: meter(
        aggregatedMetrics,
        (i: LlmAggregatedMetricsInput) =>
          dataforseoPricing.aiSearch.aggregatedMetrics(i),
        null,
        meterDeps,
      ),
      topPages: meter(
        topPages,
        (i: LlmTopPagesInput) => dataforseoPricing.aiSearch.topPages(i),
        null,
        meterDeps,
      ),
      crossAggregatedMetrics: meter(
        crossAggregatedMetrics,
        (i: LlmCrossAggregatedMetricsInput) =>
          dataforseoPricing.aiSearch.crossAggregatedMetrics(i),
        null,
        meterDeps,
      ),
    },
  };
}
