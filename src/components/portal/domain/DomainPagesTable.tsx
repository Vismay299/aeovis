"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/domain/components/DomainPagesTable.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useMemo } from "react";
import { createColumnHelper, type ColumnDef } from "@tanstack/react-table";
import {
  DataTable,
  useDataTable,
  type DataTableFrameProps,
} from "@/components/app/table/DataTable";
import { ExternalUrlCell } from "@/components/app/table/ExternalUrlCell";
import { SortableHeader } from "@/components/app/table/SortableHeader";
import {
  toPageSortMode,
  type DomainSortMode,
  type SortOrder,
} from "@/shared/domain";
import type { DomainPageItem } from "./hooks/useDomainPagesQuery";

type Props = DataTableFrameProps & {
  domain: string;
  rows: DomainPageItem[];
  sortMode: DomainSortMode;
  currentSortOrder: SortOrder;
  onSortClick: (sort: DomainSortMode) => void;
};

const pageColumnHelper = createColumnHelper<DomainPageItem>();

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

export function DomainPagesTable({
  domain,
  rows,
  sortMode,
  currentSortOrder,
  onSortClick,
  ...frame
}: Props) {
  const columns = useMemo<ColumnDef<DomainPageItem, any>[]>(
    () => [
      pageColumnHelper.display({
        id: "page",
        header: () => "Page",
        cell: ({ row }) => (
          <ExternalUrlCell
            value={row.original.page}
            label={row.original.relativePath ?? row.original.page}
            baseDomain={domain}
          />
        ),
        meta: {
          cellClassName: "max-w-[420px] truncate",
        },
      }),
      pageColumnHelper.accessor("organicTraffic", {
        header: () => (
          <SortableHeader
            label="Organic Traffic"
            column={domainSortColumn(
              toPageSortMode(sortMode) === "traffic",
              currentSortOrder,
              () => onSortClick("traffic"),
            )}
          />
        ),
        cell: ({ getValue }) => formatRounded(getValue()),
      }),
      pageColumnHelper.accessor("keywords", {
        header: () => (
          <SortableHeader
            label="Keywords"
            column={domainSortColumn(
              toPageSortMode(sortMode) === "keywords",
              currentSortOrder,
              () => onSortClick("volume"),
            )}
          />
        ),
        cell: ({ getValue }) => formatNumber(getValue()),
      }),
    ],
    [currentSortOrder, domain, onSortClick, sortMode],
  );

  const tableData = useMemo(() => rows.slice(0, 100), [rows]);

  const table = useDataTable({
    data: tableData,
    columns,
  });

  return (
    <DataTable
      table={table}
      empty={{ kind: "no-data", title: "No pages match this search." }}
      {...frame}
    />
  );
}
