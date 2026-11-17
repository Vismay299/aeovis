"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { keys } from "@/shared/query/keys";
import type { BacklinksSnapshot } from "@/shared/backlinks";

type SnapshotsResponse = { snapshots: BacklinksSnapshot[] };

export function useSnapshots(
  brandKey: string,
  target: string,
  scope: "domain" | "subdomains",
  enabled: boolean,
) {
  return useQuery({
    queryKey: keys.backlinkSnapshots(brandKey, target, scope),
    queryFn: () =>
      fetchJson<SnapshotsResponse>(
        withBrand("/api/customer/backlinks/snapshots", brandKey, {
          target,
          scope,
        }),
      ),
    enabled: Boolean(brandKey && target && enabled),
    retry: false,
    refetchOnWindowFocus: false,
  });
}
