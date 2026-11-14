"use client";

import Link from "next/link";
import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { EmptyState } from "@/components/app/EmptyState";
import { QueryError } from "@/components/app/QueryState";
import { DataTable, useDataTable } from "@/components/app/table/DataTable";
import { ExternalUrlCell } from "@/components/app/table/ExternalUrlCell";
import { ScoreBadge } from "@/components/app/table/ScoreBadge";
import { TablePagination } from "@/components/app/table/TablePagination";
import { ExportMenu } from "@/components/app/ExportMenu";
import { useExportRows } from "@/components/app/export/useExportRows";
import { Ga4ErrorState, ga4ErrorCode } from "./Ga4ErrorState";
import { LimitedDataNotice } from "./LimitedDataNotice";
import { useGa4Opportunities } from "./hooks/useGa4Opportunities";

type OpportunityRow = {
  page: string;
  normalizedPage?: string;
  clicks?: number;
  impressions?: number;
  ctr?: number;
  position?: number;
  joinStatus?: string;
  ga4?: {
    sessions?: number | null;
    engagementRate?: number | null;
    sessionKeyEventRate?: number | null;
  } | null;
  score?: number | null;
  scoreComponents?: {
    demand?: number;
    businessValue?: number;
    reachability?: number;
  } | null;
};

function num(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.round(value).toLocaleString()
    : "—";
}

function oneDecimal(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(1)
    : "—";
}

function rate(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : "—";
}

function pathOf(page: string): string {
  try {
    const url = new URL(/^https?:\/\//.test(page) ? page : `https://${page}`);
    return `${url.pathname}${url.search}` || "/";
  } catch {
    return page;
  }
}

/** Opportunities tab (§6.6.3): pages at positions 4–20 with the joined score. */
export function OpportunitiesTab({
  brandKey,
  range,
  canManage,
}: {
  brandKey: string;
  range: string;
  canManage: boolean;
}) {
  const [offset, setOffset] = useState(0);
  const query = useGa4Opportunities(brandKey, range);
  const exportRows = useExportRows();
  const data = query.data as unknown as
    | {
        rows?: OpportunityRow[];
        scoring?: { engagementFallback?: boolean };
        coverage?: { matchedRows?: number; totalCandidateRows?: number };
        totalCandidateRows?: number;
        truncated?: { gsc?: boolean };
        warnings?: string[];
        request?: { propertyTimeZone?: string };
        reportMetadata?: { hasLimitedData?: boolean };
        pageInfo?: { hasMore?: boolean };
        totalRowCount?: number;
        rowCount?: number;
      }
    | undefined;

  const rows = data?.rows ?? [];
  const scoring = data?.scoring;
  const matched = data?.coverage?.matchedRows ?? 0;
  const candidates =
    data?.coverage?.totalCandidateRows ?? data?.totalCandidateRows ?? rows.length;
  const hasLimitedData = data?.reportMetadata?.hasLimitedData === true;
  const timeZone = data?.request?.propertyTimeZone;

  const columns: ColumnDef<OpportunityRow>[] = [
    {
      id: "expander",
      header: () => null,
      cell: ({ row }) =>
        row.original.scoreComponents ? (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={row.getIsExpanded() ? "Collapse details" : "Expand details"}
            onClick={() => row.toggleExpanded()}
          >
            {row.getIsExpanded() ? (
              <ChevronDown aria-hidden />
            ) : (
              <ChevronRight aria-hidden />
            )}
          </Button>
        ) : null,
    },
    {
      id: "page",
      header: "Page",
      cell: ({ row }) => (
        <ExternalUrlCell value={row.original.page} label={pathOf(row.original.page)} />
      ),
    },
    {
      id: "score",
      header: "Score",
      cell: ({ row }) =>
        row.original.score == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <ScoreBadge value={row.original.score} />
        ),
    },
    {
      id: "position",
      header: "Position",
      cell: ({ row }) => (
        <span className="tabular-nums">{oneDecimal(row.original.position)}</span>
      ),
    },
    {
      id: "impressions",
      header: "Impressions",
      cell: ({ row }) => (
        <span className="tabular-nums">{num(row.original.impressions)}</span>
      ),
    },
    {
      id: "clicks",
      header: "Clicks",
      cell: ({ row }) => (
        <span className="tabular-nums">{num(row.original.clicks)}</span>
      ),
    },
    {
      id: "ctr",
      header: "CTR",
      cell: ({ row }) => (
        <span className="tabular-nums">{rate(row.original.ctr)}</span>
      ),
    },
    {
      id: "sessions",
      header: "Organic sessions",
      cell: ({ row }) => (
        <span className="tabular-nums">{num(row.original.ga4?.sessions ?? null)}</span>
      ),
    },
    {
      id: "engagementRate",
      header: "Engagement rate",
      cell: ({ row }) => (
        <span className="tabular-nums">{rate(row.original.ga4?.engagementRate ?? null)}</span>
      ),
    },
    {
      id: "keyEventRate",
      header: "Key event rate",
      cell: ({ row }) => (
        <span className="tabular-nums">{rate(row.original.ga4?.sessionKeyEventRate ?? null)}</span>
      ),
    },
    {
      id: "match",
      header: "Match",
      cell: ({ row }) => (
        <span>
          {row.original.joinStatus === "joined" ? "Matched" : "Search Console only"}
        </span>
      ),
    },
  ];

  const table = useDataTable<OpportunityRow>({
    data: rows,
    columns,
    getRowId: (row, index) => row.normalizedPage ?? row.page ?? String(index),
    withExpanded: true,
  });

  if (query.isPending) return null;

  if (query.isError && !query.data) {
    const code = ga4ErrorCode(query.error);
    if (code === "gsc_not_connected") {
      return (
        <EmptyState
          title="Connect Search Console to see search opportunities."
          action={
            <Link
              href="/portal/search-console"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Open Search Console
            </Link>
          }
        />
      );
    }
    return (
      <Ga4ErrorState
        error={query.error}
        canManage={canManage}
        onRetry={() => void query.refetch()}
        isRetrying={query.isFetching}
      />
    );
  }

  if (rows.length === 0 && !query.isFetching) {
    return (
      <p className="px-4 py-8 text-center text-sm text-muted-foreground">
        No pages rank between positions 4 and 20 in this period.
      </p>
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
        {hasLimitedData ? <LimitedDataNotice /> : null}
        {data?.truncated?.gsc ? (
          <Alert>
            <AlertDescription>
              Search Console returned 1,000 pages, the most one request allows,
              so lower-traffic pages are not included.
            </AlertDescription>
          </Alert>
        ) : null}
        {data?.warnings?.includes("source_time_zones_differ") && timeZone ? (
          <Alert>
            <AlertDescription>
              Search Console reports days in Pacific Time; this property uses{" "}
              {timeZone}, so days may not line up exactly.
            </AlertDescription>
          </Alert>
        ) : null}
      </div>
      <DataTable
        table={table}
        isLoading={query.isPending}
        empty={{
          title: "No pages rank between positions 4 and 20 in this period.",
        }}
        toolbar={
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <p className="text-sm text-muted-foreground">
              Pages ranking 4–20 on Google, scored by search demand (50%),
              business value (30%) and how close they are to the top (20%).
              {query.isFetching ? (
                <Spinner className="ml-2 inline size-3.5" aria-label="Refreshing" />
              ) : null}
            </p>
            <ExportMenu
              actions={["sheets", "csv", "excel", "json"]}
              disabled={rows.length === 0}
              onExport={(action) =>
                void exportRows({
                  format: action,
                  feature: "ga4_opportunities",
                  headers: ["Page", "Score", "Position", "Impressions", "Clicks", "CTR", "Organic sessions", "Engagement rate", "Key event rate", "Match"],
                  rows: rows.map((row) => [
                    row.page,
                    row.score ?? null,
                    row.position ?? null,
                    row.clicks ?? null,
                    row.impressions ?? null,
                    row.ctr ?? null,
                    row.ga4?.sessions ?? null,
                    row.ga4?.engagementRate ?? null,
                    row.ga4?.sessionKeyEventRate ?? null,
                    row.joinStatus === "joined" ? "Matched" : "Search Console only",
                  ]),
                  filename: `${brandKey}-analytics-opportunities`,
                  records: rows,
                })
              }
            />
          </div>
        }
        renderExpandedRow={(row) =>
          row.original.scoreComponents ? (
            <p className="text-sm text-muted-foreground">
              Demand {row.original.scoreComponents.demand ?? "—"} · Business
              value {row.original.scoreComponents.businessValue ?? "—"} ·
              Reachability {row.original.scoreComponents.reachability ?? "—"}{" "}
              (0–100 each)
            </p>
          ) : null
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
      <div className="space-y-1 px-4 pb-1">
        <p className="text-sm text-muted-foreground">
          {matched} of {candidates} pages ranking 4–20 matched an Analytics
          landing page.
        </p>
        {scoring?.engagementFallback ? (
          <p className="text-sm text-muted-foreground">
            None of these pages recorded key events, so business value uses
            engagement rate.
          </p>
        ) : null}
      </div>
    </div>
  );
}
