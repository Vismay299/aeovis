"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { keys, stableStringify } from "@/lib/query/keys";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import type { LocalSerpRow } from "@/lib/local/localSerp";
import { trackLocalEvent } from "../telemetry";

export type { LocalSerpRow };

export type LocalSerpResult = {
  results: LocalSerpRow[];
  ownRank: number | null;
  cached: boolean;
  fetchedAt: string;
};

export type StartLocalSerpInput = {
  keyword: string;
  near: { latitude: number; longitude: number; zoom?: number };
  searchType: "maps" | "local_finder";
  device: "desktop" | "mobile";
  depth: number;
  languageCode?: string;
  maxUsd?: number;
};

export function useLocalSerp(brandKey: string) {
  const queryClient = useQueryClient();

  const searchMutation = useMutation<LocalSerpResult, Error, StartLocalSerpInput>({
    mutationFn: (input) =>
      fetchJson<LocalSerpResult>(
        withBrand("/api/customer/local/serp", brandKey),
        {
          method: "POST",
          body: {
            ...input,
            requestId: crypto.randomUUID(),
          },
        }
      ),
    onSuccess: (data, variables) => {
      // Seed the workspace-scoped key so a tab switch or a repeat of the same
      // search reads the last result without a second priced call.
      queryClient.setQueryData(
        keys.localSerp(brandKey, stableStringify(variables)),
        data
      );
      trackLocalEvent("local:serp_search", {
        type: variables.searchType,
        cached: Boolean(data?.cached),
        own_ranked: data?.ownRank != null,
      });
    },
  });

  return {
    result: searchMutation.data ?? null,
    isSearching: searchMutation.isPending,
    error: searchMutation.error ?? null,
    // The global mutation toast reports a failure; resolve null instead of
    // rejecting so the priced button's onRun leaves no unhandled rejection.
    search: (input: StartLocalSerpInput) =>
      searchMutation.mutateAsync(input).catch(() => null),
  };
}
