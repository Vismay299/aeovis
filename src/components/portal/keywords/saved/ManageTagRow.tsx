// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/saved-keywords
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useState } from "react";
import { Check, Pencil } from "lucide-react";
import { InlineConfirm } from "@/components/app/InlineConfirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  TAG_COLOR_KEYS,
  resolveTagColor,
  tagSwatchClass,
} from "@/shared/tag-colors";
import type { SavedKeywordTagSummary } from "@/shared/keywords";
import { cn } from "@/shared/utils";

/** One tag in the manage list: inline rename, colour swatches, delete. */
export function ManageTagRow({
  tag,
  pending,
  onRename,
  onColor,
  onDelete,
}: {
  tag: SavedKeywordTagSummary;
  pending: boolean;
  onRename: (name: string) => void;
  onColor: (color: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tag.name);
  const resolved = resolveTagColor(tag);

  const save = () => {
    const next = name.trim();
    if (!next) return;
    setEditing(false);
    if (next !== tag.name) onRename(next);
  };

  return (
    <div className="space-y-1.5 rounded-md border border-border px-2 py-1.5">
      <div className="flex items-center gap-2">
        {editing ? (
          <>
            <Input
              aria-label={`Rename ${tag.name}`}
              className="h-6 flex-1"
              value={name}
              maxLength={64}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  save();
                }
                if (event.key === "Escape") {
                  setEditing(false);
                  setName(tag.name);
                }
              }}
            />
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Save ${tag.name}`}
              disabled={pending || !name.trim()}
              onClick={save}
            >
              <Check />
            </Button>
          </>
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate text-sm">{tag.name}</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {tag.keywordCount}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Rename ${tag.name}`}
              disabled={pending}
              onClick={() => {
                setName(tag.name);
                setEditing(true);
              }}
            >
              <Pencil />
            </Button>
          </>
        )}
        <InlineConfirm
          label={`Delete tag ${tag.name}`}
          confirmLabel="Delete"
          pending={pending}
          onConfirm={onDelete}
        />
      </div>
      <div className="flex items-center gap-1">
        {TAG_COLOR_KEYS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`Set ${tag.name} color to ${color}`}
            aria-pressed={resolved === color}
            disabled={pending}
            onClick={() => onColor(color)}
            className={cn(
              "size-4 rounded-full border border-border/60 outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              tagSwatchClass(color),
              resolved === color && "ring-2 ring-foreground/40",
            )}
          />
        ))}
      </div>
    </div>
  );
}
