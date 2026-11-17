"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/hooks/useDomainKeywordsQuery.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useQuery } from "@tanstack/react-query";
import { keys, stableStringify } from "@/shared/query/keys";
import { fetchJson } from "@/shared/query/fetchJson";
import type { ResearchScope } from "@/shared/researchScope";
import type {
  DomainFilterValues,
  DomainSortMode,
  SortOrder,
} from "@/shared/domain";

export type DomainKeywordItem = {
  keyword: string;
  position: number;
  searchVolume: number;
  traffic: number;
  cpc: number | null;
  url: string | null;
  relativeUrl: string | null;
  keywordDifficulty: number | null;
};

export type DomainKeywordsResponse = {
  status: "ok";
  domain: string;
  page: number;
  pageSize: number;
  totalCount: number;
  hasMore: boolean;
  keywords: DomainKeywordItem[];
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
  appliedFilters: DomainFilterValues;
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

function toFiltersPayload(filters: DomainFilterValues): Record<string, unknown> {
  return {
    include: filters.include || undefined,
    exclude: filters.exclude || undefined,
    minTraffic: toNumberOrUndefined(filters.minTraffic),
    maxTraffic: toNumberOrUndefined(filters.maxTraffic),
    minVol: toNumberOrUndefined(filters.minVol),
    maxVol: toNumberOrUndefined(filters.maxVol),
    minCpc: toNumberOrUndefined(filters.minCpc),
    maxCpc: toNumberOrUndefined(filters.maxCpc),
    minKd: toNumberOrUndefined(filters.minKd),
    maxKd: toNumberOrUndefined(filters.maxKd),
    minRank: toNumberOrUndefined(filters.minRank),
    maxRank: toNumberOrUndefined(filters.maxRank),
  };
}

export function useDomainKeywordsQuery(input: Input) {
  const trimmedDomain = input.domain.trim();
  const filtersPayload = toFiltersPayload(input.appliedFilters);
  const cacheOnly = input.cacheOnly ?? false;

  const inputKey = stableStringify({
    domain: trimmedDomain,
    scope: input.scope,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    page: input.page,
    pageSize: input.pageSize,
    sortMode: input.sortMode,
    sortOrder: input.sortOrder,
    filters: filtersPayload,
    search: input.search || undefined,
    cacheOnly,
    maxUsd: input.maxUsd,
  });

  return useQuery({
    enabled: Boolean(input.enabled !== false && input.brandKey && trimmedDomain !== ""),
    queryKey: keys.domainKeywords(input.brandKey, inputKey),
    queryFn: async () => {
      const requestId = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : "00000000-0000-0000-0000-000000000000";

      return fetchJson<DomainKeywordsResponse>(
        `/api/customer/domain/keywords?brand_key=${encodeURIComponent(input.brandKey)}`,
        {
          method: "POST",
          body: {
            domain: trimmedDomain,
            scope: input.scope,
            locationCode: input.locationCode,
            languageCode: input.languageCode,
            page: input.page,
            pageSize: input.pageSize,
            sortMode: input.sortMode,
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
