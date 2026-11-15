// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/useRankCheckTrigger.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { keys } from "@/lib/query/keys";
import { trackRankEvent } from "../telemetry";

export function useRankCheckTrigger({
  brandKey,
  configId,
  isRunning,
  onSuccess,
}: {
  brandKey: string;
  configId: string;
  isRunning: boolean;
  onSuccess?: () => void;
}) {
  const queryClient = useQueryClient();

  const triggerMutation = useMutation({
    mutationFn: (opts: { keywordIds?: string[]; maxUsd?: number; totalKeywords?: number }) =>
      fetchJson<{ runId: string; jobId: string; status: string; pollAfterSeconds: number }>(
        withBrand(
          `/api/customer/rank-tracking/configs/${encodeURIComponent(configId)}/check`,
          brandKey,
        ),
        {
          method: "POST",
          body: {
            brand_key: brandKey,
            keywordIds: opts.keywordIds,
            maxUsd: opts.maxUsd,
          },
        },
      ),
    onSuccess: (_data, variables) => {
      onSuccess?.();
      void queryClient.invalidateQueries({
        queryKey: keys.rankLatestRun(brandKey, configId),
      });
      trackRankEvent("rank_tracking:check_trigger", {
        keywords: variables.keywordIds?.length ?? variables.totalKeywords ?? 0,
        subset: Boolean(variables.keywordIds?.length),
      });
      toast.success("Rank check started");
    },
    onError: (err: any) => {
      if (err?.code === "rank_check_running") {
        toast.info("A rank check is already running");
        return;
      }
      toast.error(err?.message || "Failed to start rank check.");
    },
  });

  const startCheck = (opts: { keywordIds?: string[]; maxUsd?: number; totalKeywords?: number }) => {
    if (triggerMutation.isPending || isRunning) return;
    triggerMutation.mutate(opts);
  };

  return {
    startCheck,
    isPending: triggerMutation.isPending,
    isBusy: isRunning || triggerMutation.isPending,
  };
}
