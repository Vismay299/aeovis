// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/hooks/useKeywordSerpAnalysis.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/shared/query/fetchJson";
import { keys, stableStringify } from "@/shared/query/keys";

export type KeywordSerpInput = {
  brand_key: string;
  keyword: string;
  locationCode: number;
  languageCode: string;
  depth: 20 | 100;
  cacheOnly: boolean;
  maxUsd?: number;
};

export type SerpItem = {
  rank: number;
  title: string;
  url: string;
  domain: string;
  description: string;
  etv: number | null;
  estimatedPaidTrafficCost: number | null;
  referringDomains: number | null;
  backlinks: number | null;
  isNew: boolean;
  rankChange: number | null;
};

export type KeywordSerpResponse = {
  items?: SerpItem[];
  notCached?: boolean;
  cached?: boolean;
  depth?: number;
  reason?: string;
};

export function useKeywordSerpAnalysis(input: KeywordSerpInput | null) {
  const inputKey = input ? stableStringify(input) : "";
  return useQuery({
    queryKey: keys.keywordSerp(input?.brand_key ?? "", inputKey),
    enabled: Boolean(input?.brand_key && input.keyword),
    queryFn: ({ signal }) =>
      fetchJson<KeywordSerpResponse>("/api/customer/keywords/serp", {
        method: "POST",
        body: { ...input, requestId: crypto.randomUUID() },
        signal,
      }),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
