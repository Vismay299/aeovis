// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/rank-tracking/RankTrackingDomainDetail.tsx:110-120
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { keys } from "@/lib/query/keys";
import type { ComparePeriod, RankTrackingRow } from "@/shared/rank-tracking";

export type RankResultsResponse = {
  rows: RankTrackingRow[];
  run: {
    id: string;
    lastCheckedAt: string | null;
    status: string;
    trigger: string;
    method: string;
    phase: string | null;
    keywordsTotal: number;
    keywordsChecked: number;
    isSubsetRun: boolean;
    errorCode: string | null;
    errorMessage: string | null;
    startedAt: string;
    completedAt: string | null;
    maybeStale: boolean;
    staleReason: string | null;
    pollAfterSeconds: number | null;
  } | null;
};

export function useRankResults(
  brandKey: string,
  configId: string,
  comparePeriod: ComparePeriod,
) {
  return useQuery({
    queryKey: keys.rankResults(brandKey, configId, comparePeriod),
    queryFn: ({ signal }) => {
      const url = withBrand(
        `/api/customer/rank-tracking/configs/${encodeURIComponent(configId)}/results?compare=${encodeURIComponent(comparePeriod)}`,
        brandKey,
      );
      return fetchJson<RankResultsResponse>(url, { signal });
    },
    placeholderData: keepPreviousData,
    enabled: Boolean(brandKey && configId),
  });
}
