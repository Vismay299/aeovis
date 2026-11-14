"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Globe, Search } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { QueryError } from "@/components/app/QueryState";
import { SegmentedToggle } from "@/components/app/SegmentedToggle";
import { DataTable, useDataTable } from "@/components/app/table/DataTable";
import { ExternalUrlCell } from "@/components/app/table/ExternalUrlCell";
import { TablePagination } from "@/components/app/table/TablePagination";
import { ExportMenu } from "@/components/app/ExportMenu";
import { useExportRows } from "@/components/app/export/useExportRows";
import { Ga4ErrorState } from "./Ga4ErrorState";
import { LimitedDataNotice } from "./LimitedDataNotice";
import { useGa4Report } from "./hooks/useGa4Report";

type LandingRow = Record<string, string | number | null>;

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

function money(value: unknown, currency: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return value.toLocaleString();
  }
}

/** Landing pages tab (§6.6.3) with the organic / all-traffic toggle. */
export function LandingPagesTab({
  brandKey,
  range,
  canManage,
}: {
  brandKey: string;
  range: string;
  canManage: boolean;
}) {
  const [channel, setChannel] = useState<"organic_search" | "all">("organic_search");
  const [offset, setOffset] = useState(0);
  const query = useGa4Report(brandKey, "landing_pages", {
    range,
    channel,
    limit: 100,
    offset,
  });
  const exportRows = useExportRows();
  const data = query.data as unknown as
    | {
        rows?: LandingRow[];
        reportMetadata?: { hasLimitedData?: boolean };
        pageInfo?: { hasMore?: boolean };
        totalRowCount?: number;
        request?: { currencyCode?: string };
      }
    | undefined;

  const rows = data?.rows ?? [];
  const currency = data?.request?.currencyCode ?? "USD";
  const hasLimitedData = data?.reportMetadata?.hasLimitedData === true;

  const columns: ColumnDef<LandingRow>[] = [
    {
      id: "landingPage",
      header: "Landing page",
      cell: ({ row }) => {
        const host = String(row.original.hostName ?? "");
        const path = String(row.original.landingPage ?? "");
        const value = host ? `https://${host}${path}` : path;
        return <ExternalUrlCell value={value} label={path || value} />;
      },
    },
    { id: "sessions", header: "Sessions", cell: ({ row }) => <span className="tabular-nums">{num(row.original.sessions)}</span> },
    { id: "activeUsers", header: "Active users", cell: ({ row }) => <span className="tabular-nums">{num(row.original.activeUsers)}</span> },
    { id: "engagedSessions", header: "Engaged sessions", cell: ({ row }) => <span className="tabular-nums">{num(row.original.engagedSessions)}</span> },
    { id: "engagementRate", header: "Engagement rate", cell: ({ row }) => <span className="tabular-nums">{rate(row.original.engagementRate)}</span> },
    { id: "keyEvents", header: "Key events", cell: ({ row }) => <span className="tabular-nums">{num(row.original.keyEvents)}</span> },
    { id: "sessionKeyEventRate", header: "Key event rate", cell: ({ row }) => <span className="tabular-nums">{rate(row.original.sessionKeyEventRate)}</span> },
    { id: "transactions", header: "Transactions", cell: ({ row }) => <span className="tabular-nums">{num(row.original.transactions)}</span> },
    { id: "purchaseRevenue", header: "Revenue", cell: ({ row }) => <span className="tabular-nums">{money(row.original.purchaseRevenue, currency)}</span> },
  ];

  const table = useDataTable<LandingRow>({
    data: rows,
    columns,
    getRowId: (row, index) =>
      `${row.hostName ?? ""}${row.landingPage ?? ""}${index}`,
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
        empty={{ title: "No landing pages recorded in this period." }}
        toolbar={
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-2">
              <SegmentedToggle
                items={[
                  { value: "organic_search", icon: <Search />, label: "Organic search" },
                  { value: "all", icon: <Globe />, label: "All traffic" },
                ]}
                value={channel}
                onChange={(value) => {
                  setChannel(value);
                  setOffset(0);
                }}
                showLabels
              />
              {query.isFetching ? <Spinner className="size-3.5" aria-label="Refreshing" /> : null}
            </div>
            <ExportMenu
              actions={["sheets", "csv", "excel", "json"]}
              disabled={rows.length === 0}
              onExport={(action) =>
                void exportRows({
                  format: action,
                  feature: "ga4_landing_pages",
                  headers: ["Landing page", "Sessions", "Active users", "Engaged sessions", "Engagement rate", "Key events", "Key event rate", "Transactions", "Revenue"],
                  rows: rows.map((row) => [
                    `${row.hostName ?? ""}${row.landingPage ?? ""}`,
                    row.sessions, row.activeUsers, row.engagedSessions,
                    row.engagementRate, row.keyEvents, row.sessionKeyEventRate,
                    row.transactions, row.purchaseRevenue,
                  ]),
                  filename: `${brandKey}-analytics-landing-pages`,
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
