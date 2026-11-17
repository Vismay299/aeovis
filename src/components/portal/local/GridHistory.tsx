"use client";

import { CardShell } from "@/components/app/CardShell";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/shared/utils";
import type { GridSummaryRow } from "./hooks/useLocalGrid";

export type GridHistoryProps = {
  grids: GridSummaryRow[];
  currentGridId: string | null;
  onSelect: (gridId: string) => void;
  isLoading?: boolean;
};

/** Previous grids. Reading one is free: the run is already stored. */
export function GridHistory({
  grids,
  currentGridId,
  onSelect,
  isLoading = false,
}: GridHistoryProps) {
  return (
    <div data-slot="grid-history">
      <CardShell title="Grid history">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : grids.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No map ranking grids yet.
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {grids.map((grid) => {
              const isActive = grid.id === currentGridId;
              return (
                <Button
                  key={grid.id}
                  type="button"
                  variant={isActive ? "secondary" : "ghost"}
                  className={cn(
                    "justify-between",
                    isActive && "font-medium"
                  )}
                  aria-current={isActive ? "true" : undefined}
                  onClick={() => onSelect(grid.id)}
                >
                  <span className="truncate">{grid.keyword}</span>
                  <span className="ml-3 shrink-0 text-xs text-muted-foreground tabular-nums">
                    {`${grid.gridSize}×${grid.gridSize} · ${grid.spacingKm} km · ${new Date(
                      grid.createdAt
                    ).toLocaleDateString()}`}
                  </span>
                </Button>
              );
            })}
          </div>
        )}
      </CardShell>
    </div>
  );
}
