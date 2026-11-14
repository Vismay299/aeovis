"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/app/EmptyState";
import { QueryError } from "@/components/app/QueryState";
import { DataTable, useDataTable } from "@/components/app/table/DataTable";
import { TablePagination } from "@/components/app/table/TablePagination";
import { ExportMenu } from "@/components/app/ExportMenu";
import { useExportRows } from "@/components/app/export/useExportRows";
import { Ga4ErrorState } from "./Ga4ErrorState";
import { LimitedDataNotice } from "./LimitedDataNotice";
import { useGa4Report } from "./hooks/useGa4Report";

type SearchRow = Record<string, string | number | null>;

function num(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value).toLocaleString()
    : "—";
}

function rate(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : "—";
}

function activityStatus(activity: unknown): string | null {
  if (typeof activity === "string") return activity;
  if (activity && typeof activity === "object") {
    const status = (activity as { status?: unknown }).status;
    if (typeof status === "string") return status;
  }
  return null;
}

/** Site search tab (§6.6.3). */
export function SiteSearchTab({
  brandKey,
  range,
  canManage,
}: {
  brandKey: string;
  range: string;
  canManage: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const query = useGa4Report(brandKey, "site_search", {
    range,
    limit: 100,
    offset,
  });
  const exportRows = useExportRows();
  const data = query.data as unknown as
    | {
        rows?: SearchRow[];
        siteSearchActivity?: unknown;
        reportMetadata?: { hasLimitedData?: boolean };
        pageInfo?: { hasMore?: boolean };
        totalRowCount?: number;
      }
    | undefined;

  const rows = data?.rows ?? [];
  const hasLimitedData = data?.reportMetadata?.hasLimitedData === true;
  const status = activityStatus(data?.siteSearchActivity);

  const columns: ColumnDef<SearchRow>[] = [
    { id: "searchTerm", header: "Search term", cell: ({ row }) => <span className="break-words">{String(row.original.searchTerm ?? "—")}</span> },
    { id: "eventCount", header: "Searches", cell: ({ row }) => <span className="tabular-nums">{num(row.original.eventCount)}</span> },
    { id: "activeUsers", header: "Users", cell: ({ row }) => <span className="tabular-nums">{num(row.original.activeUsers)}</span> },
    { id: "sessions", header: "Sessions", cell: ({ row }) => <span className="tabular-nums">{num(row.original.sessions)}</span> },
    { id: "engagedSessions", header: "Engaged sessions", cell: ({ row }) => <span className="tabular-nums">{num(row.original.engagedSessions)}</span> },
    { id: "engagementRate", header: "Engagement rate", cell: ({ row }) => <span className="tabular-nums">{rate(row.original.engagementRate)}</span> },
  ];

  const table = useDataTable<SearchRow>({
    data: rows,
    columns,
    getRowId: (row, index) => `${row.searchTerm ?? ""}${index}`,
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

  if (status === "none") {
    return (
      <EmptyState
        variant="plain"
        title="No site searches were recorded in this period."
        description="Site search tracking may be off; see Setup health."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2 px-4 pt-1">
        {query.isError ? (
          <QueryError
            error={query.error}
            fallback="Couldn't load this report from Google Analytics."
            onRetry={() => void query.refetch()}
            isRetrying={query.isFetching}
          />
        ) : null}
        {status === "unknown" ? (
          <Alert>
            <AlertDescription>
              This report is incomplete or limited, so we can't tell whether
              there was site search activity.
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
      {hasLimitedData ? (
        <div className="px-4"><LimitedDataNotice /></div>
      ) : null}
      <DataTable
        table={table}
        isLoading={query.isPending}
        empty={{
          title: "No site searches were recorded in this period.",
          description: "Site search tracking may be off; see Setup health.",
        }}
        toolbar={
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <span className="text-sm text-muted-foreground">
              Searches from the view_search_results event.
              {query.isFetching ? (
                <Spinner className="ml-2 inline size-3.5" aria-label="Refreshing" />
              ) : null}
            </span>
            <ExportMenu
              actions={["sheets", "csv", "excel", "json"]}
              disabled={rows.length === 0}
              onExport={(action) =>
                void exportRows({
                  format: action,
                  feature: "ga4_site_search",
                  headers: ["Search term", "Searches", "Users", "Sessions", "Engaged sessions", "Engagement rate"],
                  rows: rows.map((row) => [
                    row.searchTerm, row.eventCount, row.activeUsers,
                    row.sessions, row.engagedSessions, row.engagementRate,
                  ]),
                  filename: `${brandKey}-analytics-site-search`,
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
