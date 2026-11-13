// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/results/ResultsTables.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 4 — the Performance tab: one row per Lighthouse run.

import Link from "next/link";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { DataTable, useDataTable } from "@/components/app/table/DataTable";
import { ExternalUrlCell } from "@/components/app/table/ExternalUrlCell";
import { QueryError } from "@/components/app/QueryState";
import type { AuditPerformanceRow } from "../hooks/useAuditPerformance";
import { formatCls, formatMs, formatScore, pathOf, scoreClass } from "../shared";

export function PerformanceTable({
  auditId,
  rows,
  isLoading,
  isError,
  error,
  onRetry,
  isRetrying,
}: {
  auditId: string;
  rows: AuditPerformanceRow[];
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  isRetrying: boolean;
}) {
  const columns: ColumnDef<AuditPerformanceRow>[] = [
    {
      accessorKey: "pageUrl",
      header: "URL",
      cell: ({ row }) => (
        <ExternalUrlCell
          value={row.original.pageUrl}
          label={pathOf(row.original.pageUrl)}
        />
      ),
    },
    {
      accessorKey: "strategy",
      header: "Device",
      cell: ({ row }) => (
        <span className="capitalize">{row.original.strategy}</span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) =>
        row.original.errorMessage ? (
          <span title={row.original.errorMessage}>
            <Badge variant="destructive">Failed</Badge>
          </span>
        ) : (
          <Badge variant="success">OK</Badge>
        ),
    },
    {
      accessorKey: "performanceScore",
      header: "Perf",
      cell: ({ row }) => (
        <span className={scoreClass(row.original.performanceScore)}>
          {formatScore(row.original.performanceScore)}
        </span>
      ),
    },
    {
      accessorKey: "accessibilityScore",
      header: "A11y",
      cell: ({ row }) => (
        <span className={scoreClass(row.original.accessibilityScore)}>
          {formatScore(row.original.accessibilityScore)}
        </span>
      ),
    },
    {
      accessorKey: "seoScore",
      header: "SEO",
      cell: ({ row }) => (
        <span className={scoreClass(row.original.seoScore)}>
          {formatScore(row.original.seoScore)}
        </span>
      ),
    },
    {
      accessorKey: "lcpMs",
      header: "LCP",
      cell: ({ row }) => formatMs(row.original.lcpMs),
    },
    {
      accessorKey: "cls",
      header: "CLS",
      cell: ({ row }) => formatCls(row.original.cls),
    },
    {
      accessorKey: "inpMs",
      header: "INP",
      cell: ({ row }) => formatMs(row.original.inpMs),
    },
    {
      accessorKey: "ttfbMs",
      header: "TTFB",
      cell: ({ row }) => formatMs(row.original.ttfbMs),
    },
    {
      id: "issues",
      header: "Issues",
      cell: ({ row }) =>
        row.original.hasDetails ? (
          <Link
            href={`/portal/audit/${auditId}/lighthouse/${row.original.id}`}
            className="text-primary underline-offset-4 hover:underline"
          >
            View
          </Link>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];

  const table = useDataTable<AuditPerformanceRow>({
    data: rows,
    columns,
    getRowId: (row) => row.id,
  });

  return (
    <DataTable
      table={table}
      isLoading={isLoading}
      error={
        isError ? (
          <QueryError
            error={error}
            fallback="Couldn't load the performance results."
            onRetry={onRetry}
            isRetrying={isRetrying}
          />
        ) : undefined
      }
      empty={{
        title: "No Lighthouse results",
        description: "This audit did not run Lighthouse checks.",
      }}
    />
  );
}
