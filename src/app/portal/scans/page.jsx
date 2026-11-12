"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import {
  ChevronRight,
  FileDown,
  FileJson,
  FileSpreadsheet,
  Play,
  Radar,
  Sheet,
} from "lucide-react";
import { PrefetchLink } from "@/components/app/PrefetchLink";
import { ExportMenu } from "@/components/app/ExportMenu";
import { useExportRows } from "@/components/app/export/useExportRows";
import {
  DataTable,
  makeSelectionColumn,
  useDataTable,
  useSelectionAnchor,
} from "@/components/app/table/DataTable";
import { TableBulkActionBar, TableBulkExportMenu } from "@/components/app/table/TableBulkActionBar";
import { SortableHeader } from "@/components/app/table/SortableHeader";
import { DataTableToolbar } from "@/components/app/table/DataTableToolbar";
import { numericNullsLast } from "@/lib/table/nullSafeSort";
import { useUrlSearchState } from "@/components/app/hooks/useUrlSearchState";
import { QueryError } from "@/components/app/QueryState";
import { scanReportQueryOptions } from "@/lib/query/portalQueries";
import { exportFilename } from "@/lib/export/filenames";
import { usePortal } from "@/components/portal/PortalShell";
import { ScanProgressCard } from "@/components/portal/ScanProgressCard";
import MockScanPanel from "@/components/portal/scans/MockScanPanel";
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  ProgressBar,
  formatDate,
  formatPct,
} from "@/components/portal/ui";
import {
  platformLabel,
  scanVisibilityState,
} from "@/components/portal/scans/reportData";
import { NextRunBadge } from "@/components/portal/schedule/NextRunBadge";
import "@/components/portal/scans/scans.css";

const FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const SORT_DEFAULTS = { sort: "date", order: "desc" };
const sortSchema = z.object({
  sort: z.enum(["date", "visibility"]),
  order: z.enum(["asc", "desc"]),
});
const EXPORT_HEADERS = [
  "Date",
  "AI visibility (%)",
  "Questions",
  "Naming you",
  "Engines",
  "Collection",
];

function finiteOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function collectionStatus(scan) {
  if (scan.collection_partial === true) return "Partial";
  return scanVisibilityState(scan) === "measured" ? "Complete" : "Pending";
}

function exportRow(scan) {
  const visibility = finiteOrNull(scan.visibility_pct);
  return [
    formatDate(scan.scanned_at || scan.created_at, { withTime: true }),
    visibility ?? "",
    finiteOrNull(scan.prompts_tracked) ?? "",
    finiteOrNull(scan.prompts_mentioned) ?? "",
    platformLabel(scan.platform),
    collectionStatus(scan),
  ];
}

function scanDate(scan) {
  const value = scan.scanned_at || scan.created_at;
  const timestamp = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function scanPath(scan) {
  return `/portal/scans/${encodeURIComponent(scan.id)}`;
}

function ScansHistoryTable({ scans, loading, error, onRetry, router, brandKey }) {
  const [sortState, setSortState] = useUrlSearchState(sortSchema, SORT_DEFAULTS);
  const [rowSelection, setRowSelection] = useState({});
  const anchorRef = useSelectionAnchor();
  const runExportRows = useExportRows();
  const sorting = useMemo(
    () => [{ id: sortState.sort, desc: sortState.order === "desc" }],
    [sortState.order, sortState.sort],
  );

  const setSorting = (updater) => {
    const next = typeof updater === "function" ? updater(sorting) : updater;
    if (!next.length) {
      setSortState(SORT_DEFAULTS);
      return;
    }
    const nextSort = next[0].id === "visibility" ? "visibility" : "date";
    const nextOrder = next[0].desc ? "desc" : "asc";
    if (nextSort === "visibility" && nextOrder === "desc") {
      // The generic URL helper removes default values. F06-B05 requires an
      // explicit order=desc when visibility is the selected sort column.
      const params = new URLSearchParams(window.location.search);
      params.set("sort", nextSort);
      params.set("order", nextOrder);
      params.sort();
      const query = params.toString();
      router.replace(
        `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
        { scroll: false },
      );
      return;
    }
    setSortState({ sort: nextSort, order: nextOrder });
  };

  const columns = useMemo(() => [
    makeSelectionColumn(anchorRef, (row) =>
      `Select scan from ${formatDate(row.original.scanned_at || row.original.created_at, { withTime: true })}`,
    ),
    {
      id: "date",
      accessorFn: scanDate,
      sortDescFirst: true,
      header: ({ column }) => <SortableHeader column={column} label="Date" />,
      cell: ({ row }) => (
        <PrefetchLink
          href={scanPath(row.original)}
          prefetch={() => scanReportQueryOptions(row.original.id)}
          onClick={(event) => event.stopPropagation()}
          className="font-medium text-foreground hover:text-primary hover:underline"
        >
          {formatDate(row.original.scanned_at || row.original.created_at, { withTime: true })}
        </PrefetchLink>
      ),
    },
    {
      id: "visibility",
      accessorFn: (row) => finiteOrNull(row.visibility_pct),
      sortingFn: numericNullsLast,
      sortDescFirst: true,
      header: ({ column }) => <SortableHeader column={column} label="AI visibility" />,
      meta: { headerClassName: "min-w-44", cellClassName: "min-w-44" },
      cell: ({ row }) => {
        const visibility = finiteOrNull(row.original.visibility_pct);
        const pending = scanVisibilityState(row.original) === "pending";
        return (
          <div className="flex min-w-32 items-center gap-3">
            <div className="w-24">
              <ProgressBar value={visibility} indeterminate={pending} size="sm" label="AI visibility" />
            </div>
            <span className={`w-12 text-right text-sm font-semibold tabular-nums ${visibility === null ? "text-muted-foreground" : "text-foreground"}`}>
              {formatPct(visibility)}
            </span>
          </div>
        );
      },
    },
    {
      id: "questions",
      accessorFn: (row) => finiteOrNull(row.prompts_tracked),
      header: "Questions",
      meta: { headerClassName: "text-right", cellClassName: "text-right tabular-nums" },
      cell: ({ row }) => finiteOrNull(row.original.prompts_tracked) ?? "—",
    },
    {
      id: "naming",
      accessorFn: (row) => finiteOrNull(row.prompts_mentioned),
      header: "Naming you",
      meta: { headerClassName: "text-right", cellClassName: "text-right tabular-nums" },
      cell: ({ row }) => finiteOrNull(row.original.prompts_mentioned) ?? "—",
    },
    {
      id: "engines",
      accessorFn: (row) => platformLabel(row.platform),
      header: "Engines",
      cell: ({ row }) => platformLabel(row.original.platform),
    },
    {
      id: "actions",
      enableSorting: false,
      header: "",
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Open report"
          className="reveal-on-hover text-muted-foreground"
          onClick={(event) => {
            event.stopPropagation();
            router.push(scanPath(row.original));
          }}
        >
          <ChevronRight aria-hidden="true" />
        </Button>
      ),
    },
  ], [anchorRef, router]);

  const table = useDataTable({
    data: scans,
    columns,
    getRowId: (row) => String(row.id),
    state: { sorting, rowSelection },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: true,
    sortDescFirst: true,
    withSorting: true,
  });
  const selected = table.getSelectedRowModel().rows.map((row) => row.original);

  const runHistoryExport = async (format, rows, scope) => {
    await runExportRows({
      format,
      feature: "scan_history",
      headers: EXPORT_HEADERS,
      rows: rows.map(exportRow),
      filename: exportFilename([brandKey || "workspace", "scan-history"]),
      ...(scope ? { scope } : {}),
    });
  };

  const openSelectedExport = (format) => {
    void runHistoryExport(format, selected, "selection");
  };

  return (
    <>
      <DataTable
        table={table}
        isLoading={loading}
        isFiltered={false}
        error={error ? (
          <QueryError
            title="Scans did not load"
            error={error}
            fallback="Could not load scans."
            onRetry={onRetry}
            isRetrying={loading}
          />
        ) : null}
        empty={{ kind: "no-data", title: "No scans yet", description: "Run your first scan to see which brands AI engines recommend for your category." }}
        scrollClassName="max-w-full"
        toolbar={(
          <DataTableToolbar
            actions={(
              <ExportMenu
                actions={["sheets", "csv", "excel", "json"]}
                scopes={[{ id: "history", label: "Scan history", actions: ["sheets", "csv", "excel", "json"] }]}
                onExport={(action) => { void runHistoryExport(action, scans); }}
              />
            )}
          />
        )}
        onRowClick={(row, event) => {
          if (event.target?.closest?.("a, button, [role='checkbox']")) return;
          router.push(scanPath(row.original));
        }}
      />
      <TableBulkActionBar
        selectedCount={selected.length}
        selectedLabel="selected"
        onClear={() => {
          setRowSelection({});
          anchorRef.current = null;
        }}
        actions={(
          <TableBulkExportMenu
            actions={[
              { label: "Sheets", icon: <Sheet />, onClick: () => openSelectedExport("sheets") },
              { label: "CSV", icon: <FileDown />, onClick: () => openSelectedExport("csv") },
              { label: "Excel", icon: <FileSpreadsheet />, onClick: () => openSelectedExport("excel") },
              { label: "JSON", icon: <FileJson />, onClick: () => openSelectedExport("json") },
            ]}
          />
        )}
      />
    </>
  );
}

export default function ScansPage() {
  const { brandKey, brand, scan, redirectToLogin } = usePortal();
  const router = useRouter();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  // A different workspace must not show the previous workspace's history.
  useEffect(() => {
    setData(null);
  }, [brandKey]);

  useEffect(() => {
    if (!brandKey) return undefined;
    let live = true;
    setLoading(true);
    setError("");
    fetch(`/api/customer/scan?brand_key=${encodeURIComponent(brandKey)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!live) return;
        if (response.status === 401) { redirectToLogin(); return; }
        const body = await response.json().catch(() => null);
        if (!live) return;
        if (!response.ok) {
          setError(body?.error || "Could not load scans.");
          return;
        }
        setData(body);
      })
      .catch(() => {
        if (live) setError("Could not load scans. Check your connection and try again.");
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => { live = false; };
  }, [brandKey, redirectToLogin, scan.finished, reloadToken]);

  const scans = useMemo(() => (Array.isArray(data?.scans) ? data.scans : []), [data]);
  const failedRuns = useMemo(() => {
    const cutoff = Date.now() - FAILED_WINDOW_MS;
    return (Array.isArray(data?.jobs) ? data.jobs : []).filter((job) => {
      if (job?.status !== "failed") return false;
      const at = new Date(job.created_at).getTime();
      return Number.isFinite(at) && at >= cutoff;
    });
  }, [data]);

  const initialLoad = loading && !data;
  const showEmpty = !initialLoad && !error && scans.length === 0 && !scan.active;

  return (
    <div className="space-y-6 f06-scans-page">
      <PageHeader
        title="Scans"
        description="Every AI visibility scan for this workspace."
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <NextRunBadge />
            <Button
              icon={Play}
              loading={scan.starting}
              disabled={scan.active || !brandKey}
              onClick={() => scan.start()}
            >
              Run scan
            </Button>
          </div>
        )}
      />

      <div className="space-y-6">
        <ScanProgressCard showIdle={false} />
        {brandKey ? <MockScanPanel key={brandKey} brandKey={brandKey} brandName={brand?.display_name || "this workspace"} onUnauthorized={redirectToLogin} /> : null}

        {initialLoad ? (
          <Card title="Scan history" description={brand?.display_name ? `Each scan of ${brand.display_name}, newest first.` : "Newest first."} flush>
            <ScansHistoryTable key={brandKey} scans={[]} loading router={router} brandKey={brandKey} />
          </Card>
        ) : showEmpty ? (
          <Card>
            <EmptyState
              icon={Radar}
              title="No scans yet"
              action={<Button icon={Play} loading={scan.starting} disabled={scan.active || !brandKey} onClick={() => scan.start()}>Run scan</Button>}
            >
              Run your first scan to see which brands AI engines recommend for your category.
            </EmptyState>
          </Card>
        ) : scans.length > 0 || error ? (
          <Card
            title="Scan history"
            description={brand?.display_name ? `Each scan of ${brand.display_name}, newest first.` : "Newest first."}
            flush
          >
            <ScansHistoryTable
              key={brandKey}
              scans={scans}
              loading={false}
              error={error}
              onRetry={() => setReloadToken((n) => n + 1)}
              router={router}
              brandKey={brandKey}
            />
          </Card>
        ) : null}

        {failedRuns.length > 0 ? (
          <Card
            title="Failed runs"
            description="Runs from the last 7 days that stopped before finishing."
            flush
          >
            <div className="divide-y divide-border">
              {failedRuns.map((job) => (
                <div key={job.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">
                      {formatDate(job.created_at, { withTime: true })}
                    </p>
                    <p className="text-xs text-muted-foreground truncate">
                      {job.error?.message || "Scan stopped before finishing."}
                    </p>
                  </div>
                  <Badge tone="crit">Failed</Badge>
                </div>
              ))}
            </div>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
