"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/components/DomainKeywordsTable.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useMemo } from "react";
import {
  createColumnHelper,
  type ColumnDef,
  type RowSelectionState,
} from "@tanstack/react-table";
import {
  DataTable,
  makeSelectionColumn,
  type DataTableFrameProps,
  useDataTable,
  useSelectionAnchor,
} from "@/components/app/table/DataTable";
import { ExternalUrlCell } from "@/components/app/table/ExternalUrlCell";
import { ScoreBadge } from "@/components/app/table/ScoreBadge";
import { SortableHeader } from "@/components/app/table/SortableHeader";
import { Button } from "@/components/ui/button";
import type { DomainSortMode, SortOrder } from "@/shared/domain";
import type { DomainKeywordItem } from "./hooks/useDomainKeywordsQuery";

type Props = DataTableFrameProps & {
  domain: string;
  rows: DomainKeywordItem[];
  selectedKeywords: Set<string>;
  visibleKeywords: string[];
  sortMode: DomainSortMode;
  currentSortOrder: SortOrder;
  isFiltered?: boolean;
  onClearFilters?: () => void;
  onSortClick: (sort: DomainSortMode) => void;
  onToggleKeyword: (keyword: string) => void;
};

const keywordColumnHelper = createColumnHelper<DomainKeywordItem>();

function formatNumber(value: number | null | undefined): string {
  if (value == null) return "-";
  return new Intl.NumberFormat().format(value);
}

function formatRounded(value: number | null | undefined): string {
  if (value == null) return "-";
  return new Intl.NumberFormat().format(Math.round(value));
}

function domainSortColumn(
  isActive: boolean,
  order: SortOrder,
  onClick: () => void,
) {
  return {
    getIsSorted: () => (isActive ? order : false),
    getToggleSortingHandler: () => onClick,
  };
}

export function DomainKeywordsTable({
  domain,
  rows,
  selectedKeywords,
  visibleKeywords,
  sortMode,
  currentSortOrder,
  isFiltered = false,
  onClearFilters,
  onSortClick,
  onToggleKeyword,
  ...frame
}: Props) {
  const selectAnchorRef = useSelectionAnchor();
  const rowSelection = useMemo<RowSelectionState>(
    () =>
      Object.fromEntries(
        [...selectedKeywords].map((keyword) => [keyword, true]),
      ) as RowSelectionState,
    [selectedKeywords],
  );

  const columns = useMemo<ColumnDef<DomainKeywordItem, any>[]>(
    () => [
      makeSelectionColumn<DomainKeywordItem>(selectAnchorRef),
      keywordColumnHelper.accessor("keyword", {
        header: () => "Keyword",
        cell: ({ getValue }) => (
          <span className="font-medium">{getValue()}</span>
        ),
      }),
      keywordColumnHelper.accessor("position", {
        header: () => (
          <SortableHeader
            label="Rank"
            column={domainSortColumn(
              sortMode === "rank",
              currentSortOrder,
              () => onSortClick("rank"),
            )}
          />
        ),
        cell: ({ getValue }) => getValue() ?? "-",
      }),
      keywordColumnHelper.accessor("searchVolume", {
        header: () => (
          <SortableHeader
            label="Volume"
            column={domainSortColumn(
              sortMode === "volume",
              currentSortOrder,
              () => onSortClick("volume"),
            )}
          />
        ),
        cell: ({ getValue }) => formatNumber(getValue()),
      }),
      keywordColumnHelper.accessor("traffic", {
        header: () => (
          <SortableHeader
            label="Traffic"
            column={domainSortColumn(
              sortMode === "traffic",
              currentSortOrder,
              () => onSortClick("traffic"),
            )}
          />
        ),
        cell: ({ getValue }) => formatRounded(getValue()),
      }),
      keywordColumnHelper.accessor("cpc", {
        header: () => (
          <SortableHeader
            label="CPC"
            helpText="Cost per click in USD."
            column={domainSortColumn(
              sortMode === "cpc",
              currentSortOrder,
              () => onSortClick("cpc"),
            )}
          />
        ),
        cell: ({ getValue }) => {
          const value = getValue();
          return value == null ? "-" : `$${value.toFixed(2)}`;
        },
      }),
      keywordColumnHelper.display({
        id: "url",
        header: () => "URL",
        cell: ({ row }) => (
          <ExternalUrlCell
            value={row.original.url || row.original.relativeUrl}
            label={row.original.relativeUrl ?? row.original.url ?? ""}
            baseDomain={domain}
          />
        ),
        meta: {
          cellClassName: "max-w-[260px] truncate",
        },
      }),
      keywordColumnHelper.accessor("keywordDifficulty", {
        header: () => (
          <SortableHeader
            label="Score"
            helpText="Organic ranking difficulty (0-100): higher means harder to reach Google's top 10."
            column={domainSortColumn(
              sortMode === "score",
              currentSortOrder,
              () => onSortClick("score"),
            )}
          />
        ),
        cell: ({ getValue }) => <ScoreBadge value={getValue()} />,
      }),
    ],
    [currentSortOrder, domain, onSortClick, selectAnchorRef, sortMode],
  );

  const tableData = useMemo(() => rows.slice(0, 200), [rows]);

  const table = useDataTable({
    data: tableData,
    columns,
    getRowId: (row) => row.keyword,
    state: { rowSelection },
    onRowSelectionChange: (updater) => {
      const next =
        typeof updater === "function" ? updater(rowSelection) : updater;
      // sync with parent selection
      for (const row of tableData) {
        const wasSelected = selectedKeywords.has(row.keyword);
        const isSelected = Boolean(next[row.keyword]);
        if (wasSelected !== isSelected) {
          onToggleKeyword(row.keyword);
        }
      }
    },
  });

  const emptyConfig = isFiltered
    ? {
        kind: "filtered" as const,
        title: "No keywords match these filters",
        action: onClearFilters ? (
          <Button variant="outline" size="sm" onClick={onClearFilters}>
            Clear filters
          </Button>
        ) : null,
      }
    : {
        kind: "no-data" as const,
        title: "No ranked keywords found for this target.",
      };

  return <DataTable table={table} empty={emptyConfig} {...frame} />;
}
