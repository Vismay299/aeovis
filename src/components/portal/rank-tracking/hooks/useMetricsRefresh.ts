// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/useMetricsRefresh.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { trackRankEvent } from "../telemetry";

export function useMetricsRefresh(brandKey: string, configId: string) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (opts?: { maxUsd?: number }) =>
      fetchJson<{ updated: number; fromCache: number; bought: number }>(
        withBrand(
          `/api/customer/rank-tracking/configs/${encodeURIComponent(configId)}/metrics/refresh`,
          brandKey,
        ),
        {
          method: "POST",
          body: {
            brand_key: brandKey,
            requestId: crypto.randomUUID(),
            ...(opts?.maxUsd !== undefined ? { maxUsd: opts.maxUsd } : {}),
          },
        },
      ),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({
        queryKey: ["rankResults", brandKey, configId],
      });
      trackRankEvent("rank_tracking:metrics_refresh", {
        bought: result.bought,
        from_cache: result.fromCache,
      });
      toast.success(
        `Metrics updated for ${result.updated} keyword${result.updated !== 1 ? "s" : ""}`,
      );
    },
    onError: (err: any) => {
      toast.error(err?.message || "Failed to update keyword stats.");
    },
  });

  return {
    refresh: (opts?: { maxUsd?: number }) => mutation.mutate(opts),
    isRefreshing: mutation.isPending,
  };
}
