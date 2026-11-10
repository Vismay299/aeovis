// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/keywords/services/research/selection.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { EnrichedKeyword } from "./helpers.ts";
import type {
  KeywordMode,
  KeywordSource,
  ResearchSource,
} from "../../shared/keywords.ts";

export type { KeywordMode, KeywordSource, ResearchSource };

export const MIN_NON_SEED_FOR_AUTO = 5;

export function countNonSeedKeywords(
  rows: EnrichedKeyword[],
  seedKeyword: string,
): number {
  const normalizedSeed = seedKeyword.trim().toLowerCase();
  return rows.filter((row) => row.keyword !== normalizedSeed).length;
}
