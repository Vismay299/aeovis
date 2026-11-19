// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/RankTrackingOverview.tsx:30-163
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { curveMonotoneX } from "d3-shape";
import { fetchJson, withBrand } from "@/shared/query/fetchJson";
import { keys } from "@/shared/query/keys";
import { QueryState } from "@/components/app/QueryState";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  ChartTooltip,
  Grid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "@/components/charts";
import { TooltipContent as ChartTooltipContent } from "@/components/charts/tooltip";
import {
  formatDateLabel,
  TIME_KEY,
  timeTickLabels,
  TrendEmptyState,
  TrendRangeToggle,
} from "./RankTrendChart";

// Keyword counts per position bucket at each check. One line per bucket (the
// counts are read directly off the axis), not a stack.
const BUCKETS = [
  { key: "top3", label: "Top 3", color: "var(--chart-3)" },
  { key: "top4to10", label: "4–10", color: "var(--chart-1)" },
  { key: "top11to20", label: "11–20", color: "var(--chart-4)" },
  { key: "notRanking", label: "Not in top 20", color: "var(--chart-rival-1)" },
  {
    key: "notChecked",
    label: "Not checked",
    color: "var(--chart-rival-3)",
    hint: "Check failed, no position recorded.",
  },
] as const;

export type TrendPoint = {
  runId: string;
  checkedAt: string;
  top3: number;
  top4to10: number;
  top11to20: number;
  notRanking: number;
  notChecked: number;
  aiOverview: number;
  checked: number;
};

export function RankTrackingOverview({
  brandKey,
  configId,
  device,
}: {
  brandKey: string;
  configId: string;
  device: "desktop" | "mobile";
}) {
  const [sinceDays, setSinceDays] = useState(730);

  const trendQuery = useQuery({
    queryKey: keys.rankTrend(brandKey, configId, device, sinceDays),
    queryFn: ({ signal }) =>
      fetchJson<{ points: TrendPoint[] }>(
        withBrand(
          `/api/customer/rank-tracking/configs/${encodeURIComponent(configId)}/trend?device=${encodeURIComponent(device)}&sinceDays=${encodeURIComponent(sinceDays)}`,
          brandKey,
        ),
        { signal },
      ),
    enabled: Boolean(brandKey && configId),
  });

  const points = trendQuery.data?.points ?? [];

  const chartData = useMemo(
    () =>
      points.map((p) => ({
        checkedAt: new Date(p.checkedAt).getTime(),
        top3: p.top3,
        top4to10: p.top4to10,
        top11to20: p.top11to20,
        notRanking: p.notRanking,
        notChecked: p.notChecked,
      })),
    [points],
  );
  const tickLabels = useMemo(() => timeTickLabels(chartData), [chartData]);

  return (
    <div className="px-4 pt-4 pb-4">
      <div className="space-y-2 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-foreground">
            Position distribution
          </span>
          <TrendRangeToggle value={sinceDays} onChange={setSinceDays} />
        </div>

        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {BUCKETS.map((b) => {
            const className =
              "inline-flex items-center gap-1 text-[11px] text-muted-foreground";
            const swatch = (
              <span
                className="size-2 rounded-sm shrink-0"
                style={{ backgroundColor: b.color }}
              />
            );
            return "hint" in b ? (
              <Tooltip key={b.key}>
                <TooltipTrigger
                  render={
                    <span className={`${className} cursor-help`}>
                      {swatch}
                      <span className="underline decoration-dotted underline-offset-2">
                        {b.label}
                      </span>
                    </span>
                  }
                >
                  <span className={`${className} cursor-help`}>
                    {swatch}
                    <span className="underline decoration-dotted underline-offset-2">
                      {b.label}
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{b.hint}</TooltipContent>
              </Tooltip>
            ) : (
              <span key={b.key} className={className}>
                {swatch}
                {b.label}
              </span>
            );
          })}
        </div>

        <QueryState
          query={trendQuery}
          errorFallback="Failed to load position history"
          loading={<Skeleton className="h-[220px] w-full" />}
        >
          {() =>
            chartData.length <= 1 ? (
              <TrendEmptyState checks={chartData.length} />
            ) : (
              <>
                <LineChart
                  data={chartData}
                  xDataKey={TIME_KEY}
                  aspectRatio=""
                  className="h-[220px]"
                  animationDuration={700}
                  margin={{ top: 8, right: 8, bottom: 28, left: 28 }}
                >
                  <Grid horizontal />
                  {BUCKETS.map((b) => (
                    <Line
                      key={b.key}
                      dataKey={b.key}
                      stroke={b.color}
                      strokeWidth={2}
                      curve={curveMonotoneX}
                      fadeEdges={false}
                    />
                  ))}
                  <YAxis allowDecimals={false} />
                  <XAxis labels={tickLabels} />
                  <ChartTooltip
                    dateLabels={tickLabels}
                    content={({ point }) => (
                      <ChartTooltipContent
                        title={formatDateLabel(point[TIME_KEY])}
                        rows={BUCKETS.flatMap((b) => {
                          const value = point[b.key];
                          return typeof value === "number"
                            ? [{ color: b.color, label: b.label, value }]
                            : [];
                        })}
                      />
                    )}
                  />
                </LineChart>

                <table className="sr-only">
                  <caption>Position distribution history</caption>
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Top 3</th>
                      <th scope="col">4–10</th>
                      <th scope="col">11–20</th>
                      <th scope="col">Not in top 20</th>
                      <th scope="col">Not checked</th>
                    </tr>
                  </thead>
                  <tbody>
                    {points.map((p) => (
                      <tr key={p.runId}>
                        <td>{new Date(p.checkedAt).toLocaleDateString()}</td>
                        <td>{p.top3}</td>
                        <td>{p.top4to10}</td>
                        <td>{p.top11to20}</td>
                        <td>{p.notRanking}</td>
                        <td>{p.notChecked}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )
          }
        </QueryState>
      </div>
    </div>
  );
}
