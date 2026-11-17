"use client";

import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { keys, stableStringify } from "@/shared/query/keys";

export type Ga4ReportParams = Record<
  string,
  string | number | boolean | undefined | null
>;

/** GET /api/customer/ga4/reports/[kind] with the tab's query params. */
export function useGa4Report(
  brandKey: string,
  kind: string,
  params: Ga4ReportParams,
) {
  const normalized: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    normalized[key] = value;
  }
  const paramsHash = stableStringify(normalized);
  return useQuery({
    queryKey: keys.ga4Report(brandKey, kind, paramsHash),
    queryFn: () =>
      fetchJson<Record<string, unknown>>(
        withBrand(`/api/customer/ga4/reports/${kind}`, brandKey, normalized),
      ),
    enabled: Boolean(brandKey) && Boolean(kind),
    placeholderData: keepPreviousData,
  });
}
