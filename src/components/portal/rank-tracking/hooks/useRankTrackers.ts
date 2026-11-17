// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/rank-tracking/RankTrackingDomainList.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { keys } from "@/shared/query/keys";
import type { Devices, RankSchedule } from "@/shared/rank-tracking";

export type RankTrackerSummary = {
  id: string;
  domain: string;
  locationCode: number;
  languageCode: string;
  locationName: string | null;
  devices: Devices;
  serpDepth: number;
  scheduleInterval: RankSchedule;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  lastSkipReason: string | null;
  lastSkipMessage: string | null;
  approvedMaxUsd: number | null;
  keywordCount: number;
  lastRunStatus: string | null;
  lastRunCompletedAt: string | null;
};

export type RankTrackersResponse = {
  trackers: RankTrackerSummary[];
};

export function rankTrackersQueryOptions(brandKey: string) {
  return {
    queryKey: keys.rankTrackers(brandKey),
    queryFn: ({ signal }: { signal?: AbortSignal } = {}) =>
      fetchJson<RankTrackersResponse>(withBrand("/api/customer/rank-tracking/configs", brandKey), {
        signal,
      }),
    enabled: Boolean(brandKey),
  };
}

/** The workspace's tracked domains, newest last (the server orders by creation). */
export function useRankTrackers(brandKey: string) {
  return useQuery(rankTrackersQueryOptions(brandKey));
}

export function useRankTracker(brandKey: string, configId: string) {
  return useQuery({
    queryKey: keys.rankTracker(brandKey, configId),
    queryFn: ({ signal }: { signal?: AbortSignal } = {}) =>
      fetchJson<{ tracker: RankTrackerSummary }>(
        withBrand(
          `/api/customer/rank-tracking/configs/${encodeURIComponent(configId)}`,
          brandKey,
        ),
        { signal },
      ),
    enabled: Boolean(brandKey && configId),
  });
}

export function useArchiveRankTracker(brandKey: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (configId: string) =>
      fetchJson<{ tracker: RankTrackerSummary }>(
        `/api/customer/rank-tracking/configs/${encodeURIComponent(configId)}`,
        {
          method: "PATCH",
          body: { brand_key: brandKey, isActive: false },
        },
      ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: keys.rankTrackers(brandKey) });
    },
  });
}

