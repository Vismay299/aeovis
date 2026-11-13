// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/saved-keywords
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import type {
  SavedKeywordRow,
  SavedKeywordTagSummary,
} from "@/shared/keywords";
import { SavedKeywordsBulkTagsModal } from "./SavedKeywordsBulkTagsModal";
import type { TagManageController } from "./hooks/useTagManage";

/** The saved page's dialogs: delete confirmation and bulk tag update. */
export function SavedKeywordsModals({
  deleteTarget,
  deletePending,
  onConfirmDelete,
  onCloseDelete,
  bulkTagRows,
  tags,
  manage,
  onCloseBulkTags,
  onBulkTagsApplied,
}: {
  deleteTarget: SavedKeywordRow[] | null;
  deletePending: boolean;
  onConfirmDelete: () => void;
  onCloseDelete: () => void;
  bulkTagRows: SavedKeywordRow[] | null;
  tags: SavedKeywordTagSummary[];
  manage: TagManageController;
  onCloseBulkTags: () => void;
  onBulkTagsApplied: () => void;
}) {
  const deleteCount = deleteTarget?.length ?? 0;

  return (
    <>
      {deleteTarget ? (
        <ConfirmDialog
          title="Delete keywords?"
          confirmLabel={`Delete ${deleteCount} keyword${
            deleteCount === 1 ? "" : "s"
          }`}
          destructive
          pending={deletePending}
          onConfirm={onConfirmDelete}
          onClose={onCloseDelete}
        >
          {`This will permanently delete ${deleteCount} saved keyword${
            deleteCount === 1 ? "" : "s"
          }.`}
        </ConfirmDialog>
      ) : null}

      {bulkTagRows ? (
        <SavedKeywordsBulkTagsModal
          selectedRows={bulkTagRows}
          tags={tags}
          manage={manage}
          onClose={onCloseBulkTags}
          onApplied={onBulkTagsApplied}
        />
      ) : null}
    </>
  );
}
