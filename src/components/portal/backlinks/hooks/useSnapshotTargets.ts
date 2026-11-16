"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { keys } from "@/lib/query/keys";

export type SnapshotInterval = "weekly" | "monthly";
export type SnapshotTarget = {
  id: string;
  target: string;
  scope: "domain" | "subdomains";
  label: string | null;
  interval: SnapshotInterval;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  lastSkipReason: string | null;
  lastSkipMessage: string | null;
};

type SnapshotTargetsResponse = { targets: SnapshotTarget[] };

export function useSnapshotTargets(brandKey: string, enabled: boolean) {
  return useQuery({
    queryKey: keys.backlinkSnapshotTargets(brandKey),
    queryFn: () =>
      fetchJson<SnapshotTargetsResponse>(
        withBrand("/api/customer/backlinks/snapshot-targets", brandKey),
      ),
    enabled: Boolean(brandKey && enabled),
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export type CreateSnapshotTargetInput = {
  target: string;
  scope: "domain" | "subdomains";
  interval: SnapshotInterval;
  maxUsd: number;
  label?: string;
};

export function useCreateSnapshotTarget(brandKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateSnapshotTargetInput) =>
      fetchJson<{ target: SnapshotTarget }>(
        withBrand("/api/customer/backlinks/snapshot-targets", brandKey),
        { method: "POST", body: input },
      ),
    onSuccess: async (result, input) => {
      queryClient.setQueriesData<Record<string, unknown>>(
        { queryKey: ["backlinksOverview", brandKey] },
        (previous) => {
          if (
            !previous ||
            previous.target !== input.target ||
            previous.scope !== input.scope
          ) return previous;
          return {
            ...previous,
            tracked: {
              interval: input.interval,
              nextRunAt: result.target.nextRunAt,
            },
          };
        },
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: keys.backlinkSnapshotTargets(brandKey),
        }),
      ]);
    },
  });
}

export function useDeleteSnapshotTarget(brandKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; target: string; scope: "domain" | "subdomains" }) =>
      fetchJson<{ deleted: true }>(
        withBrand(
          `/api/customer/backlinks/snapshot-targets/${encodeURIComponent(input.id)}`,
          brandKey,
        ),
        { method: "DELETE" },
      ),
    onSuccess: async (_result, input) => {
      queryClient.setQueriesData<Record<string, unknown>>(
        { queryKey: ["backlinksOverview", brandKey] },
        (previous) => {
          if (
            !previous ||
            previous.target !== input.target ||
            previous.scope !== input.scope
          ) return previous;
          return { ...previous, tracked: null };
        },
      );
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: keys.backlinkSnapshotTargets(brandKey),
        }),
        queryClient.invalidateQueries({ queryKey: ["backlinkSnapshots", brandKey] }),
      ]);
    },
  });
}
