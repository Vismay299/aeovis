"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/hooks/useDomainKeywordsQuery.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useQuery } from "@tanstack/react-query";
import { keys, stableStringify } from "@/lib/query/keys";
import { fetchJson } from "@/lib/query/fetchJson";
import type { ResearchScope } from "@/shared/researchScope";

export const SERP_COMPETITOR_RESULT_TYPES = [
  "organic",
  "paid",
  "featured_snippet",
  "local_pack",
] as const;

export type SerpCompetitorResultType =
  (typeof SERP_COMPETITOR_RESULT_TYPES)[number];

export type CompetitorSortBy =
  | "visibility"
  | "traffic_estimate"
  | "avg_position"
  | "keyword_count";

export type CompetitorItem = {
  domain: string;
  keywordsCount: number | null;
  avgPosition: number | null;
  medianPosition: number | null;
  visibility: number | null;
  etv: number | null;
  isOwnSite: boolean;
  isDeclaredCompetitor: boolean;
};

export type DomainCompetitorsOkResponse = {
  status: "ok";
  keywordCount: number;
  competitors: CompetitorItem[];
  cached?: boolean;
  fetchedAt?: string;
  provenance?: { gateway: string };
};

export type DomainCompetitorsNotCachedResponse = {
  status: "not_cached";
  keywordCount: number;
  competitors: [];
};

export type DomainCompetitorsResponse =
  | DomainCompetitorsOkResponse
  | DomainCompetitorsNotCachedResponse;

type Input = {
  brandKey: string;
  domain: string;
  scope: ResearchScope;
  locationCode?: number;
  languageCode?: string;
  keywords: string[];
  resultTypes?: SerpCompetitorResultType[];
  includeSubdomains?: boolean;
  sortBy?: CompetitorSortBy;
  limit?: number;
  cacheOnly?: boolean;
  maxUsd?: number;
  enabled?: boolean;
};

/**
 * SERP competitors for the keywords loaded on the Top Keywords page.
 *
 * `cacheOnly: true` reads the 12-hour provider cache and never spends; only an
 * approved quote (`maxUsd`, from `domain.competitors.run`) may send `false`.
 */
export function useDomainCompetitorsQuery(input: Input) {
  const trimmedDomain = input.domain.trim();
  const cacheOnly = input.cacheOnly ?? true;
  const sortBy = input.sortBy ?? "visibility";
  const limit = input.limit ?? 50;

  const inputKey = stableStringify({
    domain: trimmedDomain,
    scope: input.scope,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    keywords: input.keywords,
    resultTypes: input.resultTypes,
    includeSubdomains: input.includeSubdomains,
    sortBy,
    limit,
    cacheOnly,
    maxUsd: input.maxUsd,
  });

  return useQuery({
    enabled: Boolean(
      input.enabled !== false &&
        input.brandKey &&
        trimmedDomain !== "" &&
        input.keywords.length > 0,
    ),
    queryKey: keys.domainCompetitors(input.brandKey, inputKey),
    queryFn: async () => {
      const requestId =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : "00000000-0000-0000-0000-000000000000";

      return fetchJson<DomainCompetitorsResponse>(
        `/api/customer/domain/competitors?brand_key=${encodeURIComponent(input.brandKey)}`,
        {
          method: "POST",
          body: {
            domain: trimmedDomain,
            scope: input.scope,
            locationCode: input.locationCode,
            languageCode: input.languageCode,
            keywords: input.keywords,
            resultTypes: input.resultTypes,
            includeSubdomains: input.includeSubdomains,
            sortBy,
            limit,
            cacheOnly,
            maxUsd: input.maxUsd,
            requestId,
          },
        },
      );
    },
    staleTime: 60_000,
    retry: false,
    // A cache-only read is free, so it may revalidate on every mount: that is
    // what surfaces a warm provider cache after a paid run instead of replaying
    // a stale pre-run "not_cached". A live read is the opposite: it may only
    // run from an explicit, approved click.
    refetchOnMount: cacheOnly ? "always" : false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
