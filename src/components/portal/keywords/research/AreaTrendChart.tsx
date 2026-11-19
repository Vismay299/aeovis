// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/keywords/components/DisplayPrimitives.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { curveMonotoneX } from "d3-shape";
import { ChartTooltip, Grid, Line, LineChart, XAxis } from "@/components/charts";
import { TooltipContent } from "@/components/charts/tooltip";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { KeywordRow } from "./hooks/useKeywordResearchData";

const COLOR = "var(--color-primary)";

/**
 * Monthly search volume as a Bklit line. Each month is placed at its first
 * day on the time axis; the tick and tooltip labels stay the month text.
 */
export function AreaTrendChart({ row }: { row: KeywordRow }) {
  if (!row.trend?.length) return null;
  const data = row.trend
    .map((point) => ({
      ...point,
      monthStart: new Date(point.year, point.month - 1, 1).getTime(),
      searchVolume:
        typeof point.searchVolume === "number" && Number.isFinite(point.searchVolume)
          ? point.searchVolume
          : null,
      label: new Date(point.year, point.month - 1).toLocaleString("en", { month: "short", year: "2-digit" }),
    }))
    .sort((a, b) => a.monthStart - b.monthStart);
  const labels = data.map((point) => point.label);
  const first = data[0]?.label;
  const last = data[data.length - 1]?.label;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Search Trends</CardTitle>
        <p className="text-xs text-muted-foreground">{first} - {last}</p>
      </CardHeader>
      <CardContent className="h-44 min-w-0">
        <LineChart
          data={data}
          xDataKey="monthStart"
          aspectRatio=""
          className="h-full"
          margin={{ left: 8, right: 8, top: 8, bottom: 28 }}
        >
          <Grid horizontal />
          <Line dataKey="searchVolume" stroke={COLOR} strokeWidth={2} curve={curveMonotoneX} fadeEdges={false} />
          <XAxis labels={labels} />
          <ChartTooltip
            dateLabels={labels}
            content={({ point }) => (
              <TooltipContent
                title={String(point.label ?? "")}
                rows={[
                  {
                    color: COLOR,
                    // The series name Recharts showed in this tooltip.
                    label: "searchVolume",
                    value: typeof point.searchVolume === "number" ? point.searchVolume.toLocaleString() : "—",
                  },
                ]}
              />
            )}
          />
        </LineChart>
      </CardContent>
    </Card>
  );
}
