// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/usePrewarmSerpLocations.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useQuery } from "@tanstack/react-query";
import { keys } from "@/shared/query/keys";
import { fetchSerpLocations } from "./SerpLocationCombobox";

/**
 * Warm the server-side location cache before the first keystroke, so the
 * country list is hot when the user searches. Best-effort: a failed warm just
 * means the first search is slower, so no retries, and staleTime keeps one
 * warm per country per session. The route requires a query, so "a" stands in.
 */
export function usePrewarmSerpLocations(brandKey: string, countryCode: string, enabled: boolean) {
  useQuery({
    queryKey: keys.keywordLocations(brandKey, countryCode, "__prewarm__"),
    queryFn: () => fetchSerpLocations(brandKey, countryCode, "a").then(() => true),
    enabled: enabled && Boolean(brandKey),
    staleTime: Infinity,
    retry: false,
  });
}
