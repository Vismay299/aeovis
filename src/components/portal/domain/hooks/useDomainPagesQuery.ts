"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/hooks/useDomainPagesQuery.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useQuery } from "@tanstack/react-query";
import { keys, stableStringify } from "@/lib/query/keys";
import { fetchJson } from "@/lib/query/fetchJson";
import { toPageSortMode } from "@/shared/domain";
import type { ResearchScope } from "@/shared/researchScope";
import type {
  DomainSortMode,
  PagesFilterValues,
  SortOrder,
} from "@/shared/domain";

export type DomainPageItem = {
  page: string;
  relativePath: string | null;
  organicTraffic: number;
  keywords: number;
};

export type DomainPagesResponse = {
  status: "ok";
  domain: string;
  page: number;
  pageSize: number;
  totalCount: number;
  hasMore: boolean;
  pages: DomainPageItem[];
  cached: boolean;
  fetchedAt: string;
  provenance: { gateway: string };
};

type Input = {
  brandKey: string;
  domain: string;
  scope: ResearchScope;
  locationCode?: number;
  languageCode?: string;
  page: number;
  pageSize: number;
  sortMode: DomainSortMode;
  sortOrder: SortOrder;
  appliedFilters: PagesFilterValues;
  search?: string;
  cacheOnly?: boolean;
  maxUsd?: number;
  enabled?: boolean;
};

function toNumberOrUndefined(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toPageFiltersPayload(filters: PagesFilterValues): Record<string, unknown> {
  return {
    include: filters.include || undefined,
    exclude: filters.exclude || undefined,
    minTraffic: toNumberOrUndefined(filters.minTraffic),
    maxTraffic: toNumberOrUndefined(filters.maxTraffic),
    minVol: toNumberOrUndefined(filters.minVol),
    maxVol: toNumberOrUndefined(filters.maxVol),
  };
}

export function useDomainPagesQuery(input: Input) {
  const trimmedDomain = input.domain.trim();
  const pageSortMode = toPageSortMode(input.sortMode);
  const filtersPayload = toPageFiltersPayload(input.appliedFilters);
  const cacheOnly = input.cacheOnly ?? false;

  const inputKey = stableStringify({
    domain: trimmedDomain,
    scope: input.scope,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    page: input.page,
    pageSize: input.pageSize,
    sortMode: pageSortMode,
    sortOrder: input.sortOrder,
    filters: filtersPayload,
    search: input.search || undefined,
    cacheOnly,
    maxUsd: input.maxUsd,
  });

  return useQuery({
    enabled: Boolean(input.enabled !== false && input.brandKey && trimmedDomain !== ""),
    queryKey: keys.domainPages(input.brandKey, inputKey),
    queryFn: async () => {
      const requestId = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : "00000000-0000-0000-0000-000000000000";

      return fetchJson<DomainPagesResponse>(
        `/api/customer/domain/pages?brand_key=${encodeURIComponent(input.brandKey)}`,
        {
          method: "POST",
          body: {
            domain: trimmedDomain,
            scope: input.scope,
            locationCode: input.locationCode,
            languageCode: input.languageCode,
            page: input.page,
            pageSize: input.pageSize,
            sortMode: pageSortMode,
            sortOrder: input.sortOrder,
            filters: filtersPayload,
            search: input.search || undefined,
            cacheOnly,
            maxUsd: input.maxUsd,
            requestId,
          },
        },
      );
    },
    staleTime: 60_000,
    retry: false,
  });
}
