"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/app/ConfirmDialog";
import { Trash2 } from "lucide-react";
import type { SavedBusinessView } from "./hooks/useLocalBusinesses";

export type CompetitorListProps = {
  competitors: SavedBusinessView[];
  onRemove: (businessId: string) => Promise<unknown>;
  isRemoving?: boolean;
};

export function CompetitorList({
  competitors,
  onRemove,
  isRemoving,
}: CompetitorListProps) {
  const [toRemove, setToRemove] = useState<SavedBusinessView | null>(null);

  const isAtCap = competitors.length >= 10;

  return (
    <div className="space-y-4" data-slot="competitor-list">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">
          Saved competitors ({competitors.length}/10)
        </h3>
      </div>

      {isAtCap && (
        <div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
          You can save up to 10 local competitors. Remove one first.
        </div>
      )}

      {competitors.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No competitors saved yet. Search nearby businesses to save competitors.
        </p>
      ) : (
        <div className="divide-y divide-border rounded-md border border-border">
          {competitors.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between p-3 text-sm"
              data-slot="competitor-row"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium truncate">{c.title}</span>
                  {c.profile?.isClaimed === false && (
                    <Badge variant="outline" className="text-xs">
                      Unclaimed
                    </Badge>
                  )}
                </div>
                <div className="text-xs text-muted-foreground">
                  {c.profile?.category ?? "Competitor"}
                  {c.profile?.rating?.value != null && (
                    <span> · ★ {c.profile.rating.value} ({c.profile.rating.votes ?? 0})</span>
                  )}
                </div>
              </div>

              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={() => setToRemove(c)}
                disabled={isRemoving}
                aria-label={`Remove ${c.title}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      {toRemove && (
        <ConfirmDialog
          title={`Remove ${toRemove.title}?`}
          confirmLabel="Remove"
          destructive
          onClose={() => setToRemove(null)}
          onConfirm={async () => {
            await onRemove(toRemove.id);
            setToRemove(null);
          }}
        >
          Saved reviews and grids stay in history.
        </ConfirmDialog>
      )}
    </div>
  );
}
