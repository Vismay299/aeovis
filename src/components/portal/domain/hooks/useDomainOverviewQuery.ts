"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/hooks/useDomainOverviewQuery.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useQuery } from "@tanstack/react-query";
import { keys, stableStringify } from "@/shared/query/keys";
import { fetchJson } from "@/shared/query/fetchJson";
import type { ResearchScope } from "@/shared/researchScope";
import { trackDomainEvent } from "../telemetry";

export type DomainOverviewOkResponse = {
  status: "ok";
  domain: string;
  displayTarget: string;
  scope: ResearchScope;
  organicTraffic: number;
  organicKeywords: number;
  hasData: boolean;
  market: { locationCode: number; languageCode: string; country: string };
  isOwnSite: boolean;
  isDeclaredCompetitor: boolean;
  cached: boolean;
  fetchedAt: string;
  provenance: { gateway: string };
};

export type DomainOverviewNotCachedResponse = {
  status: "not_cached";
  domain: string;
  displayTarget: string;
  scope: ResearchScope;
  market: { locationCode: number; languageCode: string; country: string };
};

export type DomainOverviewResponse =
  | DomainOverviewOkResponse
  | DomainOverviewNotCachedResponse;

type Input = {
  brandKey: string;
  domain: string;
  scope: ResearchScope;
  locationCode?: number;
  languageCode?: string;
  cacheOnly?: boolean;
  maxUsd?: number;
  enabled?: boolean;
};

export function useDomainOverviewQuery(input: Input) {
  const trimmedDomain = input.domain.trim();
  const cacheOnly = input.cacheOnly ?? false;

  const inputKey = stableStringify({
    domain: trimmedDomain,
    scope: input.scope,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    cacheOnly,
    maxUsd: input.maxUsd,
  });

  return useQuery({
    enabled: Boolean(input.enabled !== false && input.brandKey && trimmedDomain !== ""),
    queryKey: keys.domainOverview(input.brandKey, inputKey),
    queryFn: async () => {
      const requestId = typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : "00000000-0000-0000-0000-000000000000";

      const res = await fetchJson<DomainOverviewResponse>(
        `/api/customer/domain/overview?brand_key=${encodeURIComponent(input.brandKey)}`,
        {
          method: "POST",
          body: {
            domain: trimmedDomain,
            scope: input.scope,
            locationCode: input.locationCode,
            languageCode: input.languageCode,
            cacheOnly,
            maxUsd: input.maxUsd,
            requestId,
          },
        },
      );

      if (res.status === "ok") {
        trackDomainEvent("domain_overview:lookup", {
          scope: res.scope,
          cached: res.cached,
          has_data: res.hasData,
        });
      }

      return res;
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
}
