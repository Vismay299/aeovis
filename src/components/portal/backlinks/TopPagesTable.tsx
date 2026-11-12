"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/backlinks/TopPagesTable.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { createColumnHelper } from "@tanstack/react-table";
import type { OnChangeFn, SortingState } from "@tanstack/react-table";
import { SafeExternalLink } from "@/components/app/SafeExternalLink";
import {
  DataTable,
  useDataTable,
  type DataTableFrameProps,
} from "@/components/app/table/DataTable";
import { SortableHeader } from "@/components/app/table/SortableHeader";
import { HelpLabel } from "@/components/app/HelpLabel";
import type { TopPageRow, TopPagesSortField } from "@/shared/backlinks";
import { formatNumber } from "@/shared/backlinks";

const columnHelper = createColumnHelper<TopPageRow>();

const columns = [
  columnHelper.accessor("page", {
    id: "page",
    enableSorting: false,
    meta: { cellClassName: "min-w-80" },
    header: () => (
      <HelpLabel
        label="Page"
        helpText="Page on the target site receiving backlinks."
      />
    ),
    cell: ({ getValue }) => {
      const page = getValue();
      return page ? (
        <SafeExternalLink
          url={page}
          label={page}
          className="inline-flex items-center gap-1 break-all underline-offset-4 hover:underline"
        />
      ) : (
        "—"
      );
    },
  }),
  columnHelper.accessor("backlinks", {
    id: "backlinks" satisfies TopPagesSortField,
    header: ({ column }) => (
      <SortableHeader
        column={column}
        label="Backlinks"
        helpText="Total backlinks pointing to this page."
      />
    ),
    cell: ({ getValue }) => formatNumber(getValue()),
    sortDescFirst: true,
  }),
  columnHelper.accessor("referringDomains", {
    id: "referringDomains" satisfies TopPagesSortField,
    header: ({ column }) => (
      <SortableHeader
        column={column}
        label="Referring Domains"
        helpText="Unique domains linking to this page."
      />
    ),
    cell: ({ getValue }) => formatNumber(getValue()),
    sortDescFirst: true,
  }),
  columnHelper.accessor("rank", {
    id: "rank" satisfies TopPagesSortField,
    header: ({ column }) => (
      <SortableHeader
        column={column}
        label="Rank"
        helpText="Authority score for this target page."
      />
    ),
    cell: ({ getValue }) => formatNumber(getValue()),
    sortDescFirst: true,
  }),
  columnHelper.accessor("brokenBacklinks", {
    id: "brokenBacklinks" satisfies TopPagesSortField,
    header: ({ column }) => (
      <SortableHeader
        column={column}
        label="Broken Backlinks"
        helpText="Backlinks pointing here that are currently broken."
      />
    ),
    cell: ({ getValue }) => formatNumber(getValue()),
    sortDescFirst: true,
  }),
];

export function TopPagesTable({
  rows,
  sorting,
  onSortingChange,
  ...frame
}: DataTableFrameProps & {
  rows: TopPageRow[];
  sorting: SortingState;
  onSortingChange: OnChangeFn<SortingState>;
}) {
  const table = useDataTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange,
    manualSorting: true,
  });

  return (
    <DataTable
      table={table}
      empty={{ title: "No top pages found for this target." }}
      {...frame}
    />
  );
}
