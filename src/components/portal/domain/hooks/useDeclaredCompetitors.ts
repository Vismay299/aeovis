"use client";

import { useQuery } from "@tanstack/react-query";
import { keys } from "@/shared/query/keys";
import { fetchJson } from "@/shared/query/fetchJson";

export type DeclaredCompetitorsResponse = {
  available: boolean;
  competitors: Array<{ domain: string; name?: string | null }>;
  ownHost?: string;
};

export function useDeclaredCompetitors(brandKey: string) {
  return useQuery({
    queryKey: keys.declaredCompetitors(brandKey),
    queryFn: () =>
      fetchJson<DeclaredCompetitorsResponse>(
        `/api/customer/domain/competitors/declared?brand_key=${encodeURIComponent(brandKey)}`,
      ),
    enabled: Boolean(brandKey),
    staleTime: 60_000,
  });
}
