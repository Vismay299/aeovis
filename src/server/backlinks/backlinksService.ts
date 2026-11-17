// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/backlinks/services/BacklinksService.ts, backlinksServiceData.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { cached as defaultCached, type CacheDeps } from "../cache/providerCache.ts";
import { cachedIf, peekCached } from "../research/cache.ts";
import {
  type BacklinksClient,
  type BacklinksHistoryItem,
  type BacklinksSummaryItem,
} from "../../shared/providers/dataforseo/backlinks.ts";
import { normalizeBacklinksTarget } from "../../shared/providers/dataforseo/backlinksTarget.ts";
import type {
  BacklinksRowsFilters,
  BacklinksRowsSortField,
  BacklinksSortOrder,
  ReferringDomainsFilters,
  ReferringDomainsSortField,
  TopPagesFilters,
  TopPagesSortField,
} from "../../shared/backlinks.ts";
import {
  BACKLINKS_DEFAULT_PAGE_SIZE,
  BACKLINKS_DEFAULT_SORT,
} from "../../shared/backlinks.ts";
import {
  backlinksOverviewSchema,
  backlinksRowsPageResultSchema,
  referringDomainsPageResultSchema,
  topPagesPageResultSchema,
  type BacklinksOverviewResult,
  type BacklinksRowsPageResult,
  type ReferringDomainsPageResult,
  type TopPagesPageResult,
} from "./backlinksOverviewSchema.ts";
import {
  buildBacklinksRowsApiFilters,
  buildBacklinksRowsOrderBy,
  buildReferringDomainsApiFilters,
  buildReferringDomainsOrderBy,
  buildTopPagesApiFilters,
  buildTopPagesOrderBy,
} from "./backlinksApiFilters.ts";
import {
  buildBacklinksScopeFilter,
  prependScopeClauses,
} from "../../shared/providers/dataforseo/researchScopeFilters.ts";
import { buildSubfolderOverview } from "./backlinksSubfolderOverview.ts";
import {
  buildPageResult,
  mapBacklinksRows,
  mapReferringDomainsRows,
  mapTopPagesRows,
  normalizeHistoryDate,
} from "./backlinksRowMappers.ts";
import { assertFilterConditionBudget } from "../../shared/providers/dataforseo/filters.ts";
import { toResearchError } from "../research/providerErrors.ts";
import { AppError } from "../../shared/http/appError.ts";
import type { ResearchScope } from "../../shared/researchScope.ts";
import type { SpendFeature } from "../../shared/spend-features.ts";

export const BACKLINKS_CACHE_SCOPE = "workspace" as const;
export const BACKLINKS_TTL_SECONDS = 6 * 60 * 60; // 21600 seconds (6 hours)

export const BACKLINKS_CACHE = {
  overview: { namespace: "backlinks.overview", version: 2 },
  rows: { namespace: "backlinks.rows_page", version: 2 },
  domains: { namespace: "backlinks.referring_domains_page", version: 1 },
  pages: { namespace: "backlinks.top_pages_page", version: 1 },
} as const;

export type BacklinksServiceDeps = {
  client: BacklinksClient;
  brandKey: string;
  requestId: string;
  maxUsd?: number;
  cacheOnly?: boolean;
  onFetchedSummary?: (overview: BacklinksOverviewResult) => Promise<void>;
  now?: () => Date;
  cached?: typeof defaultCached;
  cacheDeps?: CacheDeps;
};

export function countExpressionConditions(expressions: unknown[]): number {
  let count = 0;
  for (const expression of expressions) {
    if (expression === "and" || expression === "or") continue;
    count +=
      Array.isArray(expression) && Array.isArray(expression[0])
        ? Math.ceil(expression.length / 2)
        : 1;
  }
  return count;
}

export type BacklinksOverviewServiceResult = {
  overview: BacklinksOverviewResult;
  cached: boolean;
  fetchedAt: string;
};

export type BacklinksRowsPageServiceResult = BacklinksRowsPageResult & {
  cached: boolean;
  provenance: { gateway: "dataforseo" };
};

export type ReferringDomainsPageServiceResult = ReferringDomainsPageResult & {
  cached: boolean;
  provenance: { gateway: "dataforseo" };
};

export type TopPagesPageServiceResult = TopPagesPageResult & {
  cached: boolean;
  provenance: { gateway: "dataforseo" };
};

export async function profileOverview(
  input: { target: string; scope?: ResearchScope },
  deps: BacklinksServiceDeps,
): Promise<BacklinksOverviewServiceResult | null> {
  const cachedFn = deps.cached ?? defaultCached;
  const now = deps.now ? deps.now() : new Date();
  const normalizedTarget = normalizeBacklinksTarget(input.target, {
    scope: input.scope,
  });

  const cacheInput = {
    namespace: BACKLINKS_CACHE.overview.namespace,
    version: BACKLINKS_CACHE.overview.version,
    keyParts: [
      normalizedTarget.apiTarget,
      normalizedTarget.scope,
      normalizedTarget.path,
      normalizedTarget.includeSubdomains,
    ],
    ttlSeconds: BACKLINKS_TTL_SECONDS,
    schema: backlinksOverviewSchema,
    scope: BACKLINKS_CACHE_SCOPE,
    brandKey: deps.brandKey,
  };

  if (deps.cacheOnly) {
    const peeked = await peekCached(cacheInput, {
      cached: cachedFn,
      cacheDeps: deps.cacheDeps,
    });
    if (!peeked) return null;
    return {
      overview: peeked.value,
      cached: true,
      fetchedAt: peeked.fetchedAt,
    };
  }

  try {
    const res = await cachedFn(
      cacheInput,
      async () => {
        if (normalizedTarget.scope === "subfolder") {
          const overview = await buildSubfolderOverview(
            deps.client,
            normalizedTarget as typeof normalizedTarget & { scope: "subfolder" },
            now,
            {
              brandKey: deps.brandKey,
              requestId: deps.requestId,
              maxUsd: deps.maxUsd,
              feature: "backlinks.research" as SpendFeature,
            },
          );
          if (deps.onFetchedSummary) {
            await deps.onFetchedSummary(overview);
          }
          return overview;
        }

        const dateRange = buildBacklinksDateRange(now);

        const [summaryRes, historyRes] = await Promise.all([
          deps.client.summary(
            {
              brandKey: deps.brandKey,
              feature: "backlinks.research" as SpendFeature,
              idempotencyKey: `backlinks.research:${deps.requestId}:summary`,
              maxUsd: deps.maxUsd,
            },
            {
              target: normalizedTarget.apiTarget,
              includeSubdomains: normalizedTarget.includeSubdomains,
            },
          ),
          normalizedTarget.scope === "exact_url"
            ? Promise.resolve({ data: [] as BacklinksHistoryItem[] })
            : deps.client.history(
                {
                  brandKey: deps.brandKey,
                  feature: "backlinks.research" as SpendFeature,
                  idempotencyKey: `backlinks.research:${deps.requestId}:history`,
                  maxUsd: deps.maxUsd,
                },
                {
                  target: normalizedTarget.apiTarget,
                  ...dateRange,
                },
              ),
        ]);

        const summaryData =
          (summaryRes as { data?: BacklinksSummaryItem })?.data ??
          (summaryRes as unknown as BacklinksSummaryItem);
        const historyData =
          (historyRes as { data?: BacklinksHistoryItem[] })?.data ??
          (historyRes as unknown as BacklinksHistoryItem[]) ??
          [];

        const overview = buildOverviewResult({
          normalizedTarget,
          now,
          summary: summaryData,
          history: Array.isArray(historyData) ? historyData : [],
        });

        if (deps.onFetchedSummary) {
          await deps.onFetchedSummary(overview);
        }

        return overview;
      },
      deps.cacheDeps,
    );

    return {
      overview: res.value,
      cached: res.hit,
      fetchedAt: res.fetchedAt,
    };
  } catch (err) {
    throw toResearchError(err, {
      unavailableCode: "backlinks_unavailable",
      unavailableMessage: "Backlink data is unavailable right now. Please retry.",
    });
  }
}

export type ProfileBacklinksRowsInput = {
  target: string;
  scope?: ResearchScope;
  page?: number;
  pageSize?: number;
  sortField?: BacklinksRowsSortField;
  sortOrder?: BacklinksSortOrder;
  filters?: BacklinksRowsFilters;
  mode?: "one_per_domain" | "as_is";
};

export async function profileBacklinksPage(
  input: ProfileBacklinksRowsInput,
  deps: BacklinksServiceDeps,
  options?: { hideSpam?: boolean },
): Promise<BacklinksRowsPageServiceResult | null> {
  const cachedFn = deps.cached ?? defaultCached;
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? BACKLINKS_DEFAULT_PAGE_SIZE;
  const sortField = input.sortField ?? BACKLINKS_DEFAULT_SORT.backlinks.field;
  const sortOrder = input.sortOrder ?? BACKLINKS_DEFAULT_SORT.backlinks.order;
  const mode = input.mode ?? "one_per_domain";
  const hideSpam = options?.hideSpam ?? true;
  const offset = (page - 1) * pageSize;

  const target = normalizeBacklinksTarget(input.target, { scope: input.scope });
  const scopeFilter = buildBacklinksScopeFilter("url_to", target);
  const userFilters = buildBacklinksRowsApiFilters(input.filters ?? {});

  assertFilterConditionBudget(
    scopeFilter.conditionCount +
      countExpressionConditions(userFilters) +
      (hideSpam ? 2 : 0),
  );

  const cacheInput = {
    namespace: BACKLINKS_CACHE.rows.namespace,
    version: BACKLINKS_CACHE.rows.version,
    keyParts: [
      target.apiTarget,
      target.scope,
      target.path,
      target.includeSubdomains,
      page,
      pageSize,
      sortField,
      sortOrder,
      input.filters ?? {},
      mode,
      String(hideSpam),
    ],
    ttlSeconds: BACKLINKS_TTL_SECONDS,
    schema: backlinksRowsPageResultSchema,
    scope: BACKLINKS_CACHE_SCOPE,
    brandKey: deps.brandKey,
  };

  if (deps.cacheOnly) {
    const peeked = await peekCached(cacheInput, {
      cached: cachedFn,
      cacheDeps: deps.cacheDeps,
    });
    if (!peeked) return null;
    return {
      ...peeked.value,
      cached: true,
      provenance: { gateway: "dataforseo" },
    };
  }

  const filters = prependScopeClauses(scopeFilter, userFilters);

  try {
    const res = await cachedFn(
      cacheInput,
      async () => {
        const response = await deps.client.rows(
          {
            brandKey: deps.brandKey,
            feature: "backlinks.research" as SpendFeature,
            idempotencyKey: `backlinks.research:${deps.requestId}:rows`,
            maxUsd: deps.maxUsd,
          },
          {
            target: target.apiTarget,
            includeSubdomains: target.includeSubdomains,
            limit: pageSize,
            offset,
            orderBy: buildBacklinksRowsOrderBy(sortField, sortOrder),
            filters: filters.length > 0 ? filters : undefined,
            mode,
            hideSpam,
          },
        );

        const items =
          (response as { data?: { items?: unknown[] } })?.data?.items ??
          (response as { items?: unknown[] })?.items ??
          [];
        const totalCount =
          (response as { data?: { totalCount?: number | null } })?.data
            ?.totalCount ??
          (response as { totalCount?: number | null })?.totalCount ??
          null;

        return buildPageResult(
          { page, pageSize },
          offset,
          {
            rows: mapBacklinksRows(items as any),
            totalCount,
          },
        );
      },
      deps.cacheDeps,
    );

    return {
      ...res.value,
      cached: res.hit,
      provenance: { gateway: "dataforseo" },
    };
  } catch (err) {
    throw toResearchError(err, {
      unavailableCode: "backlinks_unavailable",
      unavailableMessage: "Backlink data is unavailable right now. Please retry.",
    });
  }
}

export type ProfileReferringDomainsInput = {
  target: string;
  scope?: ResearchScope;
  page?: number;
  pageSize?: number;
  sortField?: ReferringDomainsSortField;
  sortOrder?: BacklinksSortOrder;
  filters?: ReferringDomainsFilters;
};

export async function profileReferringDomainsPage(
  input: ProfileReferringDomainsInput,
  deps: BacklinksServiceDeps,
): Promise<ReferringDomainsPageServiceResult | null> {
  const cachedFn = deps.cached ?? defaultCached;
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? BACKLINKS_DEFAULT_PAGE_SIZE;
  const sortField = input.sortField ?? BACKLINKS_DEFAULT_SORT.domains.field;
  const sortOrder = input.sortOrder ?? BACKLINKS_DEFAULT_SORT.domains.order;
  const offset = (page - 1) * pageSize;

  const target = normalizeBacklinksTarget(input.target, { scope: input.scope });
  if (target.scope === "subfolder") {
    throw new AppError(
      400,
      "subfolder_not_supported",
      "Referring domains can't be broken down for a subfolder — use the Backlinks tab, or switch to Domain or Subdomains scope.",
    );
  }

  const userFilters = buildReferringDomainsApiFilters(input.filters ?? {});
  assertFilterConditionBudget(countExpressionConditions(userFilters));

  const cacheInput = {
    namespace: BACKLINKS_CACHE.domains.namespace,
    version: BACKLINKS_CACHE.domains.version,
    keyParts: [
      target.apiTarget,
      target.scope,
      target.path,
      target.includeSubdomains,
      page,
      pageSize,
      sortField,
      sortOrder,
      input.filters ?? {},
      "false",
    ],
    ttlSeconds: BACKLINKS_TTL_SECONDS,
    schema: referringDomainsPageResultSchema,
    scope: BACKLINKS_CACHE_SCOPE,
    brandKey: deps.brandKey,
  };

  if (deps.cacheOnly) {
    const peeked = await peekCached(cacheInput, {
      cached: cachedFn,
      cacheDeps: deps.cacheDeps,
    });
    if (!peeked) return null;
    return {
      ...peeked.value,
      cached: true,
      provenance: { gateway: "dataforseo" },
    };
  }

  try {
    const res = await cachedFn(
      cacheInput,
      async () => {
        const response = await deps.client.referringDomains(
          {
            brandKey: deps.brandKey,
            feature: "backlinks.research" as SpendFeature,
            idempotencyKey: `backlinks.research:${deps.requestId}:domains`,
            maxUsd: deps.maxUsd,
          },
          {
            target: target.apiTarget,
            includeSubdomains: target.includeSubdomains,
            limit: pageSize,
            offset,
            orderBy: buildReferringDomainsOrderBy(sortField, sortOrder),
            filters: userFilters.length > 0 ? userFilters : undefined,
            hideSpam: false,
          },
        );

        const items =
          (response as { data?: { items?: unknown[] } })?.data?.items ??
          (response as { items?: unknown[] })?.items ??
          [];
        const totalCount =
          (response as { data?: { totalCount?: number | null } })?.data
            ?.totalCount ??
          (response as { totalCount?: number | null })?.totalCount ??
          null;

        return buildPageResult(
          { page, pageSize },
          offset,
          {
            rows: mapReferringDomainsRows(items as any),
            totalCount,
          },
        );
      },
      deps.cacheDeps,
    );

    return {
      ...res.value,
      cached: res.hit,
      provenance: { gateway: "dataforseo" },
    };
  } catch (err) {
    throw toResearchError(err, {
      unavailableCode: "backlinks_unavailable",
      unavailableMessage: "Backlink data is unavailable right now. Please retry.",
    });
  }
}

export type ProfileTopPagesInput = {
  target: string;
  scope?: ResearchScope;
  page?: number;
  pageSize?: number;
  sortField?: TopPagesSortField;
  sortOrder?: BacklinksSortOrder;
  filters?: TopPagesFilters;
};

export async function profileTopPagesPage(
  input: ProfileTopPagesInput,
  deps: BacklinksServiceDeps,
): Promise<TopPagesPageServiceResult | null> {
  const cachedFn = deps.cached ?? defaultCached;
  const page = input.page ?? 1;
  const pageSize = input.pageSize ?? BACKLINKS_DEFAULT_PAGE_SIZE;
  const sortField = input.sortField ?? BACKLINKS_DEFAULT_SORT.pages.field;
  const sortOrder = input.sortOrder ?? BACKLINKS_DEFAULT_SORT.pages.order;
  const offset = (page - 1) * pageSize;

  const target = normalizeBacklinksTarget(input.target, { scope: input.scope });
  const scopeFilter = buildBacklinksScopeFilter("url", target);
  const userFilters = buildTopPagesApiFilters(input.filters ?? {});

  assertFilterConditionBudget(
    scopeFilter.conditionCount + countExpressionConditions(userFilters),
  );

  const cacheInput = {
    namespace: BACKLINKS_CACHE.pages.namespace,
    version: BACKLINKS_CACHE.pages.version,
    keyParts: [
      target.apiTarget,
      target.scope,
      target.path,
      target.includeSubdomains,
      page,
      pageSize,
      sortField,
      sortOrder,
      input.filters ?? {},
    ],
    ttlSeconds: BACKLINKS_TTL_SECONDS,
    schema: topPagesPageResultSchema,
    scope: BACKLINKS_CACHE_SCOPE,
    brandKey: deps.brandKey,
  };

  if (deps.cacheOnly) {
    const peeked = await peekCached(cacheInput, {
      cached: cachedFn,
      cacheDeps: deps.cacheDeps,
    });
    if (!peeked) return null;
    return {
      ...peeked.value,
      cached: true,
      provenance: { gateway: "dataforseo" },
    };
  }

  const filters = prependScopeClauses(scopeFilter, userFilters);

  try {
    const res = await cachedFn(
      cacheInput,
      async () => {
        const response = await deps.client.domainPages(
          {
            brandKey: deps.brandKey,
            feature: "backlinks.research" as SpendFeature,
            idempotencyKey: `backlinks.research:${deps.requestId}:pages`,
            maxUsd: deps.maxUsd,
          },
          {
            target: target.apiTarget,
            includeSubdomains: target.includeSubdomains,
            limit: pageSize,
            offset,
            orderBy: buildTopPagesOrderBy(sortField, sortOrder),
            filters: filters.length > 0 ? filters : undefined,
          },
        );

        const items =
          (response as { data?: { items?: unknown[] } })?.data?.items ??
          (response as { items?: unknown[] })?.items ??
          [];
        const totalCount =
          (response as { data?: { totalCount?: number | null } })?.data
            ?.totalCount ??
          (response as { totalCount?: number | null })?.totalCount ??
          null;

        return buildPageResult(
          { page, pageSize },
          offset,
          {
            rows: mapTopPagesRows(items as any),
            totalCount,
          },
        );
      },
      deps.cacheDeps,
    );

    return {
      ...res.value,
      cached: res.hit,
      provenance: { gateway: "dataforseo" },
    };
  } catch (err) {
    throw toResearchError(err, {
      unavailableCode: "backlinks_unavailable",
      unavailableMessage: "Backlink data is unavailable right now. Please retry.",
    });
  }
}

export function buildBacklinksDateRange(now: Date): {
  dateFrom: string;
  dateTo: string;
} {
  const todayUtc = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const dateToUtc = new Date(todayUtc);
  dateToUtc.setUTCDate(dateToUtc.getUTCDate() - 1);

  const dateFromUtc = new Date(dateToUtc);
  dateFromUtc.setUTCFullYear(dateFromUtc.getUTCFullYear() - 1);

  return {
    dateFrom: dateFromUtc.toISOString().slice(0, 10),
    dateTo: dateToUtc.toISOString().slice(0, 10),
  };
}

function buildOverviewResult(args: {
  normalizedTarget: ReturnType<typeof normalizeBacklinksTarget>;
  now: Date;
  summary: BacklinksSummaryItem;
  history: BacklinksHistoryItem[];
}): BacklinksOverviewResult {
  const historyRows = args.history
    .map((item) => ({
      date: normalizeHistoryDate(item.date),
      backlinks: item.backlinks ?? null,
      referringDomains: item.referring_domains ?? null,
      rank: item.rank ?? null,
      newBacklinks: item.new_backlinks ?? null,
      lostBacklinks: item.lost_backlinks ?? null,
      newReferringDomains:
        item.new_referring_domains ?? item.new_reffering_domains ?? null,
      lostReferringDomains:
        item.lost_referring_domains ?? item.lost_reffering_domains ?? null,
    }))
    .filter(
      (
        item,
      ): item is typeof item & {
        date: string;
      } => item.date !== null,
    );

  return {
    target: args.normalizedTarget.apiTarget,
    displayTarget: args.normalizedTarget.displayTarget,
    scope: args.normalizedTarget.scope,
    summary: {
      rank: args.summary.rank ?? null,
      backlinks: args.summary.backlinks ?? null,
      referringPages: args.summary.referring_pages ?? null,
      referringDomains: args.summary.referring_domains ?? null,
      brokenBacklinks: args.summary.broken_backlinks ?? null,
      brokenPages: args.summary.broken_pages ?? null,
      backlinksSpamScore: args.summary.backlinks_spam_score ?? null,
      targetSpamScore: args.summary.info?.target_spam_score ?? null,
      newBacklinks: args.summary.new_backlinks ?? null,
      lostBacklinks: args.summary.lost_backlinks ?? null,
      newReferringDomains:
        args.summary.new_referring_domains ??
        args.summary.new_reffering_domains ??
        null,
      lostReferringDomains:
        args.summary.lost_referring_domains ??
        args.summary.lost_reffering_domains ??
        null,
    },
    trends: historyRows.map((item) => ({
      date: item.date,
      backlinks: item.backlinks,
      referringDomains: item.referringDomains,
      rank: item.rank,
    })),
    newLostTrends: historyRows.map((item) => ({
      date: item.date,
      newBacklinks: item.newBacklinks,
      lostBacklinks: item.lostBacklinks,
      newReferringDomains: item.newReferringDomains,
      lostReferringDomains: item.lostReferringDomains,
    })),
    fetchedAt: args.now.toISOString(),
  };
}
