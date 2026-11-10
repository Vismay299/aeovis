// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/types/keywords.ts, src/client/features/keywords/keywordResearchTypes.ts,
//   src/client/features/keywords/state/keywordControllerActions.ts,
//   src/client/features/saved-keywords/savedKeywordsUtils.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { formatLocationLabel } from "./keyword-locations.ts";

export type KeywordIntent =
  | "informational"
  | "commercial"
  | "transactional"
  | "navigational"
  | "unknown";

export const KEYWORD_INTENT_ORDER: readonly KeywordIntent[] = [
  "informational",
  "commercial",
  "transactional",
  "navigational",
  "unknown",
] as const;

export const INTENT_LABELS: Record<KeywordIntent, string> = {
  informational: "Informational",
  commercial: "Commercial",
  transactional: "Transactional",
  navigational: "Navigational",
  unknown: "Unknown",
};

export type MonthlySearch = {
  year: number;
  month: number;
  searchVolume: number;
};

export type KeywordResearchRow = {
  keyword: string;
  searchVolume: number | null;
  trend: MonthlySearch[];
  keywordDifficulty: number | null;
  cpc: number | null;
  competition: number | null;
  intent: KeywordIntent;
};

export type ResearchSource =
  | "related"
  | "suggestions"
  | "ideas"
  | "google_ads"
  | "blended";

export type KeywordSource = "related" | "suggestions" | "ideas";
export type KeywordMode = "auto" | KeywordSource;

export type ResultLimit = 150 | 300 | 500;
export const RESULT_LIMITS: readonly ResultLimit[] = [150, 300, 500] as const;

export const MAX_KEYWORDS_PER_SUBMIT = 5;

export type SavedKeywordTag = {
  id: string;
  name: string;
  normalizedName: string;
  /** Palette key (e.g. "blue"). Null = derive a stable color from the id. */
  color: string | null;
};

export type SavedKeywordTagSummary = SavedKeywordTag & {
  keywordCount: number;
};

export type SavedKeywordRow = {
  id: string;
  keyword: string;
  locationCode: number;
  languageCode: string;
  createdAt: string;
  searchVolume: number | null;
  cpc: number | null;
  competition: number | null;
  keywordDifficulty: number | null;
  intent: string | null;
  monthlySearches: MonthlySearch[];
  fetchedAt: string | null;
  tags: SavedKeywordTag[];
};

export type SerpResultItem = {
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

export const SAVED_KEYWORD_PAGE_SIZES = [50, 100, 250] as const;
export const SAVED_KEYWORDS_CAP = 5000;
export const SAVED_KEYWORD_TAGS_CAP = 200;
export const METRICS_FRESH_DAYS = 7;

export type CsvValue = string | number | null | undefined;

/** Local exports name the area the volume, CPC, and competition cover. */
export function keywordResearchHeaders(locationName?: string): string[] {
  const scope = locationName ? ` (${formatLocationLabel(locationName)})` : "";
  return [
    "Keyword",
    `Volume${scope}`,
    `CPC${scope}`,
    `Competition${scope}`,
    "Score",
    "Intent",
  ];
}

export const KEYWORD_RESEARCH_HEADERS = keywordResearchHeaders();

export const SAVED_KEYWORD_EXPORT_HEADERS: string[] = [
  ...KEYWORD_RESEARCH_HEADERS,
  "Tags",
  "Fetched At",
];

export function keywordResearchExportRow(row: KeywordResearchRow): CsvValue[] {
  return [
    row.keyword,
    row.searchVolume ?? "",
    row.cpc ?? "",
    row.competition ?? "",
    row.keywordDifficulty ?? "",
    row.intent,
  ];
}

export function savedKeywordExportRow(row: SavedKeywordRow): CsvValue[] {
  return [
    row.keyword,
    row.searchVolume ?? "",
    row.cpc ?? "",
    row.competition ?? "",
    row.keywordDifficulty ?? "",
    row.intent ?? "",
    row.tags.map((tag) => tag.name).join(", "),
    row.fetchedAt ?? "",
  ];
}

/**
 * CSV downloads show CPC and competition (columns 3 and 4 of the keyword
 * headers, index 2 and 3) with two decimals. Sheets keeps raw numbers.
 */
export function formatCentsForCsv(rows: CsvValue[][]): CsvValue[][] {
  return rows.map((row) =>
    row.map((cell, idx) =>
      (idx === 2 || idx === 3) && typeof cell === "number"
        ? cell.toFixed(2)
        : cell,
    ),
  );
}
