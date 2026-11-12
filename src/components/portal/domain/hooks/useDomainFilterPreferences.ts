"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/useDomainFilterPreferences.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { useLocalPref } from "@/components/app/hooks/useLocalPref";
import {
  EMPTY_DOMAIN_FILTERS,
  EMPTY_PAGE_FILTERS,
  type KeywordsFilterValues,
  type PagesFilterValues,
} from "@/shared/domain";

const keywordFiltersPrefSchema = z.object({
  include: z.string().catch(""),
  exclude: z.string().catch(""),
  minTraffic: z.string().catch(""),
  maxTraffic: z.string().catch(""),
  minVol: z.string().catch(""),
  maxVol: z.string().catch(""),
  minCpc: z.string().catch(""),
  maxCpc: z.string().catch(""),
  minKd: z.string().catch(""),
  maxKd: z.string().catch(""),
  minRank: z.string().catch(""),
  maxRank: z.string().catch(""),
});

const pageFiltersPrefSchema = z.object({
  include: z.string().catch(""),
  exclude: z.string().catch(""),
  minTraffic: z.string().catch(""),
  maxTraffic: z.string().catch(""),
  minVol: z.string().catch(""),
  maxVol: z.string().catch(""),
});

export function useDomainFilterPreferences(brandKey: string, target: string) {
  const [keywordFilters, setKeywordFilters] = useLocalPref<KeywordsFilterValues>(
    `domain-filters:keywords:${target}`,
    keywordFiltersPrefSchema,
    EMPTY_DOMAIN_FILTERS,
    { brandKey },
  );

  const [pageFilters, setPageFilters] = useLocalPref<PagesFilterValues>(
    `domain-filters:pages:${target}`,
    pageFiltersPrefSchema,
    EMPTY_PAGE_FILTERS,
    { brandKey },
  );

  return {
    keywordFilters,
    saveKeywordFilters: setKeywordFilters,
    clearKeywordFilters: () => setKeywordFilters(EMPTY_DOMAIN_FILTERS),
    pageFilters,
    savePageFilters: setPageFilters,
    clearPageFilters: () => setPageFilters(EMPTY_PAGE_FILTERS),
  };
}
