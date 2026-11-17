// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/routes/_app/p/$projectId/saved.tsx
//   openseo:src/client/features/saved-keywords
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { usePortal } from "@/components/portal/PortalShell";
import { useUrlSearchState } from "@/components/app/hooks/useUrlSearchState";
import { useDebouncedFilters } from "@/components/app/hooks/useDebouncedFilters";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { keys, stableStringify } from "@/shared/query/keys";
import { filterValuesToSearch } from "@/shared/query/filterSearchParams";
import {
  EMPTY_SAVED_KEYWORDS_FILTERS,
  compileSavedKeywordsFilters,
  countActiveSavedKeywordsFilters,
  type SavedKeywordsFilterValues,
} from "@/shared/saved-keywords-filters";
import {
  SAVED_KEYWORD_PAGE_SIZES,
  type SavedKeywordRow,
  type SavedKeywordTagSummary,
} from "@/shared/keywords";

/** The sort keys the saved-keyword SQL accepts (migration 102). */
export const SAVED_KEYWORDS_SORT_KEYS = [
  "keyword",
  "searchVolume",
  "cpc",
  "competition",
  "keywordDifficulty",
  "fetchedAt",
] as const;

export type SavedKeywordsSortKey = (typeof SAVED_KEYWORDS_SORT_KEYS)[number];
export type SavedKeywordsPageSize = (typeof SAVED_KEYWORD_PAGE_SIZES)[number];

const savedKeywordsSearchSchema = z.object({
  include: z.string(),
  exclude: z.string(),
  minVol: z.string(),
  maxVol: z.string(),
  minCpc: z.string(),
  maxCpc: z.string(),
  minKd: z.string(),
  maxKd: z.string(),
  tags: z.string(),
  sort: z.enum(SAVED_KEYWORDS_SORT_KEYS),
  order: z.enum(["asc", "desc"]),
  page: z.number().int().positive(),
  size: z.union([z.literal(50), z.literal(100), z.literal(250)]),
});

export type SavedKeywordsSearchParams = z.infer<typeof savedKeywordsSearchSchema>;

const SAVED_KEYWORDS_SEARCH_DEFAULTS: SavedKeywordsSearchParams = {
  include: "",
  exclude: "",
  minVol: "",
  maxVol: "",
  minCpc: "",
  maxCpc: "",
  minKd: "",
  maxKd: "",
  tags: "",
  sort: "fetchedAt",
  order: "desc",
  page: 1,
  size: 50,
};

export type SavedKeywordsListResponse = {
  rows: SavedKeywordRow[];
  totalCount: number;
  page: number;
  pageSize: number;
  tags: SavedKeywordTagSummary[];
};

/** The filter strings as they appear in the URL. */
function filterValuesFrom(search: SavedKeywordsSearchParams): SavedKeywordsFilterValues {
  return {
    include: search.include,
    exclude: search.exclude,
    minVol: search.minVol,
    maxVol: search.maxVol,
    minCpc: search.minCpc,
    maxCpc: search.maxCpc,
    minKd: search.minKd,
    maxKd: search.maxKd,
  };
}

/** The list/export query, with empty numeric bounds omitted (never `minVol=`). */
export function buildSavedKeywordsQuery(search: SavedKeywordsSearchParams) {
  const filters = compileSavedKeywordsFilters(filterValuesFrom(search));
  const query: Record<string, string | number> = {
    page: search.page,
    size: search.size,
    sort: search.sort,
    order: search.order,
  };
  if (search.include.trim()) query.include = search.include.trim();
  if (search.exclude.trim()) query.exclude = search.exclude.trim();
  if (typeof filters.minVolume === "number") query.minVol = filters.minVolume;
  if (typeof filters.maxVolume === "number") query.maxVol = filters.maxVolume;
  if (typeof filters.minCpc === "number") query.minCpc = filters.minCpc;
  if (typeof filters.maxCpc === "number") query.maxCpc = filters.maxCpc;
  if (typeof filters.minDifficulty === "number") query.minKd = filters.minDifficulty;
  if (typeof filters.maxDifficulty === "number") query.maxKd = filters.maxDifficulty;
  if (search.tags) query.tags = search.tags;
  return query;
}

/** The export query: the list query without paging. */
export function buildSavedKeywordsExportQuery(search: SavedKeywordsSearchParams) {
  const { page: _page, size: _size, ...query } = buildSavedKeywordsQuery(search);
  return query;
}

export function selectedTagIdsFrom(search: { tags: string }): string[] {
  return search.tags.split(",").map((id) => id.trim()).filter(Boolean);
}

export function useSavedKeywordsQuery() {
  const { brandKey, features } = usePortal();
  const featureEnabled = features?.keyword_research === true;
  const [search, setParams] = useUrlSearchState(
    savedKeywordsSearchSchema,
    SAVED_KEYWORDS_SEARCH_DEFAULTS,
  );

  const {
    include,
    exclude,
    minVol,
    maxVol,
    minCpc,
    maxCpc,
    minKd,
    maxKd,
    tags,
    page,
    size,
    sort,
    order,
  } = search;

  const appliedFilters = useMemo(
    () =>
      filterValuesFrom({
        include,
        exclude,
        minVol,
        maxVol,
        minCpc,
        maxCpc,
        minKd,
        maxKd,
        tags,
        page,
        size,
        sort,
        order,
      }),
    [
      include,
      exclude,
      minVol,
      maxVol,
      minCpc,
      maxCpc,
      minKd,
      maxKd,
      tags,
      page,
      size,
      sort,
      order,
    ],
  );

  // Text edits land in the URL once, 350 ms after the last keystroke, and a
  // filter change always returns to page 1.
  const filters = useDebouncedFilters({
    applied: appliedFilters,
    empty: EMPTY_SAVED_KEYWORDS_FILTERS,
    commit: (next) => {
      setParams({
        ...filterValuesToSearch<SavedKeywordsSearchParams>(next),
        page: undefined,
      });
    },
  });

  const query = useMemo(
    () =>
      buildSavedKeywordsQuery({
        include,
        exclude,
        minVol,
        maxVol,
        minCpc,
        maxCpc,
        minKd,
        maxKd,
        tags,
        page,
        size,
        sort,
        order,
      }),
    [
      include,
      exclude,
      minVol,
      maxVol,
      minCpc,
      maxCpc,
      minKd,
      maxKd,
      tags,
      page,
      size,
      sort,
      order,
    ],
  );

  const list = useQuery({
    queryKey: keys.savedKeywords(brandKey, stableStringify(query)),
    enabled: Boolean(brandKey && featureEnabled),
    queryFn: ({ signal }) =>
      fetchJson<SavedKeywordsListResponse>(
        withBrand("/api/customer/keywords/saved", brandKey, query),
        { signal },
      ),
    // Only keep the previous page while the workspace is the same. A bare
    // `keepPreviousData` would also survive a brandKey change and show another
    // workspace's rows and tags while the new list loads (§6.6.3).
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey[1] === brandKey ? previousData : undefined,
    retry: false,
  });

  // A stale URL or a deletion past the end of the list must not strand the
  // reader on the "no saved keywords yet" state while rows still exist.
  useEffect(() => {
    const data = list.data;
    if (!data) return;
    if (search.page > 1 && data.totalCount > 0 && data.rows.length === 0) {
      setParams({ page: 1 });
    }
  }, [list.data, search.page, setParams]);

  const selectedTagIds = selectedTagIdsFrom(search);
  const activeFilterCount =
    countActiveSavedKeywordsFilters(appliedFilters) + (selectedTagIds.length > 0 ? 1 : 0);

  const setSort = (key: SavedKeywordsSortKey) => {
    setParams({
      sort: key,
      order: search.sort === key && search.order === "desc" ? "asc" : "desc",
      page: undefined,
    });
  };

  const toggleTag = (tagId: string) => {
    const next = selectedTagIds.includes(tagId)
      ? selectedTagIds.filter((id) => id !== tagId)
      : [...selectedTagIds, tagId];
    setParams({ tags: next.join(","), page: undefined });
  };

  // F06 filtered-empty "Clear filters" clears the filters and the tags.
  const clearFilters = () => {
    setParams({
      include: "",
      exclude: "",
      minVol: "",
      maxVol: "",
      minCpc: "",
      maxCpc: "",
      minKd: "",
      maxKd: "",
      tags: "",
      page: undefined,
    });
  };

  return {
    brandKey,
    featureEnabled,
    search,
    setParams,
    filters,
    appliedFilters,
    activeFilterCount,
    selectedTagIds,
    query,
    list,
    rows: list.data?.rows ?? [],
    totalCount: list.data?.totalCount ?? 0,
    tags: list.data?.tags ?? [],
    setSort,
    toggleTag,
    clearFilters,
    setPage: (page: number) => setParams({ page }),
    setPageSize: (size: SavedKeywordsPageSize) =>
      setParams({ size, page: undefined }),
  };
}
