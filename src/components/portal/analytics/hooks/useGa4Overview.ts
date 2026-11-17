"use client";

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { keys } from "@/shared/query/keys";

/** GET /api/customer/ga4/overview for the selected range. */
export function useGa4Overview(brandKey: string, range: string) {
  return useQuery({
    queryKey: keys.ga4Overview(brandKey, range),
    queryFn: () =>
      fetchJson<Record<string, unknown>>(
        withBrand("/api/customer/ga4/overview", brandKey, { range }),
      ),
    enabled: Boolean(brandKey),
    placeholderData: keepPreviousData,
  });
}
