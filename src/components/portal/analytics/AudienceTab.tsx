"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Checkbox } from "@/components/ui/checkbox";
import { Spinner } from "@/components/ui/spinner";
import { QueryError } from "@/components/app/QueryState";
import { SegmentedToggle } from "@/components/app/SegmentedToggle";
import { MonitorSmartphone, Globe, Users } from "lucide-react";
import { DataTable, useDataTable } from "@/components/app/table/DataTable";
import { TablePagination } from "@/components/app/table/TablePagination";
import { ExportMenu } from "@/components/app/ExportMenu";
import { useExportRows } from "@/components/app/export/useExportRows";
import { Ga4ErrorState } from "./Ga4ErrorState";
import { LimitedDataNotice } from "./LimitedDataNotice";
import { useGa4Report } from "./hooks/useGa4Report";

type AudienceRow = Record<string, string | number | null>;

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

/** Audience tab (§6.6.3): device, country or new-vs-returning breakdowns. */
export function AudienceTab({
  brandKey,
  range,
  canManage,
}: {
  brandKey: string;
  range: string;
  canManage: boolean;
}) {
  const [audienceBreakdown, setAudienceBreakdown] = useState<
    "device" | "country" | "new_vs_returning"
  >("device");
  const [compare, setCompare] = useState(false);
  const [offset, setOffset] = useState(0);
  const query = useGa4Report(brandKey, "audience_breakdown", {
    range,
    limit: 100,
    offset,
    audienceBreakdown,
    ...(compare && audienceBreakdown !== "country"
      ? { comparePreviousPeriod: true }
      : {}),
  });
  const exportRows = useExportRows();
  const data = query.data as unknown as
    | {
        rows?: AudienceRow[];
        reportMetadata?: { hasLimitedData?: boolean };
        pageInfo?: { hasMore?: boolean };
        totalRowCount?: number;
      }
    | undefined;

  const rows = data?.rows ?? [];
  const hasLimitedData = data?.reportMetadata?.hasLimitedData === true;
  const segmentKey =
    audienceBreakdown === "device"
      ? "deviceCategory"
      : audienceBreakdown === "country"
        ? "country"
        : "newVsReturning";
  const segmentLabel =
    audienceBreakdown === "device"
      ? "Device"
      : audienceBreakdown === "country"
        ? "Country"
        : "New vs returning";

  const columns: ColumnDef<AudienceRow>[] = [
    {
      id: "segment",
      header: segmentLabel,
      cell: ({ row }) => (
        <span className="break-words">{String(row.original[segmentKey] ?? "—")}</span>
      ),
    },
    { id: "activeUsers", header: "Active users", cell: ({ row }) => <span className="tabular-nums">{num(row.original.activeUsers)}</span> },
    { id: "sessions", header: "Sessions", cell: ({ row }) => <span className="tabular-nums">{num(row.original.sessions)}</span> },
    { id: "engagementRate", header: "Engagement rate", cell: ({ row }) => <span className="tabular-nums">{rate(row.original.engagementRate)}</span> },
    { id: "keyEvents", header: "Key events", cell: ({ row }) => <span className="tabular-nums">{num(row.original.keyEvents)}</span> },
  ];

  const table = useDataTable<AudienceRow>({
    data: rows,
    columns,
    getRowId: (row, index) => `${row[segmentKey] ?? ""}${index}`,
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
        empty={{ title: "No visitors recorded in this period." }}
        toolbar={
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-4">
              <SegmentedToggle
                items={[
                  { value: "device", icon: <MonitorSmartphone />, label: "Device" },
                  { value: "country", icon: <Globe />, label: "Country" },
                  { value: "new_vs_returning", icon: <Users />, label: "New vs returning" },
                ]}
                value={audienceBreakdown}
                onChange={(value) => {
                  setAudienceBreakdown(value);
                  setOffset(0);
                }}
                showLabels
              />
              {audienceBreakdown !== "country" ? (
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
                  feature: "ga4_audience_breakdown",
                  headers: [segmentLabel, "Active users", "Sessions", "Engagement rate", "Key events"],
                  rows: rows.map((row) => [
                    row[segmentKey], row.activeUsers, row.sessions,
                    row.engagementRate, row.keyEvents,
                  ]),
                  filename: `${brandKey}-analytics-audience`,
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
