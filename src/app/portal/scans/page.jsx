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
import { Badge, Button, Card, EmptyState, PageHeader, ProgressBar, formatDate, formatPct } from "@/components/portal/ui";
import { usePortal } from "@/components/portal/PortalShell";
import { ScanProgressCard } from "@/components/portal/ScanProgressCard";
import MockScanPanel from "@/components/portal/scans/MockScanPanel";
import { platformLabel, scanVisibilityState } from "@/components/portal/scans/reportData";
import { NextRunBadge } from "@/components/portal/schedule/NextRunBadge";
import { PrefetchLink } from "@/components/app/PrefetchLink";
import { ExportMenu } from "@/components/app/ExportMenu";
import { useExportRows } from "@/components/app/export/useExportRows";
import { useServerExport } from "@/components/app/export/useServerExport";
import { DataTable, makeSelectionColumn, useDataTable, useSelectionAnchor } from "@/components/app/table/DataTable";
import { TableBulkActionBar, TableBulkExportMenu } from "@/components/app/table/TableBulkActionBar";
import { SortableHeader } from "@/components/app/table/SortableHeader";
import { DataTableToolbar, DataTableFilterToggle, DataTableFilterPanel, DataTableFilterGroup, DataTableRangeFilter } from "@/components/app/table/DataTableToolbar";
import { TablePagination } from "@/components/app/table/TablePagination";
import { numericNullsLast } from "@/shared/table/nullSafeSort";
import { useUrlSearchState } from "@/components/app/hooks/useUrlSearchState";
import { QueryError } from "@/components/app/QueryState";
import { scanReportQueryOptions } from "@/shared/query/portalQueries";
import { exportFilename } from "@/shared/export/filenames";
import { useQuery } from "@tanstack/react-query";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { keys, stableStringify } from "@/shared/query/keys";
import "@/components/portal/scans/scans.css";

const FAILED_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZES = [25, 50, 100];

const historySearchSchema = z.object({
  page: z.number().int().positive().default(1),
  size: z.union([z.literal(25), z.literal(50), z.literal(100)]).default(50),
  sort: z.enum(["date", "visibility"]).default("date"),
  order: z.enum(["asc", "desc"]).default("desc"),
  from: z.string().optional(),
  to: z.string().optional(),
  startedBy: z.enum(["manual", "scheduled"]).optional(),
  engines: z.string().optional(),
  collection: z.string().optional(),
  visMin: z.coerce.number().min(0).max(100).optional(),
  visMax: z.coerce.number().min(0).max(100).optional(),
});

const HISTORY_DEFAULTS = {
  page: 1,
  size: 50,
  sort: "date",
  order: "desc",
  from: undefined,
  to: undefined,
  startedBy: undefined,
  engines: undefined,
  collection: undefined,
  visMin: undefined,
  visMax: undefined,
};

const EXPORT_HEADERS = [
  "Date",
  "AI visibility (%)",
  "Questions",
  "Naming you",
  "Engines",
  "Started by",
  "Collection",
];

const ENGINE_OPTIONS = [
  { label: "ChatGPT", ids: ["chatgpt"] },
  { label: "Gemini", ids: ["gemini"] },
  { label: "Perplexity", ids: ["perplexity"] },
  { label: "Google AI Overviews", ids: ["aio", "google_ai_overview"] },
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

function startedByLabel(value) {
  return value === "scheduled" ? "Scheduled" : "Manual";
}

function exportRow(scan) {
  const visibility = finiteOrNull(scan.visibility_pct);
  return [
    formatDate(scan.scanned_at || scan.created_at, { withTime: true }),
    visibility ?? "",
    finiteOrNull(scan.prompts_tracked) ?? "",
    finiteOrNull(scan.prompts_mentioned) ?? "",
    platformLabel(scan.platform),
    startedByLabel(scan.started_by),
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

function buildQuery(search) {
  const query = {
    page: search.page,
    size: search.size,
    sort: search.sort,
    order: search.order,
  };
  if (search.from) query.from = search.from;
  if (search.to) query.to = search.to;
  if (search.startedBy) query.startedBy = search.startedBy;
  if (search.engines) query.engines = search.engines;
  if (search.collection) query.collection = search.collection;
  if (typeof search.visMin === "number") query.visMin = search.visMin;
  if (typeof search.visMax === "number") query.visMax = search.visMax;
  return query;
}

function activeFilterCount(search) {
  let count = 0;
  if (search.from || search.to) count += 1;
  if (search.startedBy) count += 1;
  if (search.engines) count += 1;
  if (search.collection) count += 1;
  if (typeof search.visMin === "number" || typeof search.visMax === "number") count += 1;
  return count;
}

function engineIdsFrom(search) {
  return (search.engines || "").split(",").map((value) => value.trim()).filter(Boolean);
}

function toggleEngine(search, setParams, ids) {
  const current = new Set(engineIdsFrom(search));
  const allPresent = ids.every((id) => current.has(id));
  if (allPresent) {
    ids.forEach((id) => current.delete(id));
  } else {
    ids.forEach((id) => current.add(id));
  }
  setParams({ engines: [...current].join(","), page: undefined });
}

function ScansHistoryTable({ brandKey, router, serverExports, scan }) {
  const [search, setParams] = useUrlSearchState(historySearchSchema, HISTORY_DEFAULTS);
  const runExportRows = useExportRows();
  const serverExport = useServerExport();
  const anchorRef = useSelectionAnchor();
  const [rowSelection, setRowSelection] = useState({});
  const [filterOpen, setFilterOpen] = useState(false);

  const query = useMemo(() => buildQuery(search), [search]);
  const list = useQuery({
    queryKey: keys.scanHistory(brandKey, stableStringify(query)),
    enabled: Boolean(brandKey),
    queryFn: ({ signal }) => fetchJson(withBrand("/api/customer/scans/history", brandKey, query), { signal }),
    placeholderData: (previousData, previousQuery) =>
      previousQuery?.queryKey?.[1] === brandKey ? previousData : undefined,
    retry: false,
  });

  const rows = list.data?.scans ?? [];
  const totalCount = list.data?.totalCount ?? 0;
  const isLoading = list.isLoading && !list.data;
  const error = list.error;

  const sorting = useMemo(() => [{ id: search.sort, desc: search.order === "desc" }], [search.sort, search.order]);

  const setSorting = (updater) => {
    const next = typeof updater === "function" ? updater(sorting) : updater;
    if (!next.length) {
      setParams({ sort: "date", order: "desc", page: undefined });
      return;
    }
    const nextSort = next[0].id === "visibility" ? "visibility" : "date";
    const nextOrder = next[0].desc ? "desc" : "asc";
    if (nextSort === "visibility" && nextOrder === "desc") {
      const params = new URLSearchParams(window.location.search);
      params.set("sort", nextSort);
      params.set("order", nextOrder);
      params.sort();
      const queryString = params.toString();
      router.replace(`${window.location.pathname}${queryString ? `?${queryString}` : ""}${window.location.hash}`, { scroll: false });
      return;
    }
    setParams({ sort: nextSort, order: nextOrder, page: undefined });
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
      id: "startedBy",
      accessorFn: (row) => (row.started_by === "scheduled" ? "Scheduled" : "Manual"),
      enableSorting: false,
      header: "Started by",
      cell: ({ row }) => (
        <Badge tone={row.original.started_by === "scheduled" ? "info" : "neutral"}>{startedByLabel(row.original.started_by)}</Badge>
      ),
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
    data: rows,
    columns,
    getRowId: (row) => String(row.id),
    state: { sorting, rowSelection },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    enableRowSelection: true,
    manualSorting: true,
    manualPagination: true,
    sortDescFirst: true,
    withSorting: true,
  });

  const selected = table.getSelectedRowModel().rows.map((row) => row.original);

  const runHistoryExport = async (format) => {
    if (!brandKey || totalCount > 1000) return;
    const baseQuery = buildQuery({ ...search, page: undefined, size: undefined });
    delete baseQuery.page;
    delete baseQuery.size;
    let collected = [];
    let page = 1;
    while (collected.length < Math.min(totalCount, 1000)) {
      const response = await fetchJson(withBrand("/api/customer/scans/history", brandKey, { ...baseQuery, page, size: 100 }));
      const pageRows = Array.isArray(response?.scans) ? response.scans : [];
      collected = collected.concat(pageRows);
      if (pageRows.length < 100) break;
      page += 1;
    }
    collected = collected.slice(0, 1000);
    await runExportRows({
      format,
      feature: "scan_history",
      headers: EXPORT_HEADERS,
      rows: collected.map(exportRow),
      filename: exportFilename([brandKey || "workspace", "scan-history"]),
    });
  };

  const openSelectedExport = (format) => {
    void runExportRows({
      format,
      feature: "scan_history",
      headers: EXPORT_HEADERS,
      rows: selected.map(exportRow),
      filename: exportFilename([brandKey || "workspace", "scan-history"]),
      scope: "selection",
    });
  };

  const runAllAnswersExport = (format) => {
    if (!brandKey) return;
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 89 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    serverExport.mutate({ brandKey, kind: "workspace_answers", format, params: { from, to } });
  };

  const clearFilters = () => {
    setParams({
      from: undefined,
      to: undefined,
      startedBy: undefined,
      engines: undefined,
      collection: undefined,
      visMin: undefined,
      visMax: undefined,
      page: undefined,
    });
  };

  const exportScopes = [
    {
      id: "history",
      label: totalCount > 1000 ? "Scan history — Narrow the filters to export (1,000 rows max)" : "Scan history",
      actions: totalCount > 1000 ? [] : ["sheets", "csv", "excel", "json"],
    },
    ...(serverExports
      ? [{
          id: "all-answers",
          label: "All answers",
          actions: ["csv", "json"],
          labels: {
            csv: "All answers, last 90 days (CSV)",
            json: "All answers, last 90 days (JSON)",
          },
        }]
      : []),
  ];

  const filterActive = activeFilterCount(search) > 0;

  const empty = { kind: "no-data", title: "No scans yet", description: "Run your first scan to see which brands AI engines recommend for your category." };

  if (!isLoading && !error && totalCount === 0 && !filterActive) {
    return (
      <EmptyState
        icon={Radar}
        title="No scans yet"
        action={<Button icon={Play} loading={scan?.starting} disabled={scan?.active || !brandKey} onClick={() => scan?.start()}>Run scan</Button>}
      >
        Run your first scan to see which brands AI engines recommend for your category.
      </EmptyState>
    );
  }

  return (
    <>
      <DataTable
        table={table}
        isLoading={isLoading}
        isFiltered={filterActive}
        onClearFilters={clearFilters}
        error={error ? (
          <QueryError
            title="Scans did not load"
            error={error}
            fallback="Could not load scans."
            onRetry={() => list.refetch()}
            isRetrying={isLoading}
          />
        ) : null}
        empty={empty}
        scrollClassName="max-w-full"
        toolbar={(
          <>
            <DataTableToolbar
              actions={(
                <ExportMenu
                  actions={["sheets", "csv", "excel", "json"]}
                  scopes={exportScopes}
                  busy={serverExport.isPending}
                  onExport={(action, scope) => {
                    if (scope === "all-answers") {
                      if (action === "csv" || action === "json") runAllAnswersExport(action);
                      return;
                    }
                    if (scope === "history") {
                      if (totalCount > 1000) return;
                      void runHistoryExport(action);
                      return;
                    }
                    void runExportRows({
                      format: action,
                      feature: "scan_history",
                      headers: EXPORT_HEADERS,
                      rows: rows.map(exportRow),
                      filename: exportFilename([brandKey || "workspace", "scan-history"]),
                    });
                  }}
                />
              )}
            >
              <DataTableFilterToggle open={filterOpen} activeCount={activeFilterCount(search)} onToggle={() => setFilterOpen((value) => !value)} />
            </DataTableToolbar>
            {filterOpen ? (
              <DataTableFilterPanel activeCount={activeFilterCount(search)} onReset={clearFilters}>
                <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-5">
                  <DataTableFilterGroup label="Date">
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="date"
                        className="h-7 rounded-md border border-border bg-background px-2 text-xs"
                        value={search.from || ""}
                        onChange={(event) => setParams({ from: event.target.value || undefined, page: undefined })}
                        aria-label="From date"
                      />
                      <input
                        type="date"
                        className="h-7 rounded-md border border-border bg-background px-2 text-xs"
                        value={search.to || ""}
                        onChange={(event) => setParams({ to: event.target.value || undefined, page: undefined })}
                        aria-label="To date"
                      />
                    </div>
                  </DataTableFilterGroup>
                  <DataTableFilterGroup label="Started by">
                    <select
                      className="h-7 rounded-md border border-border bg-background px-2 text-xs"
                      value={search.startedBy || ""}
                      onChange={(event) => setParams({ startedBy: event.target.value || undefined, page: undefined })}
                      aria-label="Started by"
                    >
                      <option value="">Any</option>
                      <option value="manual">Manual</option>
                      <option value="scheduled">Scheduled</option>
                    </select>
                  </DataTableFilterGroup>
                  <DataTableFilterGroup label="Engines">
                    <div className="flex flex-wrap gap-2">
                      {ENGINE_OPTIONS.map((option) => {
                        const ids = engineIdsFrom(search);
                        const checked = option.ids.some((id) => ids.includes(id));
                        return (
                          <label key={option.label} className="flex items-center gap-1 text-xs">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleEngine(search, setParams, option.ids)}
                            />
                            {option.label}
                          </label>
                        );
                      })}
                    </div>
                  </DataTableFilterGroup>
                  <DataTableFilterGroup label="Collection">
                    <select
                      className="h-7 rounded-md border border-border bg-background px-2 text-xs"
                      value={search.collection || ""}
                      onChange={(event) => setParams({ collection: event.target.value || undefined, page: undefined })}
                      aria-label="Collection"
                    >
                      <option value="">All</option>
                      <option value="complete">Complete</option>
                      <option value="partial">Partial</option>
                      <option value="pending">Pending</option>
                    </select>
                  </DataTableFilterGroup>
                  <DataTableRangeFilter
                    label="AI visibility"
                    min={{ value: search.visMin ?? "", onChange: (event) => setParams({ visMin: event.target.value === "" ? undefined : Number(event.target.value), page: undefined }) }}
                    max={{ value: search.visMax ?? "", onChange: (event) => setParams({ visMax: event.target.value === "" ? undefined : Number(event.target.value), page: undefined }) }}
                  />
                </div>
              </DataTableFilterPanel>
            ) : null}
          </>
        )}
        footer={(
          <TablePagination
            page={search.page}
            pageSize={search.size}
            pageSizes={PAGE_SIZES}
            totalCount={totalCount}
            isLoading={list.isFetching}
            onPageChange={(nextPage) => setParams({ page: nextPage })}
            onPageSizeChange={(nextSize) => setParams({ size: nextSize, page: undefined })}
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
  const { brandKey, brand, scan, features, redirectToLogin } = usePortal();
  const router = useRouter();
  const [jobs, setJobs] = useState([]);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!brandKey) return undefined;
    let live = true;
    fetch(`/api/customer/scan?brand_key=${encodeURIComponent(brandKey)}`, { cache: "no-store" })
      .then(async (response) => {
        if (!live) return;
        if (response.status === 401) { redirectToLogin(); return; }
        const body = await response.json().catch(() => null);
        if (!live) return;
        if (!response.ok) return;
        setJobs(Array.isArray(body?.jobs) ? body.jobs : []);
      })
      .catch(() => {});
    return () => { live = false; };
  }, [brandKey, redirectToLogin, scan?.finished, reloadToken]);

  const failedRuns = useMemo(() => {
    const cutoff = Date.now() - FAILED_WINDOW_MS;
    return jobs.filter((job) => {
      if (job?.status !== "failed") return false;
      const at = new Date(job.created_at).getTime();
      return Number.isFinite(at) && at >= cutoff;
    });
  }, [jobs]);

  return (
    <div className="space-y-6 f06-scans-page">
      <PageHeader
        title="Scans"
        description="Every AI visibility scan for this workspace."
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <NextRunBadge />
            <Button icon={Play} loading={scan?.starting} disabled={scan?.active || !brandKey} onClick={() => scan?.start()}>
              Run scan
            </Button>
          </div>
        )}
      />
      <div className="space-y-6">
        <ScanProgressCard showIdle={false} />
        {brandKey ? <MockScanPanel key={brandKey} brandKey={brandKey} brandName={brand?.display_name || "this workspace"} onUnauthorized={redirectToLogin} /> : null}
        {brandKey ? (
          <Card title="Scan history" description={brand?.display_name ? `Each scan of ${brand.display_name}, newest first.` : "Newest first."} flush>
            <ScansHistoryTable
              key={brandKey}
              brandKey={brandKey}
              router={router}
              serverExports={features?.server_exports === true}
              scan={scan}
            />
          </Card>
        ) : null}
        {failedRuns.length > 0 ? (
          <Card title="Failed runs" description="Runs from the last 7 days that stopped before finishing." flush>
            <div className="divide-y divide-border">
              {failedRuns.map((job) => (
                <div key={job.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">{formatDate(job.created_at, { withTime: true })}</p>
                    <p className="text-xs text-muted-foreground truncate">{job.error?.message || "Scan stopped before finishing."}</p>
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
