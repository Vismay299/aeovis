// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/RankTrackingTrendChart.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { curveMonotoneX } from "d3-shape";
import { TrendingUp } from "lucide-react";
import {
  ChartTooltip,
  Grid,
  Line,
  LineChart,
  ReferenceArea,
  XAxis,
  YAxis,
} from "@/components/charts";
import { TooltipContent } from "@/components/charts/tooltip";
import { EmptyState } from "@/components/app/EmptyState";
import { SegmentedToggle } from "@/components/app/SegmentedToggle";

export interface TrendSeries {
  dataKey: string;
  name: string;
  color: string;
}

/** Formats one plotted position for the tooltip. */
export type RankValueFormatter = (
  value: number,
  dataKey: string,
  point: Record<string, unknown>,
) => string;

/** The chart's x key: check time in epoch milliseconds. */
export const TIME_KEY = "checkedAt";

/**
 * Rank tick values from 1 down to `serpDepth`: 1, then round steps. The
 * position axis is reversed, so 1 (best) is drawn at the top.
 */
export function rankTicks(serpDepth: number): number[] {
  const depth = Math.max(1, Math.round(serpDepth));
  const step = depth <= 10 ? 2 : depth <= 20 ? 5 : depth <= 50 ? 10 : 25;
  const ticks = [1];
  for (let value = step; value <= depth; value += step) ticks.push(value);
  return ticks;
}

export function RankTrendChart({
  data,
  series,
  serpDepth,
  valueFormatter,
  showBottomBand = false,
}: {
  data: Array<Record<string, unknown>>;
  series: TrendSeries[];
  serpDepth: number;
  valueFormatter?: RankValueFormatter;
  showBottomBand?: boolean;
}) {
  const ticks = rankTicks(serpDepth);
  const labels = data.map((row) => formatDateTick(row[TIME_KEY]));

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Google position (1 = best)</span>
        <span className="inline-flex items-center gap-1">
          Better <span aria-hidden>↑</span>
        </span>
      </div>
      <LineChart
        data={data}
        xDataKey={TIME_KEY}
        aspectRatio=""
        className="h-56"
        animationDuration={700}
        margin={{ top: 8, right: 8, bottom: 28, left: 32 }}
        // Reversed position axis: [serpDepth, 1] puts rank 1 at the top.
        yDomainOverrides={{ left: () => [serpDepth, 1] }}
      >
        <Grid horizontal rowTickValues={ticks} />
        {showBottomBand ? (
          <ReferenceArea y1={serpDepth - 0.5} y2={serpDepth} />
        ) : null}
        {series.map((s) => (
          <Line
            key={s.dataKey}
            dataKey={s.dataKey}
            stroke={s.color}
            strokeWidth={2}
            curve={curveMonotoneX}
            fadeEdges={false}
          />
        ))}
        <YAxis tickValues={ticks} allowDecimals={false} />
        <XAxis labels={labels} />
        <ChartTooltip
          dateLabels={labels}
          content={({ point }) => (
            <TooltipContent
              title={formatDateLabel(point[TIME_KEY])}
              rows={series.flatMap((s) => {
                const value = point[s.dataKey];
                // A device with no check at this time has no row, as before.
                if (typeof value !== "number") return [];
                return [
                  {
                    color: s.color,
                    label: s.name,
                    value: valueFormatter
                      ? valueFormatter(value, s.dataKey, point)
                      : String(value),
                  },
                ];
              })}
            />
          )}
        />
      </LineChart>
    </div>
  );
}

function formatDateTick(value: unknown): string {
  return typeof value === "number"
    ? new Date(value).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
      })
    : "";
}

export function formatDateLabel(label: unknown): string {
  return typeof label === "number"
    ? new Date(label).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "";
}

/** X-axis tick labels for rows keyed by {@link TIME_KEY}. */
export function timeTickLabels(rows: ReadonlyArray<Record<string, unknown>>) {
  return rows.map((row) => formatDateTick(row[TIME_KEY]));
}

const TREND_RANGES = [
  { value: "30", label: "30d", icon: null },
  { value: "90", label: "90d", icon: null },
  { value: "730", label: "All", icon: null },
];

export function TrendRangeToggle({
  value,
  onChange,
}: {
  value: number;
  onChange: (sinceDays: number) => void;
}) {
  return (
    <SegmentedToggle
      items={TREND_RANGES}
      value={String(value)}
      onChange={(next) => onChange(Number(next))}
      showLabels
    />
  );
}

export function TrendEmptyState({ checks }: { checks: number }) {
  return (
    <EmptyState
      icon={TrendingUp}
      size="sm"
      title={checks === 0 ? "No history yet" : "Only 1 check so far"}
      description={
        checks === 0
          ? "Run a check to start tracking positions over time."
          : "The trend fills in after the next check."
      }
    />
  );
}
