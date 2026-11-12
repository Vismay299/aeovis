"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/backlinks/BacklinksTable.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useMemo } from "react";
import type { OnChangeFn, Row, SortingState } from "@tanstack/react-table";
import {
  DataTable,
  useDataTable,
  type DataTableFrameProps,
} from "@/components/app/table/DataTable";
import {
  buildBacklinksColumns,
  type BacklinksDisplayRow,
  type DomainRatings,
} from "./BacklinksTableColumns";
import type { BacklinksRow } from "@/shared/backlinks";
import type { BacklinksDomainExpansion } from "./hooks/useBacklinksDomainExpansion";

function buildDisplayRows(
  rows: BacklinksRow[],
  expansion: BacklinksDomainExpansion | null,
): BacklinksDisplayRow[] {
  if (!expansion) {
    return rows.map((row) => ({
      kind: "link",
      row,
      depth: 0,
      expandable: false,
      expanded: false,
    }));
  }

  const out: BacklinksDisplayRow[] = [];
  for (const row of rows) {
    const domain = row.domainFrom;
    const expanded = Boolean(domain && expansion.expandedDomains.has(domain));
    out.push({
      kind: "link",
      row,
      depth: 0,
      expandable: Boolean(domain),
      expanded,
    });
    if (!expanded || !domain) continue;

    const entry = expansion.entriesByDomain[domain];
    if (!entry || entry.status === "loading") {
      out.push({ kind: "status", domain, status: "loading" });
    } else if (entry.status === "error") {
      out.push({ kind: "status", domain, status: "error" });
    } else {
      const children = entry.rows.filter(
        (child) =>
          !(
            child.urlFrom === row.urlFrom &&
            child.urlTo === row.urlTo &&
            child.anchor === row.anchor
          ),
      );
      if (children.length === 0) {
        out.push({ kind: "status", domain, status: "empty" });
      } else {
        for (const child of children) {
          out.push({
            kind: "link",
            row: child,
            depth: 1,
            expandable: false,
            expanded: false,
          });
        }
      }
    }
  }
  return out;
}

function tintExpandedRow(row: Row<BacklinksDisplayRow>) {
  const displayRow = row.original;
  return displayRow.kind !== "link" || displayRow.depth > 0
    ? "bg-muted/50"
    : undefined;
}

export function BacklinksTable({
  rows,
  domainRatings,
  sorting,
  onSortingChange,
  expansion,
  ...frame
}: DataTableFrameProps & {
  rows: BacklinksRow[];
  domainRatings?: DomainRatings | null;
  sorting: SortingState;
  onSortingChange: OnChangeFn<SortingState>;
  expansion: BacklinksDomainExpansion | null;
}) {
  const columns = useMemo(
    () =>
      buildBacklinksColumns(domainRatings, expansion?.toggleDomain).map(
        (column) => ({
          ...column,
          meta: { ...column.meta, cellClassName: tintExpandedRow },
        }),
      ),
    [domainRatings, expansion?.toggleDomain],
  );
  const displayRows = useMemo(
    () => buildDisplayRows(rows, expansion),
    [rows, expansion],
  );

  const table = useDataTable({
    data: displayRows,
    columns,
    state: { sorting },
    onSortingChange,
    manualSorting: true,
  });

  return (
    <DataTable
      table={table}
      empty={{ title: "No backlinks found for this target." }}
      {...frame}
    />
  );
}
