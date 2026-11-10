// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/keywords/services/research/helpers.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { KeywordIntent, KeywordResearchRow } from "../../shared/keywords.ts";

export type EnrichedKeyword = KeywordResearchRow;

export function normalizeKeyword(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * Alternates rows from two sources into one list, deduping by keyword, so a
 * volume-sorted source can't crowd out the other before the limit is reached.
 */
export function interleaveRows(
  first: EnrichedKeyword[],
  second: EnrichedKeyword[],
  limit: number,
): EnrichedKeyword[] {
  const rows: EnrichedKeyword[] = [];
  const seen = new Set<string>();
  const longest = Math.max(first.length, second.length);

  for (let i = 0; i < longest && rows.length < limit; i++) {
    for (const source of [first, second]) {
      const row = source[i];
      if (!row || seen.has(row.keyword) || rows.length >= limit) continue;
      seen.add(row.keyword);
      rows.push(row);
    }
  }

  return rows;
}

export function normalizeIntent(raw: string | null | undefined): KeywordIntent {
  if (!raw) return "unknown";
  const value = raw.toLowerCase();
  if (value.includes("inform")) return "informational";
  if (value.includes("commerc")) return "commercial";
  if (value.includes("transact")) return "transactional";
  if (value.includes("navig")) return "navigational";
  return "unknown";
}

export function toMetricUpsertRow(
  row: KeywordResearchRow,
  market: { locationCode: number; languageCode: string },
  source: "labs" | "google_ads" | "labs_ranked" = "labs",
) {
  return {
    keyword: row.keyword,
    location_code: market.locationCode,
    language_code: market.languageCode,
    search_volume: row.searchVolume,
    cpc: row.cpc,
    competition: row.competition,
    keyword_difficulty: row.keywordDifficulty,
    intent: row.intent,
    monthly_searches: row.trend ?? null,
    source,
  };
}
