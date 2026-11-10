// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/domain/services/DomainService.ts, domainKeywordsPage.ts, domainPagesPage.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { cached as defaultCached, type CacheDeps } from "../cache/providerCache.ts";
import { cachedIf, peekCached } from "../research/cache.ts";
import { keepAlive as defaultKeepAlive } from "../keepAlive.js";
import { parseResearchTargetOrThrow, toRelativePath } from "../research/target.ts";
import type { ResearchScope } from "../../shared/researchScope.ts";
import type { LabsClient, RelevantPagesItem } from "../providers/dataforseo/labs.ts";
import {
  buildKeywordFilters,
  buildOrderBy,
  type DomainKeywordsFilters,
  type DomainKeywordsSortMode,
  type DomainKeywordsSortOrder,
} from "./domainKeywordFilters.ts";
import {
  buildPageFilters,
  buildPagesOrderBy,
  type DomainPagesFilters,
  type DomainPagesSortMode,
  type DomainPagesSortOrder,
} from "./domainPagesFilters.ts";
import { mapKeywordItem } from "./domainKeywordMapper.ts";
import { computeHasMore } from "./pagination.ts";
import {
  buildRankedKeywordsScopeFilter,
  buildRelevantPagesScopeFilter,
} from "../providers/dataforseo/researchScopeFilters.ts";
import { joinClauses } from "../providers/dataforseo/filters.ts";

export const DOMAIN_CACHE_SCOPE = "workspace" as const;
export const DOMAIN_TTL_SECONDS = 12 * 60 * 60; // 12 hours

export type KeywordMetricInsertRow = {
  keyword: string;
  location_code: number;
  language_code: string;
  search_volume: number | null;
  cpc: number | null;
  competition: number | null;
  keyword_difficulty: number | null;
  intent: string | null;
  monthly_searches: unknown[];
  source: string;
};

export type DomainServiceDeps = {
  labs: LabsClient;
  brandKey: string;
  requestId: string;
  maxUsd?: number;
  cacheOnly?: boolean;
  upsertMetrics?: (rows: KeywordMetricInsertRow[]) => Promise<void>;
  keepAlive?: typeof defaultKeepAlive;
  cached?: typeof defaultCached;
  cacheDeps?: CacheDeps;
};

const domainOverviewCacheSchema = z.object({
  domain: z.string(),
  organicTraffic: z.number().nullable(),
  organicKeywords: z.number().nullable(),
  hasData: z.boolean(),
});

export type DomainOverviewResult = {
  domain: string;
  displayTarget: string;
  scope: ResearchScope;
  organicTraffic: number | null;
  organicKeywords: number | null;
  hasData: boolean;
  cached: boolean;
  fetchedAt: string;
  provenance: { gateway: "dataforseo" };
};

export async function getOverview(
  input: {
    domain: string;
    scope?: ResearchScope;
    locationCode: number;
    languageCode: string;
  },
  deps: DomainServiceDeps,
): Promise<DomainOverviewResult | null> {
  const target = parseResearchTargetOrThrow(input.domain, input.scope);

  const cacheInput = {
    namespace: "domain.overview",
    version: 1,
    keyParts: [target.hostname, input.locationCode, input.languageCode],
    ttlSeconds: DOMAIN_TTL_SECONDS,
    schema: domainOverviewCacheSchema,
    scope: DOMAIN_CACHE_SCOPE,
    brandKey: deps.brandKey,
  };

  if (deps.cacheOnly) {
    const peeked = await peekCached(cacheInput, {
      cached: deps.cached,
      cacheDeps: deps.cacheDeps,
    });
    if (!peeked) return null;
    return {
      domain: target.hostname,
      displayTarget: target.display,
      scope: target.scope,
      organicTraffic: peeked.value.organicTraffic,
      organicKeywords: peeked.value.organicKeywords,
      hasData: peeked.value.hasData,
      cached: true,
      fetchedAt: peeked.fetchedAt,
      provenance: { gateway: "dataforseo" },
    };
  }

  const res = await cachedIf(
    cacheInput,
    async () => {
      const items = await deps.labs.domain.rankOverview(
        {
          brandKey: deps.brandKey,
          feature: "domain.research",
          idempotencyKey: `domain.research:${deps.requestId}:overview`,
          maxUsd: deps.maxUsd,
        },
        {
          target: target.hostname,
          locationCode: input.locationCode,
          languageCode: input.languageCode,
        },
      );
      const metrics = items[0];
      const organicTraffic =
        metrics?.metrics?.organic?.etv != null
          ? Math.round(metrics.metrics.organic.etv)
          : null;
      const organicKeywords =
        metrics?.metrics?.organic?.count != null
          ? Math.round(metrics.metrics.organic.count)
          : null;
      const hasData = organicKeywords != null && organicKeywords > 0;

      return {
        domain: target.hostname,
        organicTraffic,
        organicKeywords,
        hasData,
      };
    },
    (r) => r.hasData,
    { cached: deps.cached, cacheDeps: deps.cacheDeps },
  );

  return {
    domain: target.hostname,
    displayTarget: target.display,
    scope: target.scope,
    organicTraffic: res.value.organicTraffic,
    organicKeywords: res.value.organicKeywords,
    hasData: res.value.hasData,
    cached: res.hit,
    fetchedAt: res.fetchedAt,
    provenance: { gateway: "dataforseo" },
  };
}

const domainKeywordsPageCacheSchema = z.object({
  domain: z.string(),
  page: z.number(),
  pageSize: z.number(),
  totalCount: z.number().nullable(),
  hasMore: z.boolean(),
  keywords: z.array(
    z.object({
      keyword: z.string(),
      position: z.number().nullable(),
      searchVolume: z.number().nullable(),
      traffic: z.number().nullable(),
      cpc: z.number().nullable(),
      url: z.string().nullable(),
      relativeUrl: z.string().nullable(),
      keywordDifficulty: z.number().nullable(),
    }),
  ),
});

export type DomainKeywordsPageResult = z.infer<
  typeof domainKeywordsPageCacheSchema
> & {
  cached: boolean;
  fetchedAt: string;
  provenance: { gateway: "dataforseo" };
};

export async function getKeywordsPage(
  input: {
    domain: string;
    scope?: ResearchScope;
    locationCode: number;
    languageCode: string;
    page: number;
    pageSize: number;
    sortMode: DomainKeywordsSortMode;
    sortOrder: DomainKeywordsSortOrder;
    filters: DomainKeywordsFilters;
    search?: string;
  },
  deps: DomainServiceDeps,
): Promise<DomainKeywordsPageResult | null> {
  const target = parseResearchTargetOrThrow(input.domain, input.scope);
  const scopeFilter = buildRankedKeywordsScopeFilter(target);
  const offset = (input.page - 1) * input.pageSize;
  const orderBy = buildOrderBy(input.sortMode, input.sortOrder);
  const filters = buildKeywordFilters(input.filters, input.search, scopeFilter);

  const cacheInput = {
    namespace: "domain.keywords_page",
    version: 1,
    keyParts: [
      target.hostname,
      target.scope,
      target.path,
      input.locationCode,
      input.languageCode,
      input.page,
      input.pageSize,
      input.sortMode,
      input.sortOrder,
      input.filters,
      input.search ?? null,
    ],
    ttlSeconds: DOMAIN_TTL_SECONDS,
    schema: domainKeywordsPageCacheSchema,
    scope: DOMAIN_CACHE_SCOPE,
    brandKey: deps.brandKey,
  };

  if (deps.cacheOnly) {
    const peeked = await peekCached(cacheInput, {
      cached: deps.cached,
      cacheDeps: deps.cacheDeps,
    });
    if (!peeked) return null;
    return {
      ...peeked.value,
      cached: true,
      fetchedAt: peeked.fetchedAt,
      provenance: { gateway: "dataforseo" },
    };
  }

  const cachedFn = deps.cached ?? defaultCached;
  const res = await cachedFn(
    cacheInput,
    async () => {
      const response = await deps.labs.domain.rankedKeywords(
        {
          brandKey: deps.brandKey,
          feature: "domain.research",
          idempotencyKey: `domain.research:${deps.requestId}:keywords`,
          maxUsd: deps.maxUsd,
        },
        {
          target: target.hostname,
          locationCode: input.locationCode,
          languageCode: input.languageCode,
          limit: input.pageSize,
          offset,
          orderBy,
          filters: filters.length > 0 ? filters : undefined,
        },
      );

      const keywords = response.items
        .map(mapKeywordItem)
        .filter(
          (item): item is NonNullable<ReturnType<typeof mapKeywordItem>> =>
            item != null,
        );

      const totalCount = response.totalCount ?? null;
      const hasMore = computeHasMore(
        offset,
        response.items.length,
        totalCount,
        input.pageSize,
      );

      return {
        domain: target.hostname,
        page: input.page,
        pageSize: input.pageSize,
        totalCount,
        hasMore,
        keywords,
      };
    },
    deps.cacheDeps,
  );

  if (!res.hit && res.value.keywords.length > 0 && deps.upsertMetrics) {
    const metricRows: KeywordMetricInsertRow[] = res.value.keywords.map((k) => ({
      keyword: k.keyword,
      location_code: input.locationCode,
      language_code: input.languageCode,
      search_volume: k.searchVolume ?? null,
      cpc: k.cpc ?? null,
      competition: null,
      keyword_difficulty: k.keywordDifficulty ?? null,
      intent: null,
      monthly_searches: [],
      source: "labs_ranked",
    }));
    const keepAliveFn = deps.keepAlive ?? defaultKeepAlive;
    keepAliveFn(
      deps.upsertMetrics(metricRows).catch((err) => {
        console.error("upsertKeywordMetrics failed:", err);
      }),
    );
  }

  return {
    ...res.value,
    cached: res.hit,
    fetchedAt: res.fetchedAt,
    provenance: { gateway: "dataforseo" },
  };
}

function mapPageItem(item: RelevantPagesItem) {
  const url = item.page_address ?? null;
  if (!url) return null;
  const organic = item.metrics?.organic ?? null;
  const traffic = organic?.etv ?? null;
  const keywords = organic?.count ?? null;
  return {
    page: url,
    relativePath: toRelativePath(url),
    organicTraffic: traffic != null ? Math.round(traffic) : null,
    keywords: keywords != null ? Math.round(keywords) : null,
  };
}

const domainPagesPageCacheSchema = z.object({
  domain: z.string(),
  page: z.number(),
  pageSize: z.number(),
  totalCount: z.number().nullable(),
  hasMore: z.boolean(),
  pages: z.array(
    z.object({
      page: z.string(),
      relativePath: z.string().nullable(),
      organicTraffic: z.number().nullable(),
      keywords: z.number().nullable(),
    }),
  ),
});

export type DomainPagesPageResult = z.infer<typeof domainPagesPageCacheSchema> & {
  cached: boolean;
  fetchedAt: string;
  provenance: { gateway: "dataforseo" };
};

export async function getPagesPage(
  input: {
    domain: string;
    scope?: ResearchScope;
    locationCode: number;
    languageCode: string;
    page: number;
    pageSize: number;
    sortMode: DomainPagesSortMode;
    sortOrder: DomainPagesSortOrder;
    filters: DomainPagesFilters;
    search?: string;
  },
  deps: DomainServiceDeps,
): Promise<DomainPagesPageResult | null> {
  const target = parseResearchTargetOrThrow(input.domain, input.scope);
  const scopeFilter = buildRelevantPagesScopeFilter(target);
  const offset = (input.page - 1) * input.pageSize;
  const orderBy = buildPagesOrderBy(input.sortMode, input.sortOrder);
  const filters = buildPageFilters(input.filters, input.search, scopeFilter);

  const cacheInput = {
    namespace: "domain.pages_page",
    version: 1,
    keyParts: [
      target.hostname,
      target.scope,
      target.path,
      input.locationCode,
      input.languageCode,
      input.page,
      input.pageSize,
      input.sortMode,
      input.sortOrder,
      input.filters,
      input.search ?? null,
    ],
    ttlSeconds: DOMAIN_TTL_SECONDS,
    schema: domainPagesPageCacheSchema,
    scope: DOMAIN_CACHE_SCOPE,
    brandKey: deps.brandKey,
  };

  if (deps.cacheOnly) {
    const peeked = await peekCached(cacheInput, {
      cached: deps.cached,
      cacheDeps: deps.cacheDeps,
    });
    if (!peeked) return null;
    return {
      ...peeked.value,
      cached: true,
      fetchedAt: peeked.fetchedAt,
      provenance: { gateway: "dataforseo" },
    };
  }

  const cachedFn = deps.cached ?? defaultCached;
  const res = await cachedFn(
    cacheInput,
    async () => {
      const response = await deps.labs.domain.relevantPages(
        {
          brandKey: deps.brandKey,
          feature: "domain.research",
          idempotencyKey: `domain.research:${deps.requestId}:pages`,
          maxUsd: deps.maxUsd,
        },
        {
          target: target.hostname,
          locationCode: input.locationCode,
          languageCode: input.languageCode,
          limit: input.pageSize,
          offset,
          orderBy,
          filters: filters.length > 0 ? filters : undefined,
        },
      );

      const pages = response.items
        .map(mapPageItem)
        .filter(
          (item): item is NonNullable<ReturnType<typeof mapPageItem>> =>
            item != null,
        );

      const totalCount = response.totalCount ?? null;
      const hasMore = computeHasMore(
        offset,
        response.items.length,
        totalCount,
        input.pageSize,
      );

      return {
        domain: target.hostname,
        page: input.page,
        pageSize: input.pageSize,
        totalCount,
        hasMore,
        pages,
      };
    },
    deps.cacheDeps,
  );

  return {
    ...res.value,
    cached: res.hit,
    fetchedAt: res.fetchedAt,
    provenance: { gateway: "dataforseo" },
  };
}

export async function getSuggestedKeywords(
  input: {
    domain: string;
    scope?: ResearchScope;
    locationCode: number;
    languageCode: string;
  },
  deps: DomainServiceDeps,
): Promise<
  Array<{
    keyword: string;
    position: number | null;
    searchVolume: number | null;
    traffic: number | null;
    cpc: number | null;
    keywordDifficulty: number | null;
  }>
> {
  const target = parseResearchTargetOrThrow(input.domain, input.scope);
  const scopeFilter = buildRankedKeywordsScopeFilter(target);

  const cacheInput = {
    namespace: "domain.keyword_suggestions",
    version: 1,
    keyParts: [
      target.hostname,
      target.scope,
      target.path,
      input.locationCode,
      input.languageCode,
    ],
    ttlSeconds: DOMAIN_TTL_SECONDS,
    schema: z.array(
      z.object({
        keyword: z.string(),
        position: z.number().nullable(),
        searchVolume: z.number().nullable(),
        traffic: z.number().nullable(),
        cpc: z.number().nullable(),
        keywordDifficulty: z.number().nullable(),
      }),
    ),
    scope: DOMAIN_CACHE_SCOPE,
    brandKey: deps.brandKey,
  };

  const res = await cachedIf(
    cacheInput,
    async () => {
      const response = await deps.labs.domain.rankedKeywords(
        {
          brandKey: deps.brandKey,
          feature: "domain.research",
          idempotencyKey: `domain.research:${deps.requestId}:keyword_suggestions`,
          maxUsd: deps.maxUsd,
        },
        {
          target: target.hostname,
          locationCode: input.locationCode,
          languageCode: input.languageCode,
          limit: 100,
          orderBy: ["ranked_serp_element.serp_item.etv,desc"],
          filters:
            scopeFilter.clauses.length > 0
              ? joinClauses(scopeFilter.clauses, "and")
              : undefined,
        },
      );

      return response.items
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
    },
    (rows) => rows.length > 0,
    { cached: deps.cached, cacheDeps: deps.cacheDeps },
  );

  return res.value;
}
