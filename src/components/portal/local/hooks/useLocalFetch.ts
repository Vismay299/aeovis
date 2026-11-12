"use client";

import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { keys } from "@/lib/query/keys";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { useServerPacedQuery } from "@/components/app/hooks/useServerPacedQuery";
import type { FetchKind, FetchSummary, FetchView } from "@/lib/local/fetches";
import { trackLocalEvent } from "../telemetry";

export type { FetchKind, FetchSummary, FetchView };

export type StartFetchInput = {
  kind: "reviews" | "updates" | "questions";
  businessId: string;
  depth: number;
  sortBy?: "newest" | "highest_rating" | "lowest_rating" | "relevant";
  includeOtherSources?: boolean;
  maxUsd?: number;
};

const TEN_MINUTES_MS = 10 * 60 * 1000;

export function useLocalFetch(
  brandKey: string,
  fetchId: string | null,
  businessId?: string | null,
  kind?: FetchKind | null
) {
  const queryClient = useQueryClient();
  const startTimesRef = useRef<Record<string, number>>({});

  const historyQuery = useQuery<{ fetches: FetchSummary[] }>({
    queryKey: keys.localFetches(brandKey, businessId ?? null, kind ?? null),
    queryFn: () => {
      const params = new URLSearchParams();
      if (businessId) params.set("businessId", businessId);
      if (kind) params.set("kind", kind);
      return fetchJson<{ fetches: FetchSummary[] }>(
        withBrand(`/api/customer/local/fetches?${params.toString()}`, brandKey)
      );
    },
    enabled: Boolean(brandKey && businessId),
  });

  // With no fetch in the URL, show the latest collection: the "Earlier
  // collections" select already displays it as selected.
  const routeFetchId = fetchId;
  fetchId = routeFetchId ?? historyQuery.data?.fetches?.[0]?.id ?? null;

  const fetchQuery = useServerPacedQuery<FetchView>({
    queryKey: keys.localFetch(brandKey, fetchId ?? ""),
    queryFn: () =>
      fetchJson<FetchView>(
        withBrand(`/api/customer/local/fetches/${fetchId}`, brandKey)
      ),
    enabled: Boolean(brandKey && fetchId),
    isActive: (data) => {
      if (!data || data.status !== "processing") return false;
      if (!fetchId) return false;
      if (!startTimesRef.current[fetchId]) {
        startTimesRef.current[fetchId] = Date.now();
      }
      const elapsed = Date.now() - startTimesRef.current[fetchId];
      return elapsed < TEN_MINUTES_MS;
    },
    pollAfterSeconds: (data) => data?.pollAfterSeconds ?? 5,
    onFinish: (data) => {
      if (businessId) {
        queryClient.invalidateQueries({
          queryKey: keys.localFetches(brandKey, businessId, kind ?? null),
        });
      }
    },
  });

  const startMutation = useMutation({
    mutationFn: (input: StartFetchInput) =>
      fetchJson<FetchView>(withBrand("/api/customer/local/fetches", brandKey), {
        method: "POST",
        body: {
          ...input,
          requestId: crypto.randomUUID(),
        },
      }),
    onSuccess: (data, variables) => {
      if (data?.id) {
        startTimesRef.current[data.id] = Date.now();
        queryClient.setQueryData(keys.localFetch(brandKey, data.id), data);
        queryClient.invalidateQueries({
          queryKey: keys.localFetches(
            brandKey,
            variables.businessId,
            variables.kind
          ),
        });
      }
      if (variables.kind === "reviews") {
        trackLocalEvent("local:reviews_collect", {
          depth: variables.depth,
          other_sources: Boolean(variables.includeOtherSources),
          reused: Boolean(data?.reused),
        });
      } else if (variables.kind === "updates") {
        trackLocalEvent("local:updates_collect", {
          reused: Boolean(data?.reused),
        });
      } else if (variables.kind === "questions") {
        trackLocalEvent("local:questions_collect", {
          reused: Boolean(data?.reused),
        });
      }
    },
  });

  const isTimedOut = Boolean(
    fetchQuery.data?.status === "processing" &&
      fetchId &&
      startTimesRef.current[fetchId] &&
      Date.now() - startTimesRef.current[fetchId] >= TEN_MINUTES_MS
  );

  return {
    fetch: fetchQuery.data ?? null,
    isLoading: fetchQuery.isLoading,
    isError: fetchQuery.isError,
    error: fetchQuery.error,
    refetch: () => {
      if (fetchId) {
        startTimesRef.current[fetchId] = Date.now();
      }
      return fetchQuery.refetch();
    },
    isTimedOut,
    history: historyQuery.data?.fetches ?? [],
    isLoadingHistory: historyQuery.isLoading,
    // The global mutation toast reports a failure; resolve null instead of
    // rejecting so the tabs' onRun callbacks leave no unhandled rejection.
    startFetch: (input: StartFetchInput) => startMutation.mutateAsync(input).catch(() => null),
    isStarting: startMutation.isPending,
  };
}
