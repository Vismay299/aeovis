// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/RankTrackingTrendChart.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import type { ComponentProps } from "react";
import { Line, LineChart, ReferenceArea } from "recharts";
import { TrendingUp } from "lucide-react";
import { EmptyState } from "@/components/app/EmptyState";
import { SegmentedToggle } from "@/components/app/SegmentedToggle";
import {
  ChartGrid,
  ChartXAxis,
  ChartYAxis,
} from "@/components/app/ChartAxes";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";

export interface TrendSeries {
  dataKey: string;
  name: string;
  color: string;
  strokeDasharray?: string;
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
  valueFormatter?: ComponentProps<typeof ChartTooltipContent>["valueFormatter"];
  showBottomBand?: boolean;
}) {
  const config: ChartConfig = Object.fromEntries(
    series.map((s) => [s.dataKey, { label: s.name, color: s.color }]),
  );

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span>Google position (1 = best)</span>
        <span className="inline-flex items-center gap-1">
          Better <span aria-hidden>↑</span>
        </span>
      </div>
      <ChartContainer config={config} className="h-56">
        <LineChart
          data={data}
          margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
        >
          <ChartGrid />
          {showBottomBand && (
            <ReferenceArea
              y1={serpDepth - 0.5}
              y2={serpDepth}
              fill="currentColor"
              fillOpacity={0.06}
              ifOverflow="extendDomain"
            />
          )}
          <ChartXAxis {...TIME_AXIS} />
          <ChartYAxis
            reversed
            domain={[1, serpDepth]}
            allowDecimals={false}
            width={32}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={formatDateLabel}
                valueFormatter={valueFormatter}
              />
            }
          />
          {series.map((s) => (
            <Line
              key={s.dataKey}
              type="monotone"
              dataKey={s.dataKey}
              stroke={s.color}
              strokeWidth={2}
              strokeDasharray={s.strokeDasharray}
              dot={{ r: 2 }}
              activeDot={{ r: 4 }}
              connectNulls={false}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ChartContainer>
    </div>
  );
}

function formatDateTick(value: number): string {
  return new Date(value).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
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

export const TIME_AXIS = {
  dataKey: "checkedAt",
  type: "number",
  scale: "time",
  domain: ["dataMin", "dataMax"],
  tickFormatter: formatDateTick,
} as const;

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
