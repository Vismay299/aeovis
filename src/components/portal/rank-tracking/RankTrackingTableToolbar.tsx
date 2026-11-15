// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/RankTrackingTableToolbar.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { CalendarDays, SlidersHorizontal, Table } from "lucide-react";
import { SegmentedToggle } from "@/components/app/SegmentedToggle";
import { ExportMenu } from "@/components/app/ExportMenu";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/app/Spinner";
import { MoreMenu } from "./ToolbarMenus";
import type { RankRunView } from "./hooks/useRankRunPolling";

export function RankTrackingTableToolbar({
  showFilters,
  onToggleFilters,
  activeFilterCount,
  isRunning,
  latestRun,
  keywordCount,
  viewMode,
  onViewModeChange,
  historyAvailable,
  onExport,
  onCheckRankings,
  onRefreshMetrics,
  metricsRefreshing,
  trackedKeywordCount,
  checkBusy,
  hasData,
}: {
  showFilters: boolean;
  onToggleFilters: () => void;
  activeFilterCount: number;
  isRunning: boolean;
  latestRun: RankRunView | null | undefined;
  keywordCount: number;
  viewMode: "table" | "history";
  onViewModeChange: (v: "table" | "history") => void;
  historyAvailable: boolean;
  onExport: (action: "sheets" | "csv" | "copy-list") => void;
  onCheckRankings: () => void;
  onRefreshMetrics: (opts?: { maxUsd?: number }) => void;
  metricsRefreshing: boolean;
  trackedKeywordCount: number;
  checkBusy: boolean;
  hasData: boolean;
}) {
  const phaseLabel =
    latestRun?.phase === "rechecking"
      ? "Re-checking results that look wrong"
      : "Checking keywords";

  return (
    <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 border-y border-border bg-card">
      {historyAvailable && (
        <SegmentedToggle
          items={[
            {
              value: "table" as const,
              icon: <Table className="size-3.5" />,
              label: "Latest",
            },
            {
              value: "history" as const,
              icon: <CalendarDays className="size-3.5" />,
              label: "History",
            },
          ]}
          value={viewMode}
          onChange={(v) => onViewModeChange(v as "table" | "history")}
        />
      )}

      <Button
        variant="outline"
        size="sm"
        aria-pressed={showFilters}
        className={showFilters ? "bg-muted text-foreground" : ""}
        onClick={onToggleFilters}
        title="Toggle table filters"
      >
        <SlidersHorizontal data-icon="inline-start" className="size-3.5" />
        Filters
        {activeFilterCount > 0 && <Badge size="sm">{activeFilterCount}</Badge>}
      </Button>

      {isRunning && latestRun ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="size-3.5 text-primary" />
          <span>
            {phaseLabel} {latestRun.keywordsChecked}/{latestRun.keywordsTotal || "?"}
          </span>
          {latestRun.keywordsTotal > 0 && (
            <Progress
              className="w-24"
              aria-label="Rank check progress"
              aria-valuenow={latestRun.keywordsChecked}
              value={latestRun.keywordsChecked}
              max={latestRun.keywordsTotal}
            />
          )}
        </div>
      ) : (
        <span className="text-sm text-muted-foreground">
          {keywordCount} keywords
        </span>
      )}

      <div className="flex-1" />

      <ExportMenu
        actions={["sheets", "csv", "copy-list"]}
        copyListLabel="Copy keyword list"
        onExport={onExport}
        disabled={!hasData}
      />

      <MoreMenu
        onCheckRankings={onCheckRankings}
        checkBusy={checkBusy}
        onRefreshMetrics={onRefreshMetrics}
        metricsRefreshing={metricsRefreshing}
        trackedKeywordCount={trackedKeywordCount}
        hasData={hasData}
      />
    </div>
  );
}
