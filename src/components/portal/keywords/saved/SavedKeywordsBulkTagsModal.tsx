// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/saved-keywords
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useMemo, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SegmentedToggle } from "@/components/app/SegmentedToggle";
import type {
  SavedKeywordRow,
  SavedKeywordTagSummary,
} from "@/shared/keywords";
import type { TagManageController } from "./hooks/useTagManage";

type Mode = "add" | "remove";

/**
 * PORT of the saved-keywords bulk tag dialog: add existing or new tags, or
 * remove tags from the selection.
 */
export function SavedKeywordsBulkTagsModal({
  selectedRows,
  tags,
  manage,
  onClose,
  onApplied,
}: {
  selectedRows: SavedKeywordRow[];
  tags: SavedKeywordTagSummary[];
  manage: TagManageController;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [mode, setMode] = useState<Mode>("add");
  const [query, setQuery] = useState("");
  const [checkedNames, setCheckedNames] = useState<string[]>([]);
  const [createdNames, setCreatedNames] = useState<string[]>([]);
  const [checkedTagIds, setCheckedTagIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const removableTags = useMemo(() => {
    const byId = new Map<string, SavedKeywordTagSummary>();
    for (const row of selectedRows) {
      for (const tag of row.tags) {
        if (byId.has(tag.id)) continue;
        byId.set(tag.id, {
          ...tag,
          keywordCount: tags.find((item) => item.id === tag.id)?.keywordCount ?? 0,
        });
      }
    }
    return [...byId.values()].sort((a, b) =>
      a.normalizedName.localeCompare(b.normalizedName),
    );
  }, [selectedRows, tags]);

  const options = mode === "add" ? tags : removableTags;
  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return options;
    return options.filter((tag) => tag.name.toLowerCase().includes(term));
  }, [options, query]);

  const trimmedQuery = query.trim();
  const exactMatch = options.some(
    (tag) => tag.normalizedName === trimmedQuery.toLowerCase(),
  );
  const canCreate =
    mode === "add" &&
    trimmedQuery.length > 0 &&
    trimmedQuery.length <= 64 &&
    !exactMatch &&
    !createdNames.some(
      (name) => name.toLowerCase() === trimmedQuery.toLowerCase(),
    );

  const addNames = [...checkedNames, ...createdNames];
  const selectionCount = mode === "add" ? addNames.length : checkedTagIds.length;

  const toggleName = (name: string) =>
    setCheckedNames((current) =>
      current.includes(name)
        ? current.filter((item) => item !== name)
        : [...current, name],
    );

  const toggleId = (id: string) =>
    setCheckedTagIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );

  const create = () => {
    if (!canCreate) return;
    setCreatedNames((current) => [...current, trimmedQuery]);
    setQuery("");
  };

  const apply = async () => {
    setError(null);
    const result = await manage.applyTags({
      savedKeywordIds: selectedRows.map((row) => row.id),
      ...(mode === "add" ? { addTags: addNames } : { removeTagIds: checkedTagIds }),
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onApplied();
    onClose();
  };

  const keywordCount = selectedRows.length;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent fullScreenOnMobile>
        <DialogHeader>
          <DialogTitle>Update tags</DialogTitle>
          <p className="text-sm text-muted-foreground">
            {`Changes apply to ${keywordCount} selected keyword${
              keywordCount === 1 ? "" : "s"
            }.`}
          </p>
        </DialogHeader>

        <div className="space-y-3">
          <SegmentedToggle<Mode>
            value={mode}
            onChange={(next) => {
              setMode(next);
              setError(null);
            }}
            showLabels
            items={[
              {
                value: "add",
                icon: <Plus />,
                label: `Add tags (${tags.length})`,
              },
              {
                value: "remove",
                icon: <Minus />,
                label: `Remove tags (${removableTags.length})`,
              },
            ]}
          />

          <Input
            aria-label="Search or create"
            placeholder="Search or create…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && canCreate) {
                event.preventDefault();
                create();
              }
            }}
          />

          {createdNames.length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {createdNames.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="rounded-full border border-border px-2 py-0.5 text-xs"
                  aria-label={`Remove new tag ${name}`}
                  onClick={() =>
                    setCreatedNames((current) =>
                      current.filter((item) => item !== name),
                    )
                  }
                >
                  {name}
                </button>
              ))}
            </div>
          ) : null}

          {canCreate ? (
            <Button variant="outline" size="sm" onClick={create}>
              {`Create “${trimmedQuery}”`}
            </Button>
          ) : null}

          <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border p-2">
            {filtered.length === 0 ? (
              <p className="px-1 py-2 text-sm text-muted-foreground">
                {mode === "add" && tags.length === 0
                  ? "No tags yet. Type a name above to create one."
                  : "No tags match that search."}
              </p>
            ) : mode === "add" ? (
              filtered.map((tag) => (
                <label
                  key={tag.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-accent"
                >
                  <Checkbox
                    aria-label={`Add ${tag.name}`}
                    checked={checkedNames.includes(tag.name)}
                    onCheckedChange={() => toggleName(tag.name)}
                  />
                  <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {tag.keywordCount}
                  </span>
                </label>
              ))
            ) : (
              filtered.map((tag) => (
                <label
                  key={tag.id}
                  className="flex cursor-pointer items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-accent"
                >
                  <Checkbox
                    aria-label={`Remove ${tag.name}`}
                    checked={checkedTagIds.includes(tag.id)}
                    onCheckedChange={() => toggleId(tag.id)}
                  />
                  <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {tag.keywordCount}
                  </span>
                </label>
              ))
            )}
          </div>

          {mode === "remove" ? (
            <p className="text-sm text-muted-foreground">
              {`${checkedTagIds.length} tag${
                checkedTagIds.length === 1 ? "" : "s"
              } will be removed`}
            </p>
          ) : null}

          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            disabled={manage.applying}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            pending={manage.applying}
            disabled={selectionCount === 0}
            onClick={() => void apply()}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
