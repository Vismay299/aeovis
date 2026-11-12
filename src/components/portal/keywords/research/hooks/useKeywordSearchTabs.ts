// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/search-tabs/useSearchTabs.ts
//   openseo:src/client/features/keywords/page/KeywordResearchPage.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useSearchTabs } from "@/components/app/search-tabs/useSearchTabs";

export type KeywordTabInput = { keyword: string; locationCode: number; locationName: string | null };

export function useKeywordSearchTabs(brandKey: string) {
  return useSearchTabs<KeywordTabInput>("keywords", brandKey, (raw) => {
    if (typeof raw !== "object" || raw === null) return null;
    const value = raw as Partial<KeywordTabInput>;
    if (typeof value.keyword !== "string" || !value.keyword.trim()) return null;
    if (typeof value.locationCode !== "number") return null;
    return { keyword: value.keyword, locationCode: value.locationCode, locationName: value.locationName ?? null };
  });
}
