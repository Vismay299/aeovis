// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/saved-keywords
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useMemo, useState } from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { Tags } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import type { SavedKeywordTagSummary } from "@/shared/keywords";
import { ManageTagRow } from "./ManageTagRow";
import type { TagManageController } from "./hooks/useTagManage";

/**
 * The toolbar's tag filter: search, per-tag counts, and a manage mode for
 * renaming, recolouring and deleting tags.
 */
export function SavedKeywordsTagFilter({
  tags,
  selectedIds,
  onToggle,
  onClear,
  manage,
}: {
  tags: SavedKeywordTagSummary[];
  selectedIds: string[];
  onToggle: (tagId: string) => void;
  onClear: () => void;
  manage: TagManageController;
}) {
  const [query, setQuery] = useState("");
  const [managing, setManaging] = useState(false);

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return tags;
    return tags.filter((tag) => tag.name.toLowerCase().includes(term));
  }, [query, tags]);

  return (
    <PopoverPrimitive.Root>
      <PopoverPrimitive.Trigger
        render={<Button variant="outline" size="sm" />}
      >
        <Tags data-icon="inline-start" />
        Tags
        {selectedIds.length > 0 ? (
          <Badge size="sm" aria-label={`${selectedIds.length} tags selected`}>
            {selectedIds.length}
          </Badge>
        ) : null}
      </PopoverPrimitive.Trigger>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          sideOffset={6}
          align="start"
          className="isolate z-50"
        >
          <PopoverPrimitive.Popup
            aria-label="Filter by tags"
            className="w-[min(20rem,calc(100vw-2rem))] space-y-2 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-lg outline-none"
          >
            <Input
              aria-label="Search tags"
              placeholder="Search tags"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />

            {managing ? (
              <div className="max-h-64 space-y-1.5 overflow-y-auto">
                {filtered.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">
                    No tags match that search.
                  </p>
                ) : (
                  filtered.map((tag) => (
                    <ManageTagRow
                      key={tag.id}
                      tag={tag}
                      pending={manage.pendingTagIds.includes(tag.id)}
                      onRename={(name) => void manage.updateTag(tag.id, { name })}
                      onColor={(color) =>
                        void manage.updateTag(tag.id, { color })
                      }
                      onDelete={() => void manage.deleteTag(tag.id)}
                    />
                  ))
                )}
              </div>
            ) : (
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {filtered.length === 0 ? (
                  <p className="px-1 py-2 text-xs text-muted-foreground">
                    No tags match that search.
                  </p>
                ) : (
                  filtered.map((tag) => (
                    <label
                      key={tag.id}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-accent"
                    >
                      <Checkbox
                        aria-label={`${tag.name} (${tag.keywordCount})`}
                        checked={selectedIds.includes(tag.id)}
                        onCheckedChange={() => onToggle(tag.id)}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {tag.name}
                      </span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {tag.keywordCount}
                      </span>
                    </label>
                  ))
                )}
              </div>
            )}

            <Separator />
            <div className="flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => setManaging((value) => !value)}
              >
                {managing ? "Done managing" : "Manage tags"}
              </Button>
              {selectedIds.length > 0 ? (
                <Button variant="ghost" size="xs" onClick={onClear}>
                  Clear
                </Button>
              ) : null}
            </div>
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
