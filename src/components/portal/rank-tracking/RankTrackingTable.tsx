// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/RankTrackingTable.tsx:28-235
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { FileDown, Play, Plus, Sheet, Trash2 } from "lucide-react";
import type { SortingState } from "@tanstack/react-table";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { DataTable, useDataTable } from "@/components/app/table/DataTable";
import {
  TableBulkActionBar,
  TableBulkActionButton,
  TableBulkExportMenu,
} from "@/components/app/table/TableBulkActionBar";
import { fetchJson, withBrand } from "@/lib/query/fetchJson";
import { keys } from "@/lib/query/keys";
import type { RankTrackingRow } from "@/shared/rank-tracking";
import {
  PINNED_COLUMN_ID,
  useRankTrackingColumns,
} from "./RankTrackingColumns";
import { useSetKeywordPinned } from "./hooks/useSetKeywordPinned";
import { exportRankTracking } from "./RankTrackingTableParts";
import {
  KeywordTrendModal,
  type KeywordTrendTarget,
} from "./KeywordTrendModal";
import type { SelectionAnchor } from "@/lib/table/tableSelection";

export function RankTrackingTable({
  totalCount,
  rows,
  showDesktop,
  showMobile,
  sorting,
  onSortingChange,
  domain,
  configId,
  brandKey,
  locationCode,
  languageCode,
  locationName,
  serpDepth = 40,
  onAddKeywords,
  onClearFilters,
  onCheckSelected,
}: {
  totalCount: number;
  rows: RankTrackingRow[];
  showDesktop: boolean;
  showMobile: boolean;
  sorting: SortingState;
  onSortingChange: (sorting: SortingState) => void;
  domain: string;
  configId: string;
  brandKey: string;
  locationCode: number;
  languageCode: string;
  locationName?: string | null;
  serpDepth?: number;
  onAddKeywords: () => void;
  onClearFilters: () => void;
  onCheckSelected?: (keywordIds: string[]) => void;
}) {
  const queryClient = useQueryClient();
  const [showConfirm, setShowConfirm] = useState(false);
  const [singleRemoveId, setSingleRemoveId] = useState<string | null>(null);
  const [trendTarget, setTrendTarget] = useState<KeywordTrendTarget | null>(null);
  const selectAnchorRef = useRef<SelectionAnchor | null>(null);

  const handleKeywordClick = useCallback(
    (row: RankTrackingRow) =>
      setTrendTarget({
        trackingKeywordId: row.trackingKeywordId,
        keyword: row.keyword,
      }),
    [],
  );

  const setKeywordPinned = useSetKeywordPinned(brandKey, configId);

  const handleRemoveSingle = useCallback((keywordId: string) => {
    setSingleRemoveId(keywordId);
  }, []);

  const columns = useRankTrackingColumns({
    showDesktop,
    showMobile,
    domain,
    serpDepth,
    selectAnchorRef,
    onKeywordClick: handleKeywordClick,
    onSetPinned: setKeywordPinned,
    onRemoveKeyword: handleRemoveSingle,
    locationCode,
    languageCode,
    locationName,
  });

  const tableSorting = useMemo(
    () => [{ id: PINNED_COLUMN_ID, desc: false }, ...sorting],
    [sorting],
  );

  const table = useDataTable({
    data: rows,
    columns,
    state: {
      sorting: tableSorting,
      columnVisibility: { [PINNED_COLUMN_ID]: false },
    },
    onSortingChange: (updater) =>
      onSortingChange(
        (typeof updater === "function" ? updater(tableSorting) : updater).filter(
          (sort) => sort.id !== PINNED_COLUMN_ID,
        ),
      ),
    enableSortingRemoval: false,
    withSorting: true,
    getRowId: (row) => row.trackingKeywordId,
    enableRowSelection: true,
  });

  const selectedRows = table.getSelectedRowModel().rows;
  const selectedCount = selectedRows.length;
  const selectedRankRows = selectedRows.map((row) => row.original);

  const exportSelection = (format: "csv" | "sheets") =>
    exportRankTracking({
      format,
      rows: selectedRankRows,
      showDesktop,
      showMobile,
      domain,
      locationName,
      scope: "selection",
    });

  const removeMutation = useMutation({
    mutationFn: (keywordIds: string[]) =>
      fetchJson<{ removed: number; removedIds: string[] }>(
        withBrand(
          `/api/customer/rank-tracking/configs/${encodeURIComponent(configId)}/keywords/remove`,
          brandKey,
        ),
        {
          method: "POST",
          body: { brand_key: brandKey, keywordIds },
        },
      ),
    onSuccess: (result) => {
      table.resetRowSelection();
      setShowConfirm(false);
      setSingleRemoveId(null);
      void queryClient.invalidateQueries({
        queryKey: ["rankResults", brandKey, configId],
      });
      void queryClient.invalidateQueries({
        queryKey: keys.rankTrackers(brandKey),
      });
      toast.success(
        `${result.removed} keyword${result.removed !== 1 ? "s" : ""} removed`,
      );
    },
    onError: (err: any) => {
      toast.error(err?.message || "Failed to remove keywords.");
    },
  });

  const idsToRemove = singleRemoveId
    ? [singleRemoveId]
    : selectedRows.map((r) => r.id);

  return (
    <>
      <TableBulkActionBar
        selectedCount={selectedCount}
        onClear={() => table.resetRowSelection()}
        actions={
          <div className="flex items-center gap-1 px-1.5">
            {onCheckSelected && (
              <TableBulkActionButton
                icon={<Play className="size-3.5" />}
                onClick={() =>
                  onCheckSelected(selectedRows.map((r) => r.original.trackingKeywordId))
                }
              >
                Check selected
              </TableBulkActionButton>
            )}
            <TableBulkActionButton
              icon={<Trash2 className="size-3.5" />}
              onClick={() => setShowConfirm(true)}
              variant="danger"
            >
              Remove
            </TableBulkActionButton>
            <TableBulkExportMenu
              actions={[
                {
                  label: "Export to Sheets",
                  icon: <Sheet className="size-4" />,
                  onClick: () => exportSelection("sheets"),
                },
                {
                  label: "Export CSV",
                  icon: <FileDown className="size-4" />,
                  onClick: () => exportSelection("csv"),
                },
              ]}
            />
          </div>
        }
      />

      {(showConfirm || singleRemoveId !== null) && (
        <ConfirmDialog
          title="Remove keywords?"
          confirmLabel={`Remove ${idsToRemove.length} keyword${
            idsToRemove.length !== 1 ? "s" : ""
          }`}
          destructive
          pending={removeMutation.isPending}
          onConfirm={() => removeMutation.mutate(idsToRemove)}
          onClose={() => {
            setShowConfirm(false);
            setSingleRemoveId(null);
          }}
        >
          This will stop tracking {idsToRemove.length} keyword
          {idsToRemove.length !== 1 ? "s" : ""}. Historical ranking data is preserved
          but won't appear in the table.
        </ConfirmDialog>
      )}

      {trendTarget && (
        <KeywordTrendModal
          target={trendTarget}
          brandKey={brandKey}
          configId={configId}
          locationCode={locationCode}
          languageCode={languageCode}
          locationName={locationName}
          serpDepth={serpDepth}
          onClose={() => setTrendTarget(null)}
        />
      )}

      <DataTable
        table={table}
        isFiltered={totalCount > 0 && rows.length === 0}
        onClearFilters={onClearFilters}
        empty={{
          title: "No keywords yet",
          description: "Add the keywords you want to track for this domain.",
          action: (
            <Button size="sm" onClick={onAddKeywords}>
              <Plus data-icon="inline-start" className="size-3.5" />
              Add Keywords
            </Button>
          ),
        }}
        footer={
          rows.length > 0 ? (
            <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
              {rows.length} of {totalCount} keywords
            </p>
          ) : null
        }
      />
    </>
  );
}
