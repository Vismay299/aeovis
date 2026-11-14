"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { QueryError } from "@/components/app/QueryState";
import { DataTable, useDataTable } from "@/components/app/table/DataTable";
import { TablePagination } from "@/components/app/table/TablePagination";
import { ExportMenu } from "@/components/app/ExportMenu";
import { useExportRows } from "@/components/app/export/useExportRows";
import { Ga4ErrorState } from "./Ga4ErrorState";
import { LimitedDataNotice } from "./LimitedDataNotice";
import { useGa4Report } from "./hooks/useGa4Report";

type AcquisitionRow = Record<string, string | number | null>;

type Diagnostic = {
  code?: string;
  evidence?: { share?: number };
};

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

const BREAKDOWNS = [
  { value: "channel_group", label: "Channel group" },
  { value: "source_medium", label: "Source / medium" },
  { value: "campaign", label: "Campaign" },
] as const;

type Breakdown = (typeof BREAKDOWNS)[number]["value"];

/** Traffic acquisition tab (§6.6.3) with breakdown select and compare. */
export function AcquisitionTab({
  brandKey,
  range,
  canManage,
}: {
  brandKey: string;
  range: string;
  canManage: boolean;
}) {
  const [acquisitionBreakdown, setAcquisitionBreakdown] =
    useState<Breakdown>("channel_group");
  const [compare, setCompare] = useState(false);
  const [offset, setOffset] = useState(0);
  const query = useGa4Report(brandKey, "traffic_acquisition", {
    range,
    limit: 100,
    offset,
    acquisitionBreakdown,
    ...(compare && acquisitionBreakdown === "channel_group"
      ? { comparePreviousPeriod: true }
      : {}),
  });
  const exportRows = useExportRows();
  const data = query.data as unknown as
    | {
        rows?: AcquisitionRow[];
        diagnostics?: Diagnostic[];
        reportMetadata?: { hasLimitedData?: boolean };
        pageInfo?: { hasMore?: boolean };
        totalRowCount?: number;
        request?: { currencyCode?: string };
      }
    | undefined;

  const rows = data?.rows ?? [];
  const currency = data?.request?.currencyCode ?? "USD";
  const hasLimitedData = data?.reportMetadata?.hasLimitedData === true;
  const diagnostics = data?.diagnostics ?? [];
  const segmentLabel =
    acquisitionBreakdown === "channel_group"
      ? "Channel"
      : acquisitionBreakdown === "source_medium"
        ? "Source / medium"
        : "Campaign";
  const segmentKey =
    acquisitionBreakdown === "channel_group"
      ? "sessionDefaultChannelGroup"
      : acquisitionBreakdown === "source_medium"
        ? "sessionSourceMedium"
        : "sessionCampaignName";

  const columns: ColumnDef<AcquisitionRow>[] = [
    {
      id: "segment",
      header: segmentLabel,
      cell: ({ row }) => (
        <span className="break-words">{String(row.original[segmentKey] ?? "—")}</span>
      ),
    },
    { id: "sessions", header: "Sessions", cell: ({ row }) => <span className="tabular-nums">{num(row.original.sessions)}</span> },
    { id: "activeUsers", header: "Active users", cell: ({ row }) => <span className="tabular-nums">{num(row.original.activeUsers)}</span> },
    { id: "engagedSessions", header: "Engaged sessions", cell: ({ row }) => <span className="tabular-nums">{num(row.original.engagedSessions)}</span> },
    { id: "engagementRate", header: "Engagement rate", cell: ({ row }) => <span className="tabular-nums">{rate(row.original.engagementRate)}</span> },
    { id: "keyEvents", header: "Key events", cell: ({ row }) => <span className="tabular-nums">{num(row.original.keyEvents)}</span> },
    { id: "transactions", header: "Transactions", cell: ({ row }) => <span className="tabular-nums">{num(row.original.transactions)}</span> },
    { id: "purchaseRevenue", header: "Revenue", cell: ({ row }) => <span className="tabular-nums">{money(row.original.purchaseRevenue, currency)}</span> },
  ];

  const table = useDataTable<AcquisitionRow>({
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
      <div className="space-y-2 px-4 pt-1">
        {query.isError ? (
          <QueryError
            error={query.error}
            fallback="Couldn't load this report from Google Analytics."
            onRetry={() => void query.refetch()}
            isRetrying={query.isFetching}
          />
        ) : null}
        {diagnostics
          .filter((diagnostic) => diagnostic.code === "attribution_not_set_share_high")
          .map((diagnostic, index) => (
            <Alert key={`attribution-${index}`}>
              <AlertDescription>
                {diagnostic.evidence?.share != null
                  ? `${(diagnostic.evidence.share * 100).toFixed(0)}% of sessions have no source/medium attribution.`
                  : "Some sessions have no source/medium attribution."}
              </AlertDescription>
            </Alert>
          ))}
        {diagnostics.some(
          (diagnostic) => diagnostic.code === "internal_referral_traffic_detected",
        ) ? (
          <Alert>
            <AlertDescription>
              Traffic from local or private-network addresses appears in your
              acquisition data.
            </AlertDescription>
          </Alert>
        ) : null}
        {diagnostics.some(
          (diagnostic) =>
            diagnostic.code === "source_medium_case_variants_detected",
        ) ? (
          <Alert>
            <AlertDescription>
              Some sources differ only by letter case, which splits their numbers.
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
        empty={{ title: "No acquisition data recorded in this period." }}
        toolbar={
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-4">
              <Select
                value={acquisitionBreakdown}
                onValueChange={(value) => {
                  if (value === "channel_group" || value === "source_medium" || value === "campaign") {
                    setAcquisitionBreakdown(value);
                    setOffset(0);
                  }
                }}
              >
                <SelectTrigger aria-label="Breakdown" className="w-44">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BREAKDOWNS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {acquisitionBreakdown === "channel_group" ? (
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
                  feature: "ga4_traffic_acquisition",
                  headers: [segmentLabel, "Sessions", "Active users", "Engaged sessions", "Engagement rate", "Key events", "Transactions", "Revenue"],
                  rows: rows.map((row) => [
                    row[segmentKey],
                    row.sessions, row.activeUsers, row.engagedSessions,
                    row.engagementRate, row.keyEvents, row.transactions,
                    row.purchaseRevenue,
                  ]),
                  filename: `${brandKey}-analytics-acquisition`,
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
