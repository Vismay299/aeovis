// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/saved-keywords
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Copy, FileDown, Sheet, Tag as TagIcon, Trash2 } from "lucide-react";
import {
  TableBulkActionBar,
  TableBulkActionButton,
  TableBulkExportMenu,
} from "@/components/app/table/TableBulkActionBar";
import type { SavedKeywordsExportFormat } from "./hooks/useSavedKeywordsExport";

/** The bulk bar for selected saved keywords (P6's action is not built yet). */
export function SavedKeywordsBulkActionBar({
  selectedCount,
  onTag,
  onExport,
  onCopy,
  onDelete,
  onClear,
}: {
  selectedCount: number;
  onTag: () => void;
  onExport: (format: SavedKeywordsExportFormat) => void;
  onCopy: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  return (
    <TableBulkActionBar
      selectedCount={selectedCount}
      selectedLabel="selected"
      onClear={onClear}
      actions={
        <div className="flex min-w-0 max-w-[calc(100vw-10rem)] flex-wrap items-stretch justify-end gap-1 sm:max-w-none">
          <TableBulkActionButton icon={<TagIcon />} onClick={onTag}>
            Tag
          </TableBulkActionButton>
          <TableBulkExportMenu
            actions={[
              {
                label: "Copy keywords",
                icon: <Copy />,
                onClick: onCopy,
              },
              {
                label: "Export to Sheets",
                icon: <Sheet />,
                onClick: () => onExport("sheets"),
              },
              {
                label: "Export CSV",
                icon: <FileDown />,
                onClick: () => onExport("csv"),
              },
            ]}
          />
          <TableBulkActionButton
            icon={<Trash2 />}
            variant="danger"
            onClick={onDelete}
          >
            Delete
          </TableBulkActionButton>
          <TableBulkActionButton onClick={onClear}>Clear</TableBulkActionButton>
        </div>
      }
    />
  );
}
