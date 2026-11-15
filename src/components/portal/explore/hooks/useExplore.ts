// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-search/promptExplorerQuery.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { exploreKeys } from "@/lib/query/keys";
import type { ExploreModel } from "@/shared/explore";
import type {
  ExploreGetResponse,
  ExploreListResponse,
  ExploreStartResponse,
  ExploreTrackResponse,
} from "@/lib/explore/explore.contract";

export type {
  ExploreGetResponse,
  ExploreListResponse,
  ExploreStartResponse,
  ExploreTrackResponse,
};

export type StartExploreInput = {
  prompt: string;
  models: ExploreModel[];
  webSearch?: boolean;
  country?: string | null;
  highlightBrand?: string | null;
  fresh?: boolean;
  maxUsd?: number;
};

export function useExploreRun(brandKey: string, runId: string | null) {
  return useQuery({
    queryKey: runId ? exploreKeys.run(brandKey, runId) : ["explore", brandKey, "run", ""],
    queryFn: ({ signal }): Promise<ExploreGetResponse> => {
      if (!runId) throw new Error("No runId provided");
      return fetchJson<ExploreGetResponse>(
        withBrand(`/api/customer/explore/${encodeURIComponent(runId)}`, brandKey),
        { signal },
      );
    },
    enabled: Boolean(brandKey && runId),
    refetchInterval: (q) =>
      q.state.data?.pollAfterSeconds ? q.state.data.pollAfterSeconds * 1000 : false,
    staleTime: (q) => (q.state.data?.pollAfterSeconds ? 0 : Infinity),
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useRecentExploreRuns(brandKey: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: exploreKeys.runs(brandKey),
    queryFn: ({ signal }): Promise<ExploreListResponse> =>
      fetchJson<ExploreListResponse>(
        withBrand("/api/customer/explore", brandKey, { limit: 20 }),
        { signal },
      ),
    enabled: options?.enabled ?? Boolean(brandKey),
    staleTime: 30_000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function useStartExploreRun(brandKey: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (body: StartExploreInput): Promise<ExploreStartResponse> =>
      fetchJson<ExploreStartResponse>("/api/customer/explore", {
        method: "POST",
        body: {
          ...body,
          brand_key: brandKey,
        },
      }),
    // ExplorePage shows price-changed, rate-limit and dialog errors itself.
    meta: { errorToast: false },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: exploreKeys.runs(brandKey) });
    },
  });
}

export function useTrackExploreQuestion(brandKey: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (runId: string): Promise<ExploreTrackResponse> =>
      fetchJson<ExploreTrackResponse>(
        `/api/customer/explore/${encodeURIComponent(runId)}/track`,
        {
          method: "POST",
          body: {
            brand_key: brandKey,
          },
        },
      ),
    // TrackQuestionButton shows its own error toast.
    meta: { errorToast: false },
    onSuccess: (_data, runId) => {
      queryClient.invalidateQueries({ queryKey: exploreKeys.run(brandKey, runId) });
    },
  });
}
