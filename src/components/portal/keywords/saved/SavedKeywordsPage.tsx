// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/routes/_app/p/$projectId/saved.tsx
//   openseo:src/client/features/saved-keywords
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { EmptyState } from "@/components/app/EmptyState";
import { PageFrame } from "@/components/app/PageFrame";
import { QueryError } from "@/components/app/QueryState";
import { copyList } from "@/components/app/export/useExportRows";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import type { SavedKeywordRow } from "@/shared/keywords";
import { SavedKeywordsBulkActionBar } from "./SavedKeywordsBulkActionBar";
import { GroupTopicsDialog } from "./GroupTopicsDialog";
import { SavedKeywordsHeader } from "./SavedKeywordsHeader";
import { SavedKeywordsModals } from "./SavedKeywordsModals";
import { SavedKeywordsTable } from "./SavedKeywordsTable";
import { useSavedKeywordsExport } from "./hooks/useSavedKeywordsExport";
import {
  buildSavedKeywordsExportQuery,
  useSavedKeywordsQuery,
} from "./hooks/useSavedKeywordsQuery";
import { useRefreshStats } from "./hooks/useRefreshStats";
import { useTagManage } from "./hooks/useTagManage";

export function SavedKeywordsPage() {
  const saved = useSavedKeywordsQuery();
  const tagManage = useTagManage(saved.brandKey);
  const refresh = useRefreshStats({
    brandKey: saved.brandKey,
    enabled: saved.featureEnabled && saved.totalCount > 0,
  });
  const exporter = useSavedKeywordsExport({
    brandKey: saved.brandKey,
    exportQuery: buildSavedKeywordsExportQuery(saved.search),
  });

  const [selectedRows, setSelectedRows] = useState<SavedKeywordRow[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<SavedKeywordRow[] | null>(
    null,
  );
  const [bulkTagRows, setBulkTagRows] = useState<SavedKeywordRow[] | null>(null);
  const [groupOpen, setGroupOpen] = useState(false);
  const queryClient = useQueryClient();

  const invalidateList = () =>
    queryClient.invalidateQueries({ queryKey: ["savedKeywords", saved.brandKey] });

  const deleteKeywords = useMutation({
    mutationFn: (rows: SavedKeywordRow[]) =>
      fetchJson<{ deletedCount: number }>(
        withBrand("/api/customer/keywords/saved/remove", saved.brandKey),
        { method: "POST", body: { savedKeywordIds: rows.map((row) => row.id) } },
      ),
    onSuccess: (result) => {
      const count = result.deletedCount;
      toast.success(`${count} keyword${count === 1 ? "" : "s"} removed`);
      setDeleteTarget(null);
      setSelectedRows([]);
      void invalidateList();
    },
  });

  const toggleRow = (row: SavedKeywordRow) =>
    setSelectedRows((current) =>
      current.some((item) => item.id === row.id)
        ? current.filter((item) => item.id !== row.id)
        : [...current, row],
    );

  const toggleAll = (rows: SavedKeywordRow[], selected: boolean) =>
    setSelectedRows((current) => {
      const ids = new Set(rows.map((row) => row.id));
      const kept = current.filter((row) => !ids.has(row.id));
      return selected ? [...kept, ...rows] : kept;
    });

  const clearSelection = () => setSelectedRows([]);

  if (!saved.featureEnabled) {
    return (
      <PageFrame>
        <EmptyState
          title="This page is not available for your workspace yet."
          description="Ask Perceev support to turn on keyword research."
        />
      </PageFrame>
    );
  }

  const hasData = saved.list.data !== undefined;
  const isInitialLoading = saved.list.isPending && !hasData;
  // An out-of-range page is being reset to page 1; show the skeleton, never the
  // "no keywords" state that would imply the workspace is empty. Read the page
  // echoed by the response, because placeholder data keeps the out-of-range
  // page while the reset request loads.
  const dataPage = saved.list.data?.page ?? saved.search.page;
  const isOutOfRange =
    saved.totalCount > 0 && saved.rows.length === 0 && dataPage > 1;
  const errorCard = saved.list.isError ? (
    <QueryError
      cause={saved.list.error}
      fallback="Failed to load saved keywords."
      onRetry={() => void saved.list.refetch()}
      isRetrying={saved.list.isFetching}
      variant="inline"
    />
  ) : undefined;

  return (
    <PageFrame className="min-w-0 overflow-x-hidden">
      <SavedKeywordsHeader
        refresh={refresh}
        exportEnabled={saved.totalCount > 0}
        exportBusy={exporter.busy}
        onExport={(format) => void exporter.exportFiltered(format)}
      />

      {saved.list.isError && !hasData ? (
        <QueryError
          cause={saved.list.error}
          fallback="Failed to load saved keywords."
          onRetry={() => void saved.list.refetch()}
          isRetrying={saved.list.isFetching}
          variant="card"
        />
      ) : (
        <SavedKeywordsTable
          rows={saved.rows}
          totalCount={saved.totalCount}
          page={saved.search.page}
          pageSize={saved.search.size}
          sort={saved.search.sort}
          order={saved.search.order}
          isLoading={isInitialLoading || isOutOfRange}
          isFiltered={saved.activeFilterCount > 0}
          selectedIds={selectedRows.map((row) => row.id)}
          filters={saved.filters.draft}
          activeFilterCount={saved.activeFilterCount}
          tags={saved.tags}
          selectedTagIds={saved.selectedTagIds}
          manage={tagManage}
          error={errorCard}
          onFilterChange={saved.filters.setField}
          onClearFilters={saved.clearFilters}
          onToggleTag={saved.toggleTag}
          onClearTags={() => saved.setParams({ tags: "", page: undefined })}
          onSort={saved.setSort}
          onPage={saved.setPage}
          onPageSize={saved.setPageSize}
          onToggleRow={toggleRow}
          onToggleAll={toggleAll}
          onCopyRow={(row) => void copyList([row.keyword], "keyword")}
          onDeleteRow={(row) => setDeleteTarget([row])}
        />
      )}

      <SavedKeywordsBulkActionBar
        selectedCount={selectedRows.length}
        onTag={() => setBulkTagRows(selectedRows)}
        onGroupTopics={() => setGroupOpen(true)}
        onExport={(format) =>
          void exporter.exportSelected(format, selectedRows)
        }
        onCopy={() =>
          void copyList(
            selectedRows.map((row) => row.keyword),
            "keywords",
          )
        }
        onDelete={() => setDeleteTarget(selectedRows)}
        onClear={clearSelection}
      />

      <SavedKeywordsModals
        deleteTarget={deleteTarget}
        deletePending={deleteKeywords.isPending}
        onConfirmDelete={() => {
          if (deleteTarget) deleteKeywords.mutate(deleteTarget);
        }}
        onCloseDelete={() => setDeleteTarget(null)}
        bulkTagRows={bulkTagRows}
        tags={saved.tags}
        manage={tagManage}
        onCloseBulkTags={() => setBulkTagRows(null)}
        onBulkTagsApplied={clearSelection}
      />

      <GroupTopicsDialog
        open={groupOpen}
        onOpenChange={setGroupOpen}
        brandKey={saved.brandKey}
        selectedRows={selectedRows}
        onApplied={clearSelection}
      />
    </PageFrame>
  );
}
