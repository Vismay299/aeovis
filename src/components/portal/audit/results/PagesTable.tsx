// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/results/PagesTable.tsx, src/client/features/audit/results/AuditResultsTableFilters.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 4 — the Pages tab: a server-filtered, server-sorted table with row
// selection, the registered page actions and export.

import { Suspense, useEffect, useState } from "react";
import { z } from "zod";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { ExportMenu } from "@/components/app/ExportMenu";
import { useExportRows } from "@/components/app/export/useExportRows";
import { QueryError } from "@/components/app/QueryState";
import {
  DataTable,
  makeSelectionColumn,
  useDataTable,
  useSelectionAnchor,
} from "@/components/app/table/DataTable";
import { ExternalUrlCell } from "@/components/app/table/ExternalUrlCell";
import { SortableHeader } from "@/components/app/table/SortableHeader";
import {
  TableBulkActionBar,
  TableBulkActionButton,
  TableBulkExportMenu,
} from "@/components/app/table/TableBulkActionBar";
import { TablePagination } from "@/components/app/table/TablePagination";
import { usePortal } from "@/components/portal/PortalShell";
import { useUrlSearchState } from "@/components/app/hooks/useUrlSearchState";
import { exportFilename } from "@/lib/export/filenames";
import type { ExportFormat } from "@/lib/export/exportRows";
import {
  useAuditPages,
  type AuditPageRow,
  type AuditPagesFilters,
} from "../hooks/useAuditPages";
import {
  AUDIT_PAGE_ACTIONS,
  type AuditPageAction,
  type AuditPageRef,
} from "../pageActions";
import { PagesFilters, PAGES_DEFAULTS, type PagesSearchState } from "./PagesFilters";
import { pagesExport } from "./export";
import { HttpStatusBadge, pathOf } from "../shared";

const PAGES_SCHEMA = z.object({
  q: z.string().max(200).optional(),
  status: z.enum(["all", "ok", "redirect", "error", "missing"]).optional(),
  fetchClass: z
    .enum(["all", "ok", "blocked", "rate_limited", "error"])
    .optional(),
  minWords: z.coerce.number().int().min(0).optional(),
  maxWords: z.coerce.number().int().min(0).optional(),
  minResponseMs: z.coerce.number().int().min(0).optional(),
  maxResponseMs: z.coerce.number().int().min(0).optional(),
  missingAlt: z.enum(["all", "yes", "no"]).optional(),
  issueType: z.string().max(64).optional(),
  sort: z
    .enum(["url", "status", "title", "h1", "words", "images", "speed"])
    .optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

type SortKey = NonNullable<PagesSearchState["sort"]>;

function toPageRef(row: AuditPageRow): AuditPageRef {
  return {
    url: row.url,
    statusCode: row.statusCode,
    indexable: row.isIndexable,
  };
}

/**
 * Test seam for the registry contract (F18-B09): the browser check sets this
 * global before the page boots to append F19-shaped actions. A normal visit
 * never sets it, so the shipped registry is exactly AUDIT_PAGE_ACTIONS.
 */
function injectedPageActions(): AuditPageAction[] {
  if (typeof window === "undefined") return [];
  const raw = (window as unknown as { __PERCEEV_AUDIT_PAGE_ACTIONS__?: unknown })
    .__PERCEEV_AUDIT_PAGE_ACTIONS__;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { id, label, flag } = entry as Record<string, unknown>;
    if (typeof id !== "string" || typeof label !== "string") return [];
    return [
      {
        id,
        label,
        ...(typeof flag === "string" ? { flag } : {}),
        eligible: () => true,
        Dialog: ({ onClose }: { onClose(): void }) => (
          <div data-testid={`injected-action-dialog-${id}`} role="dialog">
            <p>{label}</p>
            <button type="button" onClick={onClose}>
              Close
            </button>
          </div>
        ),
      },
    ];
  });
}

export function PagesTable({
  brandKey,
  auditId,
  host,
}: {
  brandKey: string;
  auditId: string;
  host: string;
}) {
  const { features } = usePortal();
  // The parser fills every key from PAGES_DEFAULTS, so the parsed value is a
  // complete state even though the schema's fields are optional.
  const [state, setState] = useUrlSearchState<PagesSearchState>(
    PAGES_SCHEMA as unknown as {
      safeParse(value: unknown): { success: boolean; data?: PagesSearchState };
    },
    PAGES_DEFAULTS,
  );
  const [actionDialog, setActionDialog] = useState<{
    action: AuditPageAction;
    pages: AuditPageRef[];
  } | null>(null);
  const [extraActions, setExtraActions] = useState<AuditPageAction[]>([]);
  const anchorRef = useSelectionAnchor();
  const exportRows = useExportRows();

  // After mount, so the server and the first client render agree.
  useEffect(() => {
    setExtraActions(injectedPageActions());
  }, []);

  const filters: AuditPagesFilters = {
    q: state.q || undefined,
    status: state.status,
    fetchClass: state.fetchClass === "all" ? undefined : state.fetchClass,
    minWords: state.minWords,
    maxWords: state.maxWords,
    minResponseMs: state.minResponseMs,
    maxResponseMs: state.maxResponseMs,
    missingAlt: state.missingAlt === "all" ? undefined : state.missingAlt,
    issueType: state.issueType || undefined,
    sort: state.sort,
    dir: state.dir,
    offset: state.offset,
    limit: state.limit,
  };

  const pages = useAuditPages(auditId, filters, true);
  const rows = pages.data?.rows ?? [];

  const activeCount = [
    state.q !== "",
    state.status !== "all",
    state.fetchClass !== "all",
    state.minWords !== undefined,
    state.maxWords !== undefined,
    state.minResponseMs !== undefined,
    state.maxResponseMs !== undefined,
    state.missingAlt !== "all",
    state.issueType !== "",
  ].filter(Boolean).length;

  const sortHeader = (key: SortKey, label: string) => (
    <SortableHeader
      label={label}
      column={{
        getIsSorted: () => (state.sort === key ? state.dir : false),
        getToggleSortingHandler: () => () => {
          const dir =
            state.sort === key && state.dir === "asc" ? "desc" : "asc";
          setState({ sort: key, dir, offset: 0 });
        },
      }}
    />
  );

  const columns: ColumnDef<AuditPageRow>[] = [
    makeSelectionColumn<AuditPageRow>(
      anchorRef,
      (row) => `Select ${row.original.url}`,
    ),
    {
      accessorKey: "url",
      header: () => sortHeader("url", "URL"),
      cell: ({ row }) => (
        <ExternalUrlCell
          value={row.original.url}
          label={pathOf(row.original.url)}
        />
      ),
    },
    {
      accessorKey: "statusCode",
      header: () => sortHeader("status", "Status"),
      cell: ({ row }) => (
        <HttpStatusBadge
          statusCode={row.original.statusCode}
          fetchClass={row.original.fetchClass}
        />
      ),
    },
    {
      accessorKey: "title",
      header: () => sortHeader("title", "Title"),
      cell: ({ row }) => (
        <span
          className="block max-w-[260px] truncate"
          title={row.original.title ?? undefined}
        >
          {row.original.title ?? "—"}
        </span>
      ),
    },
    {
      accessorKey: "h1Count",
      header: () => sortHeader("h1", "H1"),
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.h1Count}</span>
      ),
    },
    {
      accessorKey: "wordCount",
      header: () => sortHeader("words", "Words"),
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.wordCount}</span>
      ),
    },
    {
      id: "images",
      header: () => sortHeader("images", "Images"),
      cell: ({ row }) => (
        <span className="whitespace-nowrap tabular-nums">
          {`${row.original.imagesMissingAlt} of ${row.original.imagesTotal} missing alt`}
        </span>
      ),
    },
    {
      accessorKey: "responseTimeMs",
      header: () => sortHeader("speed", "Speed"),
      cell: ({ row }) => (
        <span className="whitespace-nowrap tabular-nums">
          {row.original.responseTimeMs == null
            ? "—"
            : `${row.original.responseTimeMs} ms`}
        </span>
      ),
    },
    {
      id: "issues",
      header: "Issues",
      cell: ({ row }) => (
        <span className="tabular-nums">{row.original.issueCount}</span>
      ),
    },
  ];

  const table = useDataTable<AuditPageRow>({
    data: rows,
    columns,
    getRowId: (row) => row.id,
    enableRowSelection: true,
  });

  const selected = table
    .getSelectedRowModel()
    .rows.map((row) => row.original);
  const visibleActions = [...AUDIT_PAGE_ACTIONS, ...extraActions].filter(
    (action) => !action.flag || features?.[action.flag] === true,
  );

  async function exportTable(format: ExportFormat, exportRowsInput: AuditPageRow[]) {
    const tableData = pagesExport(exportRowsInput);
    await exportRows({
      format,
      feature: "audit_pages",
      headers: tableData.headers,
      rows: tableData.rows,
      filename: exportFilename([brandKey, "site-audit", host, "pages"]),
      records: exportRowsInput,
    });
  }

  const clearFilters = () => setState(PAGES_DEFAULTS);
  const isFiltered = activeCount > 0;

  return (
    <>
      <DataTable
        table={table}
        isLoading={pages.isLoading}
        isFiltered={false}
        onClearFilters={clearFilters}
        empty={
          isFiltered
            ? {
                kind: "filtered",
                title: "No pages match these filters.",
                description: "Change or clear the filters to see more rows.",
                action: (
                  <Button variant="outline" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ),
              }
            : {
                title: "No pages yet",
                description: "Pages appear here as the audit crawls.",
              }
        }
        error={
          pages.isError ? (
            <QueryError
              error={pages.error}
              fallback="Couldn't load the pages."
              onRetry={() => void pages.refetch()}
              isRetrying={pages.isFetching}
            />
          ) : undefined
        }
        toolbar={
          <PagesFilters
            state={state}
            setState={setState}
            activeCount={activeCount}
            total={pages.data?.total ?? rows.length}
            actions={
              <ExportMenu
                actions={["sheets", "csv", "excel", "json"]}
                onExport={(action) => void exportTable(action, rows)}
                disabled={rows.length === 0}
              />
            }
          />
        }
        footer={
          <TablePagination
            page={Math.floor(state.offset / state.limit) + 1}
            pageSize={state.limit}
            pageSizes={[50, 100, 200]}
            totalCount={pages.data?.total ?? null}
            isLoading={pages.isFetching}
            onPageChange={(page) =>
              setState({ offset: (page - 1) * state.limit })
            }
            onPageSizeChange={(size) =>
              setState({ limit: size, offset: 0 })
            }
          />
        }
      />

      <TableBulkActionBar
        selectedCount={selected.length}
        selectedLabel="pages selected"
        onClear={() => table.resetRowSelection()}
        actions={
          <>
            {visibleActions.map((action) => {
              const Icon = action.icon;
              return (
                <TableBulkActionButton
                  key={action.id}
                  icon={Icon ? <Icon className="size-4" /> : undefined}
                  onClick={() =>
                    setActionDialog({
                      action,
                      pages: selected.map(toPageRef),
                    })
                  }
                >
                  {action.label}
                </TableBulkActionButton>
              );
            })}
            <TableBulkExportMenu
              actions={[
                {
                  label: "CSV",
                  onClick: () => void exportTable("csv", selected),
                },
                {
                  label: "Excel",
                  onClick: () => void exportTable("excel", selected),
                },
                {
                  label: "JSON",
                  onClick: () => void exportTable("json", selected),
                },
                {
                  label: "Sheets",
                  onClick: () => void exportTable("sheets", selected),
                },
              ]}
            />
          </>
        }
      />

      {actionDialog ? (
        (() => {
          const Dialog = actionDialog.action.Dialog;
          return (
            <Suspense fallback={null}>
              <Dialog
                brandKey={brandKey}
                auditId={auditId}
                pages={actionDialog.pages}
                onClose={() => setActionDialog(null)}
              />
            </Suspense>
          );
        })()
      ) : null}
    </>
  );
}
