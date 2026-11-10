// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/keywords/hooks/useKeywordFiltering.ts,
//   src/client/features/keywords/keywordResearchTypes.ts,
//   src/client/features/keywords/groupSharedVolumeRows.ts,
//   src/client/features/keywords/page/KeywordResearchPagination.tsx,
//   src/client/features/keywords/utils.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { KeywordIntent, KeywordResearchRow, MonthlySearch } from "./keywords.ts";
import { KEYWORD_INTENT_ORDER } from "./keywords.ts";

export type KeywordFilterValues = {
  include: string;
  exclude: string;
  minVol: string;
  maxVol: string;
  minCpc: string;
  maxCpc: string;
  minKd: string;
  maxKd: string;
  /**
   * Selected search intents, stored as a comma-separated string (e.g.
   * "transactional,commercial"). Empty = no intent filter.
   */
  intents: string;
};

export const EMPTY_FILTERS: KeywordFilterValues = {
  include: "",
  exclude: "",
  minVol: "",
  maxVol: "",
  minCpc: "",
  maxCpc: "",
  minKd: "",
  maxKd: "",
  intents: "",
};

const KEYWORD_INTENT_SET = new Set<string>(KEYWORD_INTENT_ORDER);

/** Parses the stored intents string into a list of valid, de-duplicated intents. */
export function parseIntentFilter(value: string): KeywordIntent[] {
  if (!value) return [];
  const selected = new Set(
    value
      .split(",")
      .map((part) => part.trim())
      .filter((part): part is KeywordIntent => KEYWORD_INTENT_SET.has(part)),
  );
  return KEYWORD_INTENT_ORDER.filter((intent) => selected.has(intent));
}

/** Toggles one intent in the stored string, preserving canonical order. */
export function toggleIntentFilter(
  value: string,
  intent: KeywordIntent,
): string {
  const selected = new Set(parseIntentFilter(value));
  if (selected.has(intent)) {
    selected.delete(intent);
  } else {
    selected.add(intent);
  }
  return KEYWORD_INTENT_ORDER.filter((item) => selected.has(item)).join(",");
}

export function parseTerms(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[,+]/)
    .map((term) => term.trim())
    .filter(Boolean);
}

export type SortField =
  | "keyword"
  | "searchVolume"
  | "cpc"
  | "competition"
  | "keywordDifficulty";

export type SortDir = "asc" | "desc";

export function applyKeywordFiltersAndSort(params: {
  rows: KeywordResearchRow[];
  filters: KeywordFilterValues;
  sortField: SortField;
  sortDir: SortDir;
}): KeywordResearchRow[] {
  const includeTerms = parseTerms(params.filters.include);
  const excludeTerms = parseTerms(params.filters.exclude);
  const selectedIntents = parseIntentFilter(params.filters.intents);

  const filtered = params.rows.filter((row) => {
    const haystack = row.keyword.toLowerCase();
    if (
      includeTerms.length > 0 &&
      !includeTerms.every((term) => haystack.includes(term))
    ) {
      return false;
    }
    if (excludeTerms.some((term) => haystack.includes(term))) {
      return false;
    }

    if (selectedIntents.length > 0 && !selectedIntents.includes(row.intent)) {
      return false;
    }

    const vol = row.searchVolume ?? 0;
    const cpc = row.cpc ?? 0;
    const kd = row.keywordDifficulty ?? 0;

    if (params.filters.minVol && vol < Number(params.filters.minVol))
      return false;
    if (params.filters.maxVol && vol > Number(params.filters.maxVol))
      return false;
    if (params.filters.minCpc && cpc < Number(params.filters.minCpc))
      return false;
    if (params.filters.maxCpc && cpc > Number(params.filters.maxCpc))
      return false;
    if (params.filters.minKd && kd < Number(params.filters.minKd)) return false;
    if (params.filters.maxKd && kd > Number(params.filters.maxKd)) return false;
    return true;
  });

  const sorted = [...filtered];
  const dir = params.sortDir === "asc" ? 1 : -1;

  sorted.sort((a, b) => {
    if (params.sortField === "keyword") {
      const cmp = a.keyword.localeCompare(b.keyword);
      return cmp !== 0 ? cmp * dir : 0;
    }

    let valA: number;
    let valB: number;
    if (params.sortField === "searchVolume") {
      valA = a.searchVolume ?? -1;
      valB = b.searchVolume ?? -1;
    } else if (params.sortField === "cpc") {
      valA = a.cpc ?? -1;
      valB = b.cpc ?? -1;
    } else if (params.sortField === "competition") {
      valA = a.competition ?? -1;
      valB = b.competition ?? -1;
    } else {
      valA = a.keywordDifficulty ?? -1;
      valB = b.keywordDifficulty ?? -1;
    }

    if (valA !== valB) {
      return (valA - valB) * dir;
    }
    return a.keyword.localeCompare(b.keyword);
  });

  return sorted;
}

/** A visible keyword row, optionally indented beneath a shared-volume parent. */
export type KeywordResearchDisplayRow = KeywordResearchRow & {
  parentKeyword: string | null;
};

// Only group above this volume: bucketed low volumes (10, 20, ...) collide by
// coincidence, while real close-variant groups share big grouped numbers.
const SHARED_VOLUME_MIN = 1000;

function sharedVolumeKey(row: KeywordResearchRow): string | null {
  if (row.searchVolume == null || row.searchVolume < SHARED_VOLUME_MIN) {
    return null;
  }
  // A flat series is a bucketed placeholder, not a fingerprint, so two
  // unrelated keywords could share it by coincidence.
  if (new Set(row.trend.map((entry) => entry.searchVolume)).size <= 1) {
    return null;
  }
  const series = row.trend
    .map((entry) => `${entry.year}-${entry.month}:${entry.searchVolume}`)
    .join(",");
  return `${row.searchVolume}|${row.cpc}|${series}`;
}

/**
 * Google Ads reports one volume for a whole close-variant group ("caregiving"
 * / "caregiver" / "caregivers"), so those rows all claim the same searches.
 * Place rows with an identical volume, CPC, and monthly series after the
 * searched keyword when it is in the group, otherwise under the first one in
 * the given order. Display only: every keyword keeps its own metrics
 * when grouping is enabled. With grouping off, preserve the input order.
 */
export function groupSharedVolumeRows(
  rows: KeywordResearchRow[],
  searchedKeyword: string | undefined,
  groupKeywords: boolean,
): KeywordResearchDisplayRow[] {
  if (!groupKeywords) {
    return rows.map((row) => ({ ...row, parentKeyword: null }));
  }
  // Row keywords are lowercase; the searched keyword arrives as typed.
  const seed = searchedKeyword?.trim().toLowerCase();
  const groups = new Map<string, KeywordResearchRow[]>();
  const result: KeywordResearchRow[][] = [];

  for (const row of rows) {
    const key = sharedVolumeKey(row);
    const group = key ? groups.get(key) : undefined;
    if (group) {
      if (row.keyword === seed) group.unshift(row);
      else group.push(row);
      continue;
    }
    const newGroup = [row];
    if (key) groups.set(key, newGroup);
    result.push(newGroup);
  }

  return result.flatMap((group) =>
    group.map((row, index) => ({
      ...row,
      parentKeyword: index === 0 ? null : group[0].keyword,
    })),
  );
}

export function keywordResearchPageEnds(
  rows: KeywordResearchDisplayRow[],
  pageSize: number,
): number[] {
  const ends: number[] = [];
  for (let start = 0; start < rows.length; ) {
    let end = Math.min(start + pageSize, rows.length);
    // Finish the last family before starting the next page.
    while (end < rows.length && rows[end].parentKeyword !== null) end++;
    ends.push(end);
    start = end;
  }
  return ends;
}

/** The most recent 12 months of a trend, oldest first. */
export function lastTwelveMonths(trend: MonthlySearch[]): MonthlySearch[] {
  return [...trend]
    .sort((a, b) => a.year * 100 + a.month - (b.year * 100 + b.month))
    .slice(-12);
}

export function formatNumber(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat().format(value);
}

export function formatCompactNumber(value: number | null | undefined): string {
  if (value == null) return "—";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
