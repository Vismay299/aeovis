// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/useSetKeywordPinned.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useOptimisticMutation } from "@/components/app/hooks/useOptimisticMutation";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { trackRankEvent } from "../telemetry";
import type { RankResultsResponse } from "./useRankResults";

export function useSetKeywordPinned(brandKey: string, configId: string) {
  const queryKey = ["rankResults", brandKey, configId] as const;

  const mutation = useOptimisticMutation<
    { trackingKeywordId: string; pinned: boolean },
    { updated: number; updatedIds: string[] },
    RankResultsResponse
  >({
    queryKey,
    mutationFn: ({ trackingKeywordId, pinned }) =>
      fetchJson<{ updated: number; updatedIds: string[] }>(
        withBrand(
          `/api/customer/rank-tracking/configs/${encodeURIComponent(configId)}/keywords/pin`,
          brandKey,
        ),
        {
          method: "POST",
          body: {
            brand_key: brandKey,
            keywordIds: [trackingKeywordId],
            pinned,
          },
        },
      ),
    apply: (old, { trackingKeywordId, pinned }) => {
      if (!old || !old.rows) return old;
      return {
        ...old,
        rows: old.rows.map((row) =>
          row.trackingKeywordId === trackingKeywordId
            ? { ...row, pinned }
            : row,
        ),
      };
    },
    onSuccess: (_data, { pinned }) => {
      trackRankEvent("rank_tracking:pin", { pinned });
    },
  });

  return (vars: { trackingKeywordId: string; pinned: boolean }) =>
    mutation.mutate(vars);
}
