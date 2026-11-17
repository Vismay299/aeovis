// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/backlinks/useBacklinksPageData.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { defaultScopeForInput } from "@/shared/researchScope";
import { useMemo } from "react";
import { useQuery, type QueryKey } from "@tanstack/react-query";
import { usePriceQuote } from "@/components/app/cost/usePriceQuote";
import { fetchJson, isApiError, withBrand } from "@/shared/query/fetchJson";
import { keys, stableStringify } from "@/shared/query/keys";
import {
  BACKLINKS_DEFAULT_SORT,
  backlinksFilterBudgetError,
  backlinksRowsSortFieldSchema,
  referringDomainsSortFieldSchema,
  toBacklinksFiltersPayload,
  toReferringDomainsFiltersPayload,
  toTopPagesFiltersPayload,
  topPagesSortFieldSchema,
  type BacklinksOverview,
  type BacklinksRow,
  type BacklinksRowsSortField,
  type BacklinksSortOrder,
  type BacklinksTargetScope,
  type ReferringDomainRow,
  type ReferringDomainsSortField,
  type TopPageRow,
  type TopPagesSortField,
} from "@/shared/backlinks";
import type { BacklinksFiltersState } from "./useBacklinksFilters";

/**
 * The scope a lookup uses. The URL omits the scope when it equals the
 * input's default (toScopeSearchParam), so read it back the same way: a
 * subfolder URL defaults to "subfolder", not "subdomains".
 */
export function resolveBacklinksScope(target: string | undefined, scope: BacklinksTargetScope | undefined): BacklinksTargetScope {
  if (scope) return scope;
  return target?.trim() ? defaultScopeForInput(target.trim()) : "subdomains";
}

const BACKLINKS_QUERY_STALE_TIME_MS = 5 * 60 * 1000;

/**
 * A live query is a billed provider call and every execution sends a fresh
 * requestId, so an automatic retry or refetch would buy it again. Only an
 * explicit customer action re-runs one (F13 paid-call rules).
 */
export function paidQueryOptions(isLive: boolean) {
  return isLive
    ? { retry: false as const, refetchOnWindowFocus: false, refetchOnReconnect: false }
    : {};
}

export type BacklinksSearchState = {
  target?: string;
  scope?: BacklinksTargetScope;
  tab?: "backlinks" | "domains" | "pages";
  page?: number;
  size?: number;
  sort?: string;
  order?: BacklinksSortOrder;
  view?: "all";
  includeSpam?: boolean;
};

type OverviewApiResponse =
  | BacklinksOverview
  | {
      status: "not_cached";
      target: string;
      displayTarget: string;
      scope: BacklinksTargetScope;
    };

type RowsApiResponse = {
  status: string;
  rows: BacklinksRow[];
  totalCount: number;
  hasMore: boolean;
  page: number;
  pageSize: number;
  cached: boolean;
  fetchedAt: string;
};

type ReferringDomainsApiResponse = {
  status: string;
  rows: ReferringDomainRow[];
  totalCount: number;
  hasMore: boolean;
  page: number;
  pageSize: number;
  cached: boolean;
  fetchedAt: string;
};

type TopPagesApiResponse = {
  status: string;
  rows: TopPageRow[];
  totalCount: number;
  hasMore: boolean;
  page: number;
  pageSize: number;
  cached: boolean;
  fetchedAt: string;
};

function getBacklinksErrorMessage(
  error: unknown,
  fallback: string,
): string | null {
  if (!error) return null;
  if (isApiError(error)) {
    if (error.code === "invalid_target" || error.code === "validation_error") {
      return "Enter a valid domain or page URL.";
    }
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return fallback;
}

function toSort<T extends string>(
  sortParam: string | undefined,
  orderParam: BacklinksSortOrder | undefined,
  allowedFields: readonly T[],
  fallback: { field: T; order: BacklinksSortOrder },
): { field: T; order: BacklinksSortOrder } {
  const field = sortParam
    ? allowedFields.find((candidate) => candidate === sortParam)
    : undefined;
  if (!field) return fallback;
  return { field, order: orderParam ?? "desc" };
}

export function useBacklinksPageData({
  brandKey,
  searchState,
  filters,
  isLive,
  lookupMaxUsd,
}: {
  brandKey: string;
  searchState: BacklinksSearchState;
  filters: BacklinksFiltersState;
  isLive: boolean;
  /** The approved lookup ceiling; a live overview is never sent without it. */
  lookupMaxUsd?: number;
}) {
  const target = searchState.target?.trim() || "";
  const scope: BacklinksTargetScope = resolveBacklinksScope(target, searchState.scope);
  const tab = searchState.tab ?? "backlinks";
  const page = searchState.page ?? 1;
  const pageSize = searchState.size ?? 50;
  const { sort, order, view, includeSpam } = searchState;
  const rowsMode = view === "all" ? "as_is" : "one_per_domain";
  const targetReady = Boolean(target && brandKey);

  const baseQueryKeyParts = [brandKey, scope, target] as const;
  const keepSameTarget = <T>(
    previous: T | undefined,
    previousQuery: { queryKey: QueryKey } | undefined,
  ) =>
    baseQueryKeyParts.every(
      (part, index) => previousQuery?.queryKey[index + 1] === part,
    )
      ? previous
      : undefined;

  // Tab pages are priced as backlinks.page {tab, pageSize}; in live mode each
  // request carries this quote as its ceiling, and waits for it.
  const pageQuote = usePriceQuote(
    { brandKey, action: "backlinks.page", input: { tab, pageSize } },
    { enabled: isLive && targetReady },
  );
  const pageMaxUsd = pageQuote.isPlaceholderData ? undefined : pageQuote.data?.totalUsd;
  const liveReady = (maxUsd: number | undefined) => !isLive || maxUsd !== undefined;
  const liveBody = (maxUsd: number | undefined) =>
    isLive && maxUsd !== undefined ? { maxUsd } : {};

  const overviewInputKey = stableStringify({
    target,
    scope,
    cacheOnly: !isLive,
  });

  const overviewQuery = useQuery({
    queryKey: keys.backlinksOverview(brandKey, overviewInputKey),
    enabled: targetReady && liveReady(lookupMaxUsd),
    staleTime: BACKLINKS_QUERY_STALE_TIME_MS,
    ...paidQueryOptions(isLive),
    queryFn: () =>
      fetchJson<OverviewApiResponse>(withBrand("/api/customer/backlinks/overview", brandKey), {
        method: "POST",
        body: {
          target,
          scope,
          tab,
          pageSize,
          cacheOnly: !isLive,
          ...liveBody(lookupMaxUsd),
          requestId: crypto.randomUUID(),
        },
      }),
  });

  const isNotCached =
    overviewQuery.data?.status === "not_cached";

  const overviewData: BacklinksOverview | null =
    overviewQuery.data?.status === "ok" ? overviewQuery.data : null;

  const rowsSort = toSort<BacklinksRowsSortField>(
    sort,
    order,
    backlinksRowsSortFieldSchema.options,
    BACKLINKS_DEFAULT_SORT.backlinks,
  );
  const rowsFilters = useMemo(
    () => toBacklinksFiltersPayload(filters.backlinks.values),
    [filters.backlinks.values],
  );
  const rowsFilterError = backlinksFilterBudgetError(
    filters.backlinks.values,
    scope,
    !includeSpam,
  );

  const rowsInputKey = stableStringify({
    target,
    scope,
    page,
    pageSize,
    sortField: rowsSort.field,
    sortOrder: rowsSort.order,
    filters: rowsFilters,
    mode: rowsMode,
    hideSpam: !includeSpam,
    cacheOnly: !isLive,
  });

  const rowsQuery = useQuery({
    queryKey: keys.backlinksTab(brandKey, "backlinks", rowsInputKey),
    enabled:
      targetReady &&
      tab === "backlinks" &&
      !rowsFilterError &&
      !isNotCached &&
      (isLive || overviewData != null) &&
      liveReady(pageMaxUsd),
    ...paidQueryOptions(isLive),
    staleTime: BACKLINKS_QUERY_STALE_TIME_MS,
    placeholderData: rowsFilterError ? undefined : keepSameTarget,
    queryFn: () =>
      fetchJson<RowsApiResponse>(withBrand("/api/customer/backlinks/rows", brandKey), {
        method: "POST",
        body: {
          target,
          scope,
          page,
          pageSize,
          sortField: rowsSort.field,
          sortOrder: rowsSort.order,
          filters: rowsFilters,
          mode: rowsMode,
          hideSpam: !includeSpam,
          cacheOnly: !isLive,
          ...liveBody(pageMaxUsd),
          requestId: crypto.randomUUID(),
        },
      }),
  });

  const domainsSort = toSort<ReferringDomainsSortField>(
    sort,
    order,
    referringDomainsSortFieldSchema.options,
    BACKLINKS_DEFAULT_SORT.domains,
  );
  const domainsFilters = useMemo(
    () => toReferringDomainsFiltersPayload(filters.domains.values),
    [filters.domains.values],
  );

  const domainsInputKey = stableStringify({
    target,
    scope,
    page,
    pageSize,
    sortField: domainsSort.field,
    sortOrder: domainsSort.order,
    filters: domainsFilters,
    cacheOnly: !isLive,
  });

  const referringDomainsQuery = useQuery({
    queryKey: keys.backlinksTab(brandKey, "domains", domainsInputKey),
    enabled:
      targetReady &&
      tab === "domains" &&
      scope !== "subfolder" &&
      !isNotCached &&
      (isLive || overviewData != null) &&
      liveReady(pageMaxUsd),
    ...paidQueryOptions(isLive),
    staleTime: BACKLINKS_QUERY_STALE_TIME_MS,
    placeholderData: keepSameTarget,
    queryFn: () =>
      fetchJson<ReferringDomainsApiResponse>(
        withBrand("/api/customer/backlinks/referring-domains", brandKey),
        {
          method: "POST",
          body: {
            target,
            scope,
            page,
            pageSize,
            sortField: domainsSort.field,
            sortOrder: domainsSort.order,
            filters: domainsFilters,
            cacheOnly: !isLive,
            ...liveBody(pageMaxUsd),
            requestId: crypto.randomUUID(),
          },
        },
      ),
  });

  const pagesSort = toSort<TopPagesSortField>(
    sort,
    order,
    topPagesSortFieldSchema.options,
    BACKLINKS_DEFAULT_SORT.pages,
  );
  const pagesFilters = useMemo(
    () => toTopPagesFiltersPayload(filters.pages.values),
    [filters.pages.values],
  );

  const pagesInputKey = stableStringify({
    target,
    scope,
    page,
    pageSize,
    sortField: pagesSort.field,
    sortOrder: pagesSort.order,
    filters: pagesFilters,
    cacheOnly: !isLive,
  });

  const topPagesQuery = useQuery({
    queryKey: keys.backlinksTab(brandKey, "pages", pagesInputKey),
    enabled:
      targetReady &&
      tab === "pages" &&
      !isNotCached &&
      (isLive || overviewData != null) &&
      liveReady(pageMaxUsd),
    ...paidQueryOptions(isLive),
    staleTime: BACKLINKS_QUERY_STALE_TIME_MS,
    placeholderData: keepSameTarget,
    queryFn: () =>
      fetchJson<TopPagesApiResponse>(
        withBrand("/api/customer/backlinks/top-pages", brandKey),
        {
          method: "POST",
          body: {
            target,
            scope,
            page,
            pageSize,
            sortField: pagesSort.field,
            sortOrder: pagesSort.order,
            filters: pagesFilters,
            cacheOnly: !isLive,
            ...liveBody(pageMaxUsd),
            requestId: crypto.randomUUID(),
          },
        },
      ),
  });

  const overviewErrorMessage = getBacklinksErrorMessage(
    overviewQuery.error,
    "Could not load backlinks.",
  );

  const activeTabQuery =
    tab === "backlinks"
      ? rowsQuery
      : tab === "domains"
        ? referringDomainsQuery
        : topPagesQuery;

  const activeTabFilterError = tab === "backlinks" ? rowsFilterError : null;
  const activeTabErrorMessage =
    activeTabFilterError ??
    getBacklinksErrorMessage(activeTabQuery.error, "Could not load this tab.");

  return {
    overviewQuery,
    overviewData,
    isNotCached,
    overviewErrorMessage,
    rowsQuery,
    referringDomainsQuery,
    topPagesQuery,
    activeTabQuery,
    activeTabFilterError,
    activeTabErrorMessage,
  };
}

export type BacklinksPageData = ReturnType<typeof useBacklinksPageData>;
