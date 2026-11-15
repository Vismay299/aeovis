// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/audit/launch/AuditHistorySection.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

// F18 phase 4 — "Previous audits": date, URL, status, pages, issues, the
// Lighthouse marker and the row actions.

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ScanSearch } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { EmptyState } from "@/components/app/EmptyState";
import { QueryError } from "@/components/app/QueryState";
import { RowActionsMenu } from "@/components/app/RowActionsMenu";
import { DataTable, useDataTable } from "@/components/app/table/DataTable";
import type { AuditListRow } from "../hooks/useAuditList";
import type { LaunchController } from "./useLaunchController";
import { StatusBadge, formatAuditDate, hostOf } from "../shared";

const ACTIVE = new Set(["queued", "running"]);

function pagesLabel(row: AuditListRow): string {
  return ACTIVE.has(row.status)
    ? `${row.pagesCrawled} of ${row.pagesTotal}`
    : String(row.pagesCrawled);
}

export function AuditHistoryTable({
  controller,
}: {
  controller: LaunchController;
}) {
  const router = useRouter();
  const { audits, list, deleteAudit, deleting } = controller;
  const [deleteTarget, setDeleteTarget] = useState<AuditListRow | null>(null);
  const [compareIds, setCompareIds] = useState<string[]>([]);

  const selectedAudits = useMemo(
    () => compareIds.flatMap((id) => audits.filter((audit) => audit.id === id)),
    [audits, compareIds],
  );
  const selectedHost = selectedAudits[0]
    ? hostOf(selectedAudits[0].startUrl)
    : "";

  useEffect(() => {
    setCompareIds((current) => {
      if (current.every((id) => audits.some((audit) => audit.id === id))) {
        return current;
      }
      return current.filter((id) => audits.some((audit) => audit.id === id));
    });
  }, [audits]);
  const compareHref =
    selectedAudits.length === 2
      ? (() => {
          const [first, second] = selectedAudits;
          const [older, newer] =
            Date.parse(first.createdAt) <= Date.parse(second.createdAt)
              ? [first, second]
              : [second, first];
          const params = new URLSearchParams({
            base: older.id,
            head: newer.id,
          });
          return `/portal/audit/compare?${params.toString()}`;
        })()
      : null;

  function setCompareSelection(row: AuditListRow, checked: boolean) {
    setCompareIds((current) => {
      if (!checked) return current.filter((id) => id !== row.id);
      if (current.includes(row.id) || current.length >= 2) return current;
      const currentHost = current
        .map((id) => audits.find((audit) => audit.id === id))
        .find((audit): audit is AuditListRow => Boolean(audit));
      if (currentHost && hostOf(currentHost.startUrl) !== hostOf(row.startUrl)) {
        return current;
      }
      return [...current, row.id];
    });
  }

  const columns: ColumnDef<AuditListRow>[] = [
    {
      accessorKey: "createdAt",
      header: "Date",
      cell: ({ row }) => (
        <span className="whitespace-nowrap">
          {formatAuditDate(row.original.createdAt)}
        </span>
      ),
    },
    {
      accessorKey: "startUrl",
      header: "URL",
      cell: ({ row }) => (
        <span
          className="block max-w-[280px] truncate"
          title={row.original.startUrl}
        >
          {row.original.startUrl}
        </span>
      ),
    },
    {
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => <StatusBadge status={row.original.status} />,
    },
    {
      id: "pages",
      header: "Pages",
      cell: ({ row }) => (
        <span className="tabular-nums">{pagesLabel(row.original)}</span>
      ),
    },
    {
      id: "issues",
      header: "Issues",
      cell: ({ row }) => {
        const counts = row.original.issueCounts;
        if (!counts) return <span className="text-muted-foreground">—</span>;
        return (
          <span className="flex flex-wrap items-center gap-1">
            {counts.critical > 0 ? (
              <Badge variant="destructive">{`Critical ${counts.critical}`}</Badge>
            ) : null}
            {counts.warning > 0 ? (
              <Badge variant="warning">{`Warning ${counts.warning}`}</Badge>
            ) : null}
            {counts.critical === 0 && counts.warning === 0 ? (
              <span className="text-muted-foreground">—</span>
            ) : null}
          </span>
        );
      },
    },
    {
      id: "lighthouse",
      header: "Lighthouse",
      cell: ({ row }) =>
        row.original.lighthouse ? (
          <Badge variant="outline">Yes</Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      id: "compare",
      header: "Compare",
      cell: ({ row }) => {
        const audit = row.original;
        const checked = compareIds.includes(audit.id);
        const host = hostOf(audit.startUrl);
        const disabled =
          ACTIVE.has(audit.status) ||
          (!checked && compareIds.length >= 2) ||
          (!checked && Boolean(selectedHost) && selectedHost !== host);
        return (
          <label className="inline-flex min-h-8 items-center gap-2 whitespace-nowrap text-sm">
            <Checkbox
              aria-label="Compare"
              checked={checked}
              disabled={disabled}
              onCheckedChange={(value) =>
                setCompareSelection(audit, value === true)
              }
            />
            <span>Compare</span>
          </label>
        );
      },
    },
    {
      id: "actions",
      header: "",
      cell: ({ row }) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="outline"
            size="sm"
            nativeButton={false}
            render={<Link href={`/portal/audit/${row.original.id}`} />}
          >
            View
          </Button>
          <RowActionsMenu label={`Actions for ${row.original.startUrl}`}>
            <DropdownMenuItem onClick={() => setDeleteTarget(row.original)}>
              Delete audit
            </DropdownMenuItem>
          </RowActionsMenu>
        </div>
      ),
    },
  ];

  const table = useDataTable<AuditListRow>({
    data: audits,
    columns,
    getRowId: (row) => row.id,
  });

  const empty = (
    <EmptyState
      variant="card"
      icon={ScanSearch}
      title="No audits yet"
      description="A 50-page audit takes about a minute."
    />
  );

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold">Previous audits</h2>
        <Button
          disabled={!compareHref}
          onClick={() => {
            if (compareHref) router.push(compareHref);
          }}
        >
          Compare 2 audits
        </Button>
      </div>
      {list.isError ? (
        <QueryError
          error={list.error}
          fallback="Couldn't load your audits."
          onRetry={() => void list.refetch()}
          isRetrying={list.isFetching}
        />
      ) : !list.isLoading && audits.length === 0 ? (
        empty
      ) : (
        <DataTable
          table={table}
          isLoading={list.isLoading}
          empty={{ title: "No audits yet" }}
        />
      )}

      {deleteTarget ? (
        <ConfirmDialog
          title="Delete this audit?"
          confirmLabel="Delete audit"
          destructive
          pending={deleting}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => {
            const id = deleteTarget.id;
            void deleteAudit(id).then((ok) => {
              if (ok) setDeleteTarget(null);
            });
          }}
        >
          Its pages, issues and Lighthouse reports are removed. This can't be
          undone.
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
