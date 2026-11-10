// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/keywords/services/research/research.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { AppError } from "../http/appError.ts";
import type { CacheDeps } from "../cache/providerCache.ts";
import { cachedIf } from "../research/cache.ts";
import { getKeywordDataProvider } from "../../shared/keyword-locations.ts";
import type {
  KeywordMode,
  KeywordResearchRow,
  ResearchSource,
} from "../../shared/keywords.ts";
import type { LabsClient } from "../providers/dataforseo/labs.ts";
import type { GoogleAdsClient } from "../providers/dataforseo/google-ads.ts";
import {
  interleaveRows,
  normalizeKeyword,
} from "./helpers.ts";
import {
  MIN_NON_SEED_FOR_AUTO,
  countNonSeedKeywords,
} from "./selection.ts";
import {
  fetchGoogleAdsResearchRows,
  fetchResearchRowsBySource,
} from "./researchData.ts";

export const researchResultSchema = z.looseObject({
  rows: z.array(
    z.looseObject({
      keyword: z.string(),
      searchVolume: z.number().nullable(),
      trend: z.array(
        z.looseObject({
          year: z.number(),
          month: z.number(),
          searchVolume: z.number(),
        }),
      ),
      cpc: z.number().nullable(),
      competition: z.number().nullable(),
      keywordDifficulty: z.number().nullable(),
      intent: z.enum([
        "informational",
        "commercial",
        "transactional",
        "navigational",
        "unknown",
      ]),
    }),
  ),
  source: z.enum(["related", "suggestions", "ideas", "google_ads", "blended"]),
  usedFallback: z.boolean(),
});

export type ResearchResult = z.infer<typeof researchResultSchema>;

export const RESEARCH_CACHE = {
  namespace: "keywords.research",
  version: 1,
  ttlSeconds: 86400,
  scope: "global" as const,
};

export type ResolvedResearchInput = {
  keyword: string;
  locationCode: number;
  languageCode: string;
  resultLimit: 150 | 300 | 500;
  mode?: "auto" | "related" | "suggestions" | "ideas";
  clickstream?: boolean;
  groupKeywords?: boolean;
  locationName?: string;
};

export function researchCacheInput(input: {
  keyword: string;
  locationCode: number;
  languageCode: string;
  resultLimit: number;
  mode: KeywordMode;
  clickstream: boolean;
  groupKeywords: boolean;
  locationName?: string | null;
}) {
  return {
    namespace: RESEARCH_CACHE.namespace,
    version: RESEARCH_CACHE.version,
    ttlSeconds: RESEARCH_CACHE.ttlSeconds,
    scope: RESEARCH_CACHE.scope,
    schema: researchResultSchema,
    keyParts: [
      normalizeKeyword(input.keyword),
      input.locationCode,
      input.languageCode,
      input.resultLimit,
      input.mode,
      input.clickstream,
      input.groupKeywords,
      input.locationName ?? null,
    ],
  };
}

export type ResearchDeps = {
  labs: LabsClient;
  ads: GoogleAdsClient;
  upsertMetrics(
    rows: KeywordResearchRow[],
    market: { locationCode: number; languageCode: string },
  ): Promise<void>;
  assertLocalLocation?(code: number, name: string): Promise<void>;
  requestId: string;
  maxUsd?: number;
  brandKey: string;
  keepAlive?: (promise: Promise<unknown>) => void;
  cachedDeps?: { cacheDeps?: CacheDeps };
};

export async function research(
  input: ResolvedResearchInput,
  deps: ResearchDeps,
): Promise<{
  result: ResearchResult;
  fetched: boolean;
  cached: boolean;
  fetchedAt: string;
}> {
  const seedKeyword = normalizeKeyword(input.keyword);
  if (!seedKeyword) {
    throw new AppError(400, "invalid_request", "Seed keyword cannot be empty.");
  }

  const provider = getKeywordDataProvider(input.locationCode);
  const effectiveInput: ResolvedResearchInput =
    provider === "google_ads"
      ? {
          ...input,
          mode: "auto",
          clickstream: false,
          groupKeywords: false,
        }
      : input.locationName
        ? { ...input, clickstream: false }
        : input;
  const mode = effectiveInput.mode ?? "auto";

  const cacheInput = researchCacheInput({
    keyword: seedKeyword,
    locationCode: effectiveInput.locationCode,
    languageCode: effectiveInput.languageCode,
    resultLimit: effectiveInput.resultLimit,
    mode,
    clickstream: effectiveInput.clickstream ?? false,
    groupKeywords: effectiveInput.groupKeywords ?? false,
    locationName: effectiveInput.locationName ?? null,
  });

  const cacheRes = await cachedIf(
    cacheInput,
    async (): Promise<ResearchResult> => {
      if (provider === "google_ads") {
        const rows = await fetchGoogleAdsResearchRows(
          {
            seedKeyword,
            locationCode: effectiveInput.locationCode,
            languageCode: effectiveInput.languageCode,
            resultLimit: effectiveInput.resultLimit,
            call: {
              brandKey: deps.brandKey,
              idempotencyKey: `keywords.research:${deps.requestId}:ads_ideas`,
              maxUsd: deps.maxUsd,
              feature: "keywords.research",
            },
          },
          deps,
        );
        return { rows, source: "google_ads", usedFallback: false };
      }

      if (mode === "auto") {
        const blendLimit = Math.ceil(effectiveInput.resultLimit / 2);
        const [suggestionsResult, ideasResult] = await Promise.allSettled([
          fetchResearchRowsBySource(
            {
              seedKeyword,
              locationCode: effectiveInput.locationCode,
              languageCode: effectiveInput.languageCode,
              resultLimit: blendLimit,
              source: "suggestions",
              includeClickstreamData: effectiveInput.clickstream,
              ignoreSynonyms: !effectiveInput.groupKeywords,
              call: {
                brandKey: deps.brandKey,
                idempotencyKey: `keywords.research:${deps.requestId}:suggestions`,
                maxUsd: deps.maxUsd,
                feature: "keywords.research",
              },
            },
            deps,
          ),
          fetchResearchRowsBySource(
            {
              seedKeyword,
              locationCode: effectiveInput.locationCode,
              languageCode: effectiveInput.languageCode,
              resultLimit: blendLimit,
              source: "ideas",
              includeClickstreamData: effectiveInput.clickstream,
              ignoreSynonyms: !effectiveInput.groupKeywords,
              call: {
                brandKey: deps.brandKey,
                idempotencyKey: `keywords.research:${deps.requestId}:ideas`,
                maxUsd: deps.maxUsd,
                feature: "keywords.research",
              },
            },
            deps,
          ),
        ]);

        if (suggestionsResult.status === "rejected") {
          if (ideasResult.status === "rejected") {
            console.warn(
              "keywords.research.ideas-leg failed:",
              ideasResult.reason,
            );
          }
          throw suggestionsResult.reason;
        }
        if (ideasResult.status === "rejected") {
          throw ideasResult.reason;
        }

        const blended = interleaveRows(
          suggestionsResult.value,
          ideasResult.value,
          effectiveInput.resultLimit,
        );

        if (
          countNonSeedKeywords(blended, seedKeyword) >= MIN_NON_SEED_FOR_AUTO
        ) {
          return { rows: blended, source: "blended", usedFallback: false };
        }

        const relatedRows = await fetchResearchRowsBySource(
          {
            seedKeyword,
            locationCode: effectiveInput.locationCode,
            languageCode: effectiveInput.languageCode,
            resultLimit: effectiveInput.resultLimit,
            source: "related",
            includeClickstreamData: effectiveInput.clickstream,
            ignoreSynonyms: !effectiveInput.groupKeywords,
            call: {
              brandKey: deps.brandKey,
              idempotencyKey: `keywords.research:${deps.requestId}:related`,
              maxUsd: deps.maxUsd,
              feature: "keywords.research",
            },
          },
          deps,
        );

        return {
          rows: interleaveRows(blended, relatedRows, effectiveInput.resultLimit),
          source: "blended",
          usedFallback: true,
        };
      }

      const rows = await fetchResearchRowsBySource(
        {
          seedKeyword,
          locationCode: effectiveInput.locationCode,
          languageCode: effectiveInput.languageCode,
          resultLimit: effectiveInput.resultLimit,
          source: mode,
          includeClickstreamData: effectiveInput.clickstream,
          ignoreSynonyms: !effectiveInput.groupKeywords,
          call: {
            brandKey: deps.brandKey,
            idempotencyKey: `keywords.research:${deps.requestId}:${mode}`,
            maxUsd: deps.maxUsd,
            feature: "keywords.research",
          },
        },
        deps,
      );
      return { rows, source: mode, usedFallback: false };
    },
    (res) => res.rows.length > 0,
    deps.cachedDeps,
  );

  const result = cacheRes.value;
  const hit = cacheRes.hit;

  if (!effectiveInput.locationName && !hit && result.rows.length > 0) {
    const upsertPromise = deps
      .upsertMetrics(result.rows, {
        locationCode: effectiveInput.locationCode,
        languageCode: effectiveInput.languageCode,
      })
      .catch((err) => {
        console.error("[keywords] metrics upsert failed", err);
      });
    if (deps.keepAlive) {
      deps.keepAlive(upsertPromise);
    } else {
      void upsertPromise;
    }
  }

  return {
    result,
    fetched: !hit,
    cached: hit,
    fetchedAt: cacheRes.fetchedAt,
  };
}
