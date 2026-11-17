// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/hooks/useKeywordResearchData.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/shared/query/fetchJson";
import { keys, stableStringify } from "@/shared/query/keys";
import type { KeywordIntent } from "@/shared/keywords";

export type KeywordResearchInput = {
  brand_key: string;
  keyword: string;
  locationCode: number;
  languageCode: string;
  resultLimit: 150 | 300 | 500;
  mode: "auto" | "related" | "suggestions" | "ideas";
  clickstream: boolean;
  groupKeywords: boolean;
  cacheOnly: boolean;
  maxUsd?: number;
  requestId?: string;
};

export type KeywordRow = {
  keyword: string;
  searchVolume: number | null;
  trend: Array<{ year: number; month: number; searchVolume: number }>;
  cpc: number | null;
  competition: number | null;
  keywordDifficulty: number | null;
  intent: KeywordIntent;
  parentKeyword?: string | null;
};

export type KeywordResearchResponse = {
  rows?: KeywordRow[];
  notCached?: boolean;
  cached?: boolean;
  source?: string;
  fetchedAt?: string;
  warnings?: Array<{ code: string; message: string }>;
};

export function useKeywordResearchData(input: KeywordResearchInput | null) {
  const inputKey = input ? stableStringify(input) : "";
  return useQuery({
    queryKey: keys.keywordResearch(input?.brand_key ?? "", inputKey),
    enabled: Boolean(input?.brand_key && input.keyword),
    queryFn: ({ signal }) =>
      fetchJson<KeywordResearchResponse>("/api/customer/keywords/research", {
        method: "POST",
        body: {
          ...input,
          requestId: crypto.randomUUID(),
        },
        signal,
      }),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
}
