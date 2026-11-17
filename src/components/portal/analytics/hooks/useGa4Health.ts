"use client";

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { keys } from "@/shared/query/keys";

/** GET /api/customer/ga4/health — the measurement-health inventory. */
export function useGa4Health(brandKey: string) {
  return useQuery({
    queryKey: keys.ga4Health(brandKey),
    queryFn: () =>
      fetchJson<Record<string, unknown>>(
        withBrand("/api/customer/ga4/health", brandKey),
      ),
    enabled: Boolean(brandKey),
    placeholderData: keepPreviousData,
  });
}
