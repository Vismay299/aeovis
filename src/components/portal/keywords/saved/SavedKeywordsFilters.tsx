// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/saved-keywords
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import {
  DataTableFilterToggle,
  DataTableToolbar,
} from "@/components/app/table/DataTableToolbar";
import type { SavedKeywordTagSummary } from "@/shared/keywords";
import type { SavedKeywordsFilterValues } from "@/shared/saved-keywords-filters";
import { SavedKeywordsFilterPanel } from "./SavedKeywordsFilterPanel";
import { SavedKeywordsTagFilter } from "./SavedKeywordsTagFilter";
import type { TagManageController } from "./hooks/useTagManage";

/** The table toolbar's filters: the filter toggle, then the tag popover. */
export function SavedKeywordsFilters({
  value,
  activeCount,
  onChange,
  onClear,
  tags,
  selectedTagIds,
  onToggleTag,
  onClearTags,
  manage,
  children,
}: {
  value: SavedKeywordsFilterValues;
  activeCount: number;
  onChange: (key: keyof SavedKeywordsFilterValues, next: string) => void;
  onClear: () => void;
  tags: SavedKeywordTagSummary[];
  selectedTagIds: string[];
  onToggleTag: (tagId: string) => void;
  onClearTags: () => void;
  manage: TagManageController;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <DataTableToolbar>
        <DataTableFilterToggle
          open={open}
          activeCount={activeCount}
          onToggle={() => setOpen((current) => !current)}
        />
        <SavedKeywordsTagFilter
          tags={tags}
          selectedIds={selectedTagIds}
          onToggle={onToggleTag}
          onClear={onClearTags}
          manage={manage}
        />
        {children}
      </DataTableToolbar>
      {open ? (
        <SavedKeywordsFilterPanel
          value={value}
          activeCount={activeCount}
          onChange={onChange}
          onClear={onClear}
        />
      ) : null}
    </>
  );
}
