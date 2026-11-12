// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/hooks/useTimestampedSearchHistory.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { z } from "zod";
import { useTimestampedSearchHistory } from "@/components/app/hooks/useTimestampedSearchHistory";

const searchSchema = z.object({
  keyword: z.string().min(1),
  locationCode: z.number().int().positive(),
  locationName: z.string().nullable(),
});

export function useKeywordHistory(brandKey: string) {
  return useTimestampedSearchHistory({
    storageKey: `keywords-research:${brandKey}`,
    bodySchema: searchSchema,
    isSame: (a, b) => a.keyword.toLowerCase() === b.keyword.toLowerCase() && a.locationCode === b.locationCode,
  });
}
