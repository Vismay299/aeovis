"use client";

import { useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { keys } from "@/shared/query/keys";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { useServerPacedQuery } from "@/components/app/hooks/useServerPacedQuery";
import type { GridSummaryRow, GridView } from "@/server/local/grid";
import { trackLocalEvent } from "../telemetry";

export type { GridSummaryRow, GridView };

export type StartGridInput = {
  keyword: string;
  center: { latitude: number; longitude: number };
  gridSize: 3 | 5;
  spacingKm: number;
  device: "desktop" | "mobile";
  zoom?: number;
  languageCode?: string;
  target: {
    businessId?: string;
    cid?: string;
    placeId?: string;
    name?: string;
  };
  maxUsd?: number;
};

// A grid collected inline finishes long before this; past it the client stops
// polling and offers "Check again", as the reviews tab does (F17 §6.6.5).
const TEN_MINUTES_MS = 10 * 60 * 1000;

export function useLocalGrid(brandKey: string, gridId: string | null) {
  const queryClient = useQueryClient();
  const startTimesRef = useRef<Record<string, number>>({});

  const historyQuery = useQuery<{ grids: GridSummaryRow[] }>({
    queryKey: keys.localGrids(brandKey),
    queryFn: () =>
      fetchJson<{ grids: GridSummaryRow[] }>(
        withBrand("/api/customer/local/grids", brandKey)
      ),
    enabled: Boolean(brandKey),
  });

  // With no grid in the URL, show the latest run: "Grid history" already
  // displays it as the selected entry.
  const routeGridId = gridId;
  gridId = routeGridId ?? historyQuery.data?.grids?.[0]?.id ?? null;

  const gridQuery = useServerPacedQuery<GridView>({
    queryKey: keys.localGrid(brandKey, gridId ?? ""),
    queryFn: () =>
      fetchJson<GridView>(
        withBrand(`/api/customer/local/grids/${gridId}`, brandKey)
      ),
    enabled: Boolean(brandKey && gridId),
    isActive: (data) => {
      if (!data || data.status !== "processing") return false;
      if (!gridId) return false;
      if (!startTimesRef.current[gridId]) {
        startTimesRef.current[gridId] = Date.now();
      }
      return Date.now() - startTimesRef.current[gridId] < TEN_MINUTES_MS;
    },
    pollAfterSeconds: (data) => data?.pollAfterSeconds ?? 5,
    onFinish: () => {
      queryClient.invalidateQueries({ queryKey: keys.localGrids(brandKey) });
    },
  });

  const startMutation = useMutation({
    mutationFn: (input: StartGridInput) =>
      fetchJson<GridView>(withBrand("/api/customer/local/grids", brandKey), {
        method: "POST",
        body: {
          ...input,
          requestId: crypto.randomUUID(),
        },
      }),
    onSuccess: (data, variables) => {
      if (data?.id) {
        startTimesRef.current[data.id] = Date.now();
        queryClient.setQueryData(keys.localGrid(brandKey, data.id), data);
        queryClient.invalidateQueries({ queryKey: keys.localGrids(brandKey) });
      }
      trackLocalEvent("local:grid_run", {
        size: variables.gridSize,
        reused: Boolean(data?.reused),
        points_found: data?.summary?.pointsFound ?? 0,
      });
    },
  });

  const isTimedOut = Boolean(
    gridQuery.data?.status === "processing" &&
      gridId &&
      startTimesRef.current[gridId] &&
      Date.now() - startTimesRef.current[gridId] >= TEN_MINUTES_MS
  );

  return {
    grid: gridQuery.data ?? null,
    isLoading: gridQuery.isLoading,
    isError: gridQuery.isError,
    refetch: () => {
      if (gridId) {
        startTimesRef.current[gridId] = Date.now();
      }
      return gridQuery.refetch();
    },
    isTimedOut,
    history: historyQuery.data?.grids ?? [],
    isLoadingHistory: historyQuery.isLoading,
    // The global mutation toast reports a failure; resolve null instead of
    // rejecting so the priced button's onRun leaves no unhandled rejection.
    startGrid: (input: StartGridInput) =>
      startMutation.mutateAsync(input).catch(() => null),
    startError: startMutation.error ?? null,
    isStarting: startMutation.isPending,
  };
}
