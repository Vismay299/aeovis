// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/RankTrackingHistoryMatrix.tsx:27-194
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useMemo } from "react";
import { CircleSlash } from "lucide-react";
import { EmptyState } from "@/components/app/EmptyState";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export type RankPositionMatrixCell = {
  runId: string;
  checkedAt: string;
  trackingKeywordId: string | null;
  position: number | null;
};

interface MatrixRun {
  runId: string;
  checkedAt: string;
}

export function countMatrixRuns(cells: RankPositionMatrixCell[]): number {
  return new Set(cells.map((c) => c.runId)).size;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function buildMatrix(cells: RankPositionMatrixCell[]): {
  runs: MatrixRun[];
  cellByKeyword: Map<string, Map<string, number | null>>;
} {
  const runMap = new Map<string, string>(); // runId -> checkedAt
  const cellByKeyword = new Map<string, Map<string, number | null>>();
  for (const c of cells) {
    if (!c.trackingKeywordId) continue;
    runMap.set(c.runId, c.checkedAt);
    let byRun = cellByKeyword.get(c.trackingKeywordId);
    if (!byRun) {
      byRun = new Map();
      cellByKeyword.set(c.trackingKeywordId, byRun);
    }
    byRun.set(c.runId, c.position);
  }
  const runs = Array.from(runMap.entries())
    .map(([runId, checkedAt]) => ({ runId, checkedAt }))
    .sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));
  return { runs, cellByKeyword };
}

function NotCheckedCell() {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label="Not checked"
            className="inline-flex cursor-help items-center justify-end text-muted-foreground"
          >
            <CircleSlash className="size-3.5" aria-hidden />
          </span>
        }
      >
        <span
          aria-label="Not checked"
          className="inline-flex cursor-help items-center justify-end text-muted-foreground"
        >
          <CircleSlash className="size-3.5" aria-hidden />
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Not checked: check failed, no position recorded.
      </TooltipContent>
    </Tooltip>
  );
}

function MatrixCell({
  position,
  previous,
}: {
  position: number | null;
  previous: number | null | undefined;
}) {
  if (position === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  const change =
    previous != null && previous !== undefined ? previous - position : null;
  return (
    <span className="inline-flex items-center justify-end gap-1 font-mono text-xs">
      <span>{position}</span>
      {change != null && change > 0 && (
        <span className="text-success font-semibold">▲{change}</span>
      )}
      {change != null && change < 0 && (
        <span className="text-warning font-semibold">▼{-change}</span>
      )}
    </span>
  );
}

export function RankTrackingHistoryMatrix({
  cells,
  keywords,
  onClearFilters,
}: {
  cells: RankPositionMatrixCell[];
  keywords: { trackingKeywordId: string; keyword: string }[];
  onClearFilters: () => void;
}) {
  const { runs, cellByKeyword } = useMemo(() => buildMatrix(cells), [cells]);

  if (keywords.length === 0) {
    return (
      <EmptyState
        kind="filtered"
        title="No keywords match these filters"
        description="Change or clear the filters to see more keywords."
        action={
          <Button variant="outline" size="sm" onClick={onClearFilters}>
            Clear filters
          </Button>
        }
      />
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="sticky left-0 z-10 w-full min-w-[200px] bg-card">
              Keyword
            </TableHead>
            {runs.map((r) => (
              <TableHead key={r.runId} className="w-24 text-right whitespace-nowrap">
                {formatDate(r.checkedAt)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {keywords.map((kw) => {
            const byRun = cellByKeyword.get(kw.trackingKeywordId);
            return (
              <TableRow key={kw.trackingKeywordId}>
                <TableCell className="sticky left-0 z-10 bg-card font-medium whitespace-nowrap">
                  {kw.keyword}
                </TableCell>
                {runs.map((r, i) => {
                  const notChecked =
                    !byRun?.has(r.runId) &&
                    runs.slice(0, i).some((prev) => byRun?.has(prev.runId));
                  const position = byRun?.get(r.runId) ?? null;
                  const previous =
                    i > 0 ? (byRun?.get(runs[i - 1].runId) ?? null) : undefined;
                  return (
                    <TableCell key={r.runId} className="text-right">
                      {notChecked ? (
                        <NotCheckedCell />
                      ) : (
                        <MatrixCell position={position} previous={previous} />
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
