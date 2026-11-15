// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/useRankRunPolling.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useServerPacedQuery } from "@/components/app/hooks/useServerPacedQuery";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { keys } from "@/lib/query/keys";
import { isRankRunActive } from "@/lib/rank-tracking/runPolling";

export type RankRunView = {
  id: string;
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
};

export type LatestRunResponse = {
  run: RankRunView | null;
};

export function useRankRunPolling(brandKey: string, configId: string) {
  const queryClient = useQueryClient();

  const query = useServerPacedQuery<LatestRunResponse>({
    queryKey: keys.rankLatestRun(brandKey, configId),
    queryFn: ({ signal }) =>
      fetchJson<LatestRunResponse>(
        withBrand(
          `/api/customer/rank-tracking/configs/${encodeURIComponent(configId)}/runs/latest`,
          brandKey,
        ),
        { signal },
      ),
    isActive: (data) => isRankRunActive(data?.run),
    pollAfterSeconds: (data) => data?.run?.pollAfterSeconds,
    floorSeconds: 3,
    fallbackSeconds: 3,
    onFinish: () => {
      void queryClient.invalidateQueries({
        queryKey: ["rankResults", brandKey, configId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["rankTrend", brandKey, configId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["rankMatrix", brandKey, configId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["rankKeywordHistory", brandKey, configId],
      });
    },
    enabled: Boolean(brandKey && configId),
  });

  return query.data?.run ?? null;
}
