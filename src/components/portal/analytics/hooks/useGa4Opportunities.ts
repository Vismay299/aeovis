"use client";

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { keys } from "@/shared/query/keys";

/** GET /api/customer/ga4/opportunities for the selected range. */
export function useGa4Opportunities(brandKey: string, range: string) {
  return useQuery({
    queryKey: keys.ga4Opportunities(brandKey, range),
    queryFn: () =>
      fetchJson<Record<string, unknown>>(
        withBrand("/api/customer/ga4/opportunities", brandKey, { range }),
      ),
    enabled: Boolean(brandKey),
    placeholderData: keepPreviousData,
  });
}
