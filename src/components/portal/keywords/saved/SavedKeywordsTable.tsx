// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/saved-keywords
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Copy, Trash2 } from "lucide-react";
import { EmptyState } from "@/components/app/EmptyState";
import { RowActionsMenu } from "@/components/app/RowActionsMenu";
import { SkeletonTableRows } from "@/components/app/SkeletonPresets";
import { ScoreBadge } from "@/components/app/table/ScoreBadge";
import { TablePagination } from "@/components/app/table/TablePagination";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { formatUsd } from "@/shared/money";
import {
  SAVED_KEYWORD_PAGE_SIZES,
  type SavedKeywordRow,
  type SavedKeywordTagSummary,
} from "@/shared/keywords";
import { SavedKeywordsFilters } from "./SavedKeywordsFilters";
import { TagChip } from "./TagChip";
import { IntentBadge } from "../research/IntentBadge";
import type {
  SavedKeywordsPageSize,
  SavedKeywordsSortKey,
} from "./hooks/useSavedKeywordsQuery";
import type { TagManageController } from "./hooks/useTagManage";
import type { SavedKeywordsFilterValues } from "@/shared/saved-keywords-filters";
import { cn } from "@/lib/utils";

function unknownNumber(value: number | null) {
  return value == null ? "—" : value.toLocaleString();
}

function ariaSort(
  active: boolean,
  order: "asc" | "desc",
): "ascending" | "descending" | "none" {
  if (!active) return "none";
  return order === "asc" ? "ascending" : "descending";
}

const COLUMNS = [
  { key: "keyword", label: "Keyword", aria: "Sort by keyword" },
  { key: "searchVolume", label: "Volume", aria: "Sort by volume" },
  { key: "cpc", label: "CPC", aria: "Sort by CPC" },
  { key: "competition", label: "Competition", aria: "Sort by competition" },
  { key: "keywordDifficulty", label: "Difficulty", aria: "Sort by difficulty" },
  { key: "fetchedAt", label: "Last Fetched", aria: "Sort by last fetched" },
] as const;

export function SavedKeywordsTable({
  rows,
  totalCount,
  page,
  pageSize,
  sort,
  order,
  isLoading,
  isFiltered,
  selectedIds,
  filters,
  activeFilterCount,
  tags,
  selectedTagIds,
  manage,
  error,
  onFilterChange,
  onClearFilters,
  onToggleTag,
  onClearTags,
  onSort,
  onPage,
  onPageSize,
  onToggleRow,
  onToggleAll,
  onCopyRow,
  onDeleteRow,
}: {
  rows: SavedKeywordRow[];
  totalCount: number;
  page: number;
  pageSize: SavedKeywordsPageSize;
  sort: SavedKeywordsSortKey;
  order: "asc" | "desc";
  isLoading: boolean;
  isFiltered: boolean;
  selectedIds: readonly string[];
  filters: SavedKeywordsFilterValues;
  activeFilterCount: number;
  tags: SavedKeywordTagSummary[];
  selectedTagIds: string[];
  manage: TagManageController;
  error?: ReactNode;
  onFilterChange: (
    key: keyof SavedKeywordsFilterValues,
    next: string,
  ) => void;
  onClearFilters: () => void;
  onToggleTag: (tagId: string) => void;
  onClearTags: () => void;
  onSort: (key: SavedKeywordsSortKey) => void;
  onPage: (page: number) => void;
  onPageSize: (size: SavedKeywordsPageSize) => void;
  onToggleRow: (row: SavedKeywordRow) => void;
  onToggleAll: (rows: SavedKeywordRow[], selected: boolean) => void;
  onCopyRow: (row: SavedKeywordRow) => void;
  onDeleteRow: (row: SavedKeywordRow) => void;
}) {
  const pageRows = rows;
  const allSelected =
    pageRows.length > 0 && pageRows.every((row) => selectedIds.includes(row.id));

  return (
    <Card className="min-w-0">
      <SavedKeywordsFilters
        value={filters}
        activeCount={activeFilterCount}
        onChange={onFilterChange}
        onClear={onClearFilters}
        tags={tags}
        selectedTagIds={selectedTagIds}
        onToggleTag={onToggleTag}
        onClearTags={onClearTags}
        manage={manage}
      />
      {error ? <div className="p-4">{error}</div> : null}
      {isLoading ? (
        <div className="p-4">
          <SkeletonTableRows rows={8} columns={9} />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-6">
          {isFiltered ? (
            <EmptyState
              kind="filtered"
              variant="plain"
              title="No rows match these filters"
              description="Change or clear the filters to see more rows."
              action={
                <Button variant="outline" size="sm" onClick={onClearFilters}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              variant="plain"
              title="No saved keywords yet"
              description="Use Keyword Research to find and save keywords."
              action={
                <Link
                  href="/portal/keywords"
                  className={cn(buttonVariants())}
                >
                  Open Keyword Research
                </Link>
              }
            />
          )}
        </div>
      ) : (
        <>
          <div className="w-full overflow-x-auto">
            <table className="w-full min-w-[56rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border text-muted-foreground">
                  <th className="w-10 p-3">
                    <Checkbox
                      aria-label="Select all keywords"
                      checked={allSelected}
                      indeterminate={selectedIds.length > 0 && !allSelected}
                      onCheckedChange={(checked) =>
                        onToggleAll(pageRows, Boolean(checked))
                      }
                    />
                  </th>
                  {COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      className={cn(
                        "p-3 font-medium whitespace-nowrap",
                        ["searchVolume", "cpc", "competition", "keywordDifficulty"].includes(
                          column.key,
                        ) && "tabular-nums",
                      )}
                      aria-sort={ariaSort(sort === column.key, order)}
                    >
                      <button
                        type="button"
                        className="font-medium transition-colors hover:text-foreground"
                        aria-label={column.aria}
                        onClick={() => onSort(column.key)}
                      >
                        {column.label}
                      </button>
                    </th>
                  ))}
                  <th className="p-3 font-medium">Intent</th>
                  <th className="p-3 font-medium">Tags</th>
                  <th className="p-3 font-medium">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.id}
                    data-state={selectedIds.includes(row.id) ? "selected" : undefined}
                    className="border-b border-border last:border-0 data-[state=selected]:bg-primary/5"
                  >
                    <td className="p-3">
                      <Checkbox
                        aria-label={`Select ${row.keyword}`}
                        checked={selectedIds.includes(row.id)}
                        onCheckedChange={() => onToggleRow(row)}
                      />
                    </td>
                    <td className="p-3 font-medium">{row.keyword}</td>
                    <td className="p-3 tabular-nums">
                      {unknownNumber(row.searchVolume)}
                    </td>
                    <td className="p-3 tabular-nums">
                      {row.cpc == null ? "—" : formatUsd(row.cpc)}
                    </td>
                    <td className="p-3 tabular-nums">
                      {unknownNumber(row.competition)}
                    </td>
                    <td className="p-3">
                      <ScoreBadge value={row.keywordDifficulty} />
                    </td>
                    <td className="p-3">
                      {row.fetchedAt ? (
                        new Date(row.fetchedAt).toLocaleDateString()
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="p-3">
                      <IntentBadge intent={row.intent} />
                    </td>
                    <td className="p-3">
                      {row.tags.length > 0 ? (
                        <div className="flex max-w-56 flex-wrap gap-1">
                          {row.tags.map((tag) => (
                            <TagChip key={tag.id} tag={tag} />
                          ))}
                        </div>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="p-3 text-right">
                      <RowActionsMenu label={`Actions for ${row.keyword}`}>
                        <DropdownMenuItem onClick={() => onCopyRow(row)}>
                          <Copy />
                          Copy keyword
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => onDeleteRow(row)}
                        >
                          <Trash2 />
                          Delete
                        </DropdownMenuItem>
                      </RowActionsMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <TablePagination
            page={page}
            pageSize={pageSize}
            pageSizes={SAVED_KEYWORD_PAGE_SIZES}
            totalCount={totalCount}
            onPageChange={onPage}
            onPageSizeChange={onPageSize}
          />
        </>
      )}
    </Card>
  );
}
