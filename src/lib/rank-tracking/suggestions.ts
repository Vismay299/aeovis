// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/domain/services/DomainService.ts:122-216
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { AppError } from "../http/appError.ts";
import { cached as defaultCached, type CacheDeps } from "../cache/providerCache.ts";
import { cachedIf, peekCached } from "../research/cache.ts";
import { mapKeywordItem } from "../domain/domainKeywordMapper.ts";
import { normalizeTrackedDomain } from "./market.ts";
import {
  DEFAULT_LOCATION_CODE,
  LOCATION_OPTIONS,
  LOCATIONS,
  isLabsLocationCode,
  resolveLabsMarket,
} from "../../shared/keyword-locations.ts";
import { createLabsClient, type LabsClient } from "../providers/dataforseo/labs.ts";
import { upsertKeywordMetrics as defaultUpsertKeywordMetrics } from "../keywords/metricsStore.ts";
import { appendResearch as defaultAppendResearch } from "../projectContext/service.ts";
import { toResearchError } from "../research/providerErrors.ts";
import type { Workspace } from "./service.ts";

const suggestionItemSchema = z.object({
  keyword: z.string(),
  position: z.number().nullable(),
  searchVolume: z.number().nullable(),
  traffic: z.number().nullable(),
  cpc: z.number().nullable(),
  keywordDifficulty: z.number().nullable(),
});

const suggestionsCacheSchema = z.object({
  keywords: z.array(suggestionItemSchema),
});

export type SuggestedKeyword = z.infer<typeof suggestionItemSchema>;

export type SuggestKeywordsInput = {
  domain: string;
  locationCode: number;
  languageCode?: string;
  maxUsd?: number;
  cacheOnly: boolean;
  requestId: string;
};

export type SuggestKeywordsDeps = {
  labs?: LabsClient["domain"];
  upsertMetrics?: typeof defaultUpsertKeywordMetrics;
  appendResearch?: typeof defaultAppendResearch;
  keepAlive?: (work: Promise<unknown>) => unknown;
  cached?: typeof defaultCached;
  cacheDeps?: CacheDeps;
  now?: () => Date;
};

export const SUGGESTIONS_CACHE_TTL_SECONDS = 86400;

function suggestionsResearchKey(hostname: string, locationCode: number, languageCode: string): string {
  return `${hostname}|${locationCode}|${languageCode}`;
}

function countryLabel(locationCode: number): string {
  return (
    LOCATION_OPTIONS.find((option) => option.code === locationCode)?.label ??
    LOCATIONS[locationCode] ??
    `Location ${locationCode}`
  );
}

export async function suggestKeywordsForDomain(
  ws: Workspace,
  input: SuggestKeywordsInput,
  deps?: SuggestKeywordsDeps,
): Promise<{ keywords: SuggestedKeyword[]; cached: boolean; fetchedAt: string } | null> {
  const hostname = normalizeTrackedDomain(input.domain);
  if (!isLabsLocationCode(input.locationCode)) {
    throw new AppError(
      422,
      "suggestions_unavailable",
      "Ranked-keyword suggestions aren't available for this country. Add the keywords you want to track manually.",
    );
  }
  const market = resolveLabsMarket(
    { locationCode: input.locationCode, languageCode: input.languageCode },
    { locationCode: DEFAULT_LOCATION_CODE, languageCode: "en" },
  );

  const cacheInput = {
    namespace: "rank_tracking.suggestions",
    version: 1,
    keyParts: [hostname, market.locationCode, market.languageCode],
    ttlSeconds: SUGGESTIONS_CACHE_TTL_SECONDS,
    schema: suggestionsCacheSchema,
    scope: "workspace" as const,
    brandKey: ws.brandKey,
  };

  if (input.cacheOnly) {
    const peeked = await peekCached(cacheInput, {
      cached: deps?.cached,
      cacheDeps: deps?.cacheDeps,
    });
    if (!peeked) return null;
    return { keywords: peeked.value.keywords, cached: true, fetchedAt: peeked.fetchedAt };
  }

  const labs = deps?.labs ?? createLabsClient().domain;
  try {
    const res = await cachedIf(
      cacheInput,
      async () => {
        const page = await labs.rankedKeywords(
          {
            brandKey: ws.brandKey,
            feature: "rank_tracking.suggestions",
            idempotencyKey: `rank_tracking.suggestions:${input.requestId}`,
            maxUsd: input.maxUsd,
          },
          {
            target: hostname,
            locationCode: market.locationCode,
            languageCode: market.languageCode,
            limit: 100,
            orderBy: ["ranked_serp_element.serp_item.etv,desc"],
          },
        );
        const keywords = page.items
          .map(mapKeywordItem)
          .filter(
            (item): item is NonNullable<ReturnType<typeof mapKeywordItem>> =>
              item != null,
          )
          .map((item) => ({
            keyword: item.keyword,
            position: item.position,
            searchVolume: item.searchVolume,
            traffic: item.traffic,
            cpc: item.cpc,
            keywordDifficulty: item.keywordDifficulty,
          }));
        return { keywords };
      },
      (value) => value.keywords.length > 0,
      { cached: deps?.cached, cacheDeps: deps?.cacheDeps },
    );

    if (!res.hit && res.value.keywords.length > 0) {
      const keepAlive = deps?.keepAlive ?? ((work: Promise<unknown>) => work);
      const upsert = deps?.upsertMetrics ?? defaultUpsertKeywordMetrics;
      const append = deps?.appendResearch ?? defaultAppendResearch;
      await keepAlive(
        upsert(
          ws.admin,
          res.value.keywords.map((keyword) => ({
            keyword: keyword.keyword,
            location_code: market.locationCode,
            language_code: market.languageCode,
            search_volume: keyword.searchVolume,
            cpc: keyword.cpc,
            competition: null,
            keyword_difficulty: keyword.keywordDifficulty,
            intent: null,
            monthly_searches: [],
            source: "labs_ranked" as const,
          })),
        ).catch((err: unknown) => {
          console.error("[rank-tracking] suggestions metrics upsert failed", err);
        }),
      );
      await append(
        ws.admin,
        {
          brandKey: ws.brandKey,
          kind: "rank_tracking.suggestions",
          researchKey: suggestionsResearchKey(hostname, market.locationCode, market.languageCode),
          summary: `Ranking keywords for ${hostname} in ${countryLabel(market.locationCode)}: ${res.value.keywords.length} found.`,
          spendUsd: null,
          author: "user",
          actorUserId: ws.userId,
        },
      ).catch(() => {});
    }

    return { keywords: res.value.keywords, cached: res.hit, fetchedAt: res.fetchedAt };
  } catch (err) {
    throw toResearchError(err, {
      unavailableCode: "rank_suggestions_unavailable",
      unavailableMessage: "Ranking keywords could not be loaded. You can add keywords manually.",
    });
  }
}
