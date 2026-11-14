"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { QueryError } from "@/components/app/QueryState";
import { DataTable, useDataTable } from "@/components/app/table/DataTable";
import { ExternalUrlCell } from "@/components/app/table/ExternalUrlCell";
import { TablePagination } from "@/components/app/table/TablePagination";
import { ExportMenu } from "@/components/app/ExportMenu";
import { useExportRows } from "@/components/app/export/useExportRows";
import { Ga4ErrorState } from "./Ga4ErrorState";
import { LimitedDataNotice } from "./LimitedDataNotice";
import { useGa4Report } from "./hooks/useGa4Report";

type PageRow = Record<string, string | number | null>;

function num(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value).toLocaleString()
    : "—";
}

function avgEngagement(row: PageRow): string {
  const duration = row.userEngagementDuration;
  const users = row.activeUsers;
  if (typeof duration !== "number" || typeof users !== "number" || users === 0) {
    return "—";
  }
  const seconds = duration / users;
  if (!Number.isFinite(seconds)) return "—";
  return `${seconds.toFixed(1)}s`;
}

/** Pages tab (§6.6.3) with the "By day" toggle. */
export function PagesTab({
  brandKey,
  range,
  canManage,
}: {
  brandKey: string;
  range: string;
  canManage: boolean;
}) {
  const [byDay, setByDay] = useState(false);
  const [offset, setOffset] = useState(0);
  const query = useGa4Report(brandKey, "page_performance", {
    range,
    limit: 100,
    offset,
    ...(byDay ? { includeDate: true } : {}),
  });
  const exportRows = useExportRows();
  const data = query.data as unknown as
    | {
        rows?: PageRow[];
        reportMetadata?: { hasLimitedData?: boolean };
        pageInfo?: { hasMore?: boolean };
        totalRowCount?: number;
      }
    | undefined;

  const rows = data?.rows ?? [];
  const hasLimitedData = data?.reportMetadata?.hasLimitedData === true;

  const columns: ColumnDef<PageRow>[] = [
    {
      id: "pagePath",
      header: "Page path",
      cell: ({ row }) => {
        const host = String(row.original.hostName ?? "");
        const path = String(row.original.pagePath ?? "");
        const value = host ? `https://${host}${path}` : path;
        return <ExternalUrlCell value={value} label={path || value} />;
      },
    },
    ...(byDay
      ? [
          {
            id: "date",
            header: "Date",
            cell: ({ row }: { row: { original: PageRow } }) => (
              <span className="tabular-nums">
                {typeof row.original.date === "string" &&
                /^\d{8}$/.test(row.original.date)
                  ? `${row.original.date.slice(0, 4)}-${row.original.date.slice(4, 6)}-${row.original.date.slice(6, 8)}`
                  : (row.original.date ?? "—")}
              </span>
            ),
          } satisfies ColumnDef<PageRow>,
        ]
      : []),
    { id: "screenPageViews", header: "Views", cell: ({ row }) => <span className="tabular-nums">{num(row.original.screenPageViews)}</span> },
    { id: "activeUsers", header: "Active users", cell: ({ row }) => <span className="tabular-nums">{num(row.original.activeUsers)}</span> },
    { id: "avgEngagement", header: "Avg. engagement time", cell: ({ row }) => <span className="tabular-nums">{avgEngagement(row.original)}</span> },
    { id: "keyEvents", header: "Key events", cell: ({ row }) => <span className="tabular-nums">{num(row.original.keyEvents)}</span> },
  ];

  const table = useDataTable<PageRow>({
    data: rows,
    columns,
    getRowId: (row, index) =>
      `${row.hostName ?? ""}${row.pagePath ?? ""}${row.date ?? ""}${index}`,
  });

  if (query.isPending) return null;
  if (query.isError && !query.data) {
    return (
      <Ga4ErrorState
        error={query.error}
        canManage={canManage}
        onRetry={() => void query.refetch()}
        isRetrying={query.isFetching}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="px-4 pt-1">
        {query.isError ? (
          <QueryError
            error={query.error}
            fallback="Couldn't load this report from Google Analytics."
            onRetry={() => void query.refetch()}
            isRetrying={query.isFetching}
          />
        ) : null}
      </div>
      {hasLimitedData ? (
        <div className="px-4"><LimitedDataNotice /></div>
      ) : null}
      <DataTable
        table={table}
        isLoading={query.isPending}
        empty={{ title: "No page views recorded in this period." }}
        toolbar={
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-2">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <Checkbox
                  checked={byDay}
                  onCheckedChange={(checked) => {
                    setByDay(checked === true);
                    setOffset(0);
                  }}
                  aria-label="By day"
                />
                By day
              </label>
              {query.isFetching ? <Spinner className="size-3.5" aria-label="Refreshing" /> : null}
            </div>
            <ExportMenu
              actions={["sheets", "csv", "excel", "json"]}
              disabled={rows.length === 0}
              onExport={(action) =>
                void exportRows({
                  format: action,
                  feature: "ga4_page_performance",
                  headers: byDay
                    ? ["Page path", "Date", "Views", "Active users", "Avg. engagement time", "Key events"]
                    : ["Page path", "Views", "Active users", "Avg. engagement time", "Key events"],
                  rows: rows.map((row) => {
                    const base: (string | number | null)[] = [
                      `${row.hostName ?? ""}${row.pagePath ?? ""}`,
                    ];
                    if (byDay) base.push((row.date as string) ?? null);
                    return [
                      ...base,
                      row.screenPageViews,
                      row.activeUsers,
                      avgEngagement(row),
                      row.keyEvents,
                    ];
                  }),
                  filename: `${brandKey}-analytics-pages`,
                  records: rows,
                })
              }
            />
          </div>
        }
        footer={
          (data?.pageInfo?.hasMore || (data?.totalRowCount ?? 0) > rows.length) ? (
            <TablePagination
              page={Math.floor(offset / 100) + 1}
              pageSize={100}
              totalCount={data?.totalRowCount ?? null}
              hasNextPage={data?.pageInfo?.hasMore}
              isLoading={query.isFetching}
              onPageChange={(page) => setOffset((page - 1) * 100)}
            />
          ) : undefined
        }
      />
    </div>
  );
}
