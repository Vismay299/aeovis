"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { QueryError } from "@/components/app/QueryState";
import { DataTable, useDataTable } from "@/components/app/table/DataTable";
import { TablePagination } from "@/components/app/table/TablePagination";
import { ExportMenu } from "@/components/app/ExportMenu";
import { useExportRows } from "@/components/app/export/useExportRows";
import { Ga4ErrorState } from "./Ga4ErrorState";
import { LimitedDataNotice } from "./LimitedDataNotice";
import { useGa4Report } from "./hooks/useGa4Report";

type EventRow = Record<string, string | number | null>;

type ComparisonEntry = {
  dimensions: Record<string, string | number | null>;
  metrics: Record<string, { current?: number | null; previous?: number | null; percentChange?: number | null }>;
};

function num(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value).toLocaleString()
    : "—";
}

function changeText(percentChange: number | null | undefined): string {
  if (percentChange == null || !Number.isFinite(percentChange)) return "—";
  const sign = percentChange >= 0 ? "+" : "−";
  return `${sign}${Math.abs(percentChange * 100).toFixed(1)}%`;
}

/** Key events tab (§6.6.3): by event, by landing page, or compared. */
export function KeyEventsTab({
  brandKey,
  range,
  canManage,
}: {
  brandKey: string;
  range: string;
  canManage: boolean;
}) {
  const [byLandingPage, setByLandingPage] = useState(false);
  const [compare, setCompare] = useState(false);
  const [offset, setOffset] = useState(0);
  const breakdown = byLandingPage ? "event_and_landing_page" : "event";
  const query = useGa4Report(brandKey, "key_events", {
    range,
    limit: 100,
    offset,
    breakdown,
    ...(compare && !byLandingPage ? { comparePreviousPeriod: true } : {}),
  });
  const exportRows = useExportRows();
  const data = query.data as unknown as
    | {
        rows?: EventRow[];
        comparison?: { rows?: ComparisonEntry[] } | null;
        reportMetadata?: { hasLimitedData?: boolean };
        pageInfo?: { hasMore?: boolean };
        totalRowCount?: number;
      }
    | undefined;

  const hasLimitedData = data?.reportMetadata?.hasLimitedData === true;
  const comparing = compare && !byLandingPage && data?.comparison?.rows != null;

  type DisplayRow = EventRow & {
    __previous?: number | null;
    __change?: number | null;
  };

  const rows: DisplayRow[] = comparing
    ? (data?.comparison?.rows ?? []).map((entry) => ({
        eventName: entry.dimensions.eventName ?? null,
        keyEvents: entry.metrics.keyEvents?.current ?? null,
        totalUsers: entry.metrics.totalUsers?.current ?? null,
        __previous: entry.metrics.keyEvents?.previous ?? null,
        __change: entry.metrics.keyEvents?.percentChange ?? null,
      }))
    : ((data?.rows ?? []) as DisplayRow[]);

  const columns: ColumnDef<DisplayRow>[] = [
    {
      id: "eventName",
      header: "Event",
      cell: ({ row }) => (
        <span className="break-words">{String(row.original.eventName ?? "—")}</span>
      ),
    },
    ...(byLandingPage
      ? [
          {
            id: "landingPage",
            header: "Landing page",
            cell: ({ row }: { row: { original: DisplayRow } }) => (
              <span className="break-words tabular-nums">
                {String(row.original.landingPage ?? row.original.hostName ?? "—")}
              </span>
            ),
          } satisfies ColumnDef<DisplayRow>,
        ]
      : []),
    { id: "keyEvents", header: "Key events", cell: ({ row }) => <span className="tabular-nums">{num(row.original.keyEvents)}</span> },
    { id: "totalUsers", header: "Users", cell: ({ row }) => <span className="tabular-nums">{num(row.original.totalUsers)}</span> },
    ...(comparing
      ? [
          {
            id: "previous",
            header: "Previous",
            cell: ({ row }: { row: { original: DisplayRow } }) => (
              <span className="tabular-nums">{num(row.original.__previous ?? null)}</span>
            ),
          } satisfies ColumnDef<DisplayRow>,
          {
            id: "change",
            header: "Change",
            cell: ({ row }: { row: { original: DisplayRow } }) => (
              <span className="tabular-nums">{changeText(row.original.__change ?? null)}</span>
            ),
          } satisfies ColumnDef<DisplayRow>,
        ]
      : []),
  ];

  const table = useDataTable<DisplayRow>({
    data: rows,
    columns,
    getRowId: (row, index) =>
      `${row.eventName ?? ""}${row.landingPage ?? ""}${index}`,
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
        empty={{
          title: "No key events were recorded in this period.",
          description: "Check Setup health to see whether any are configured.",
        }}
        toolbar={
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <Checkbox
                  checked={byLandingPage}
                  onCheckedChange={(checked) => {
                    setByLandingPage(checked === true);
                    setOffset(0);
                  }}
                  aria-label="By landing page"
                />
                By landing page
              </label>
              {!byLandingPage ? (
                <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                  <Checkbox
                    checked={compare}
                    onCheckedChange={(checked) => {
                      setCompare(checked === true);
                      setOffset(0);
                    }}
                    aria-label="Compare with previous period"
                  />
                  Compare with previous period
                </label>
              ) : null}
              {query.isFetching ? <Spinner className="size-3.5" aria-label="Refreshing" /> : null}
            </div>
            <ExportMenu
              actions={["sheets", "csv", "excel", "json"]}
              disabled={rows.length === 0}
              onExport={(action) =>
                void exportRows({
                  format: action,
                  feature: "ga4_key_events",
                  headers: comparing
                    ? ["Event", "Key events", "Users", "Previous", "Change"]
                    : ["Event", "Key events", "Users"],
                  rows: rows.map((row) =>
                    comparing
                      ? [row.eventName, row.keyEvents, row.totalUsers, row.__previous ?? null, changeText(row.__change ?? null)]
                      : [row.eventName, row.keyEvents, row.totalUsers],
                  ),
                  filename: `${brandKey}-analytics-key-events`,
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
