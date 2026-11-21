"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/backlinks/BacklinksPageCharts.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { curveMonotoneX } from "d3-shape";
import {
  ChartTooltip,
  Grid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "@/components/charts";
import { TooltipContent } from "@/components/charts/tooltip";
import { ChartLegend } from "@/components/app/ChartLegend";
import type { BacklinksOverview } from "@/shared/backlinks";
import { formatNumber } from "@/shared/backlinks";

type Series = { key: string; label: string; color: string; yAxisId?: string };

const TREND_SERIES: Series[] = [
  { key: "backlinks", label: "Backlinks", color: "var(--chart-1)", yAxisId: "left" },
  {
    key: "referringDomains",
    label: "Referring domains",
    color: "var(--chart-3)",
    yAxisId: "right",
  },
];

const NEW_LOST_SERIES: Series[] = [
  { key: "lostBacklinks", label: "Lost backlinks", color: "var(--chart-negative)" },
  { key: "newBacklinks", label: "New backlinks", color: "var(--chart-positive)" },
];

/** A provider date ("2026-08-01…") as local midnight, or null. */
function dateToTime(value: string | null | undefined): number | null {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? "");
  if (!parsed) return null;
  return new Date(
    Number(parsed[1]),
    Number(parsed[2]) - 1,
    Number(parsed[3]),
  ).getTime();
}

/**
 * Rows on a time axis, oldest first. Values stay as given: `null` (not
 * reported) is drawn as a gap, never as 0. Rows whose date cannot be read are
 * left out of the drawing; the screen-reader table still lists them.
 */
function toTimeRows<T extends { date: string }>(data: T[]) {
  return data
    .map((item) => ({ ...item, time: dateToTime(item.date) }))
    .filter((item): item is T & { time: number } => item.time !== null)
    .sort((a, b) => a.time - b.time);
}

function SeriesTrendChart({
  rows,
  series,
}: {
  rows: Array<Record<string, unknown> & { date: string }>;
  series: Series[];
}) {
  const labels = rows.map((row) => formatChartTick(row.date));
  const dualAxis = series.some((s) => s.yAxisId === "right");
  return (
    <div className="flex h-56 flex-col">
      <LineChart
        data={rows}
        xDataKey="time"
        aspectRatio=""
        className="min-h-0 flex-1"
        margin={{ left: 60, right: dualAxis ? 60 : 8, top: 8, bottom: 32 }}
      >
        <Grid horizontal />
        {series.map((s) => (
          <Line
            key={s.key}
            dataKey={s.key}
            yAxisId={s.yAxisId}
            stroke={s.color}
            strokeWidth={2}
            curve={curveMonotoneX}
            fadeEdges={false}
          />
        ))}
        <YAxis formatValue={formatAxisValue} />
        {dualAxis ? (
          <YAxis yAxisId="right" position="right" formatValue={formatAxisValue} />
        ) : null}
        <XAxis labels={labels} />
        <ChartTooltip
          dateLabels={labels}
          content={({ point }) => (
            <TooltipContent
              title={formatChartLabel(point.date)}
              rows={series.map((s) => ({
                color: s.color,
                label: s.label,
                value: formatTooltipValue(point[s.key]),
              }))}
            />
          )}
        />
      </LineChart>
      <ChartLegend items={series} />
    </div>
  );
}

function formatTooltipValue(value: unknown) {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return value;
  return "—";
}

function formatCompactDate(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatMonthLabel(value: string) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    year: "2-digit",
  });
}

function formatAxisValue(value: unknown) {
  if (typeof value !== "number") return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}

function formatChartTick(value: unknown) {
  return typeof value === "string" ? formatMonthLabel(value) : "";
}

function formatChartLabel(value: unknown) {
  return typeof value === "string" ? formatCompactDate(value) : "";
}

function EmptyChartState() {
  return (
    <div className="flex h-56 items-center justify-center text-sm text-muted-foreground">
      Not enough historical data yet.
    </div>
  );
}

export function BacklinksTrendChart({
  data,
}: {
  data: BacklinksOverview["trends"];
}) {
  if (!data || data.length === 0) {
    return <EmptyChartState />;
  }

  return (
    <div aria-label="Backlink trend chart">
      <div className="sr-only">
        <table>
          <caption>Backlink trend data</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Backlinks</th>
              <th scope="col">Referring domains</th>
            </tr>
          </thead>
          <tbody>
            {data.map((item) => (
              <tr key={item.date}>
                <td>{item.date}</td>
                <td>{item.backlinks ?? "—"}</td>
                <td>{item.referringDomains ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SeriesTrendChart rows={toTimeRows(data)} series={TREND_SERIES} />
    </div>
  );
}

export function BacklinksNewLostChart({
  data,
}: {
  data: BacklinksOverview["newLostTrends"];
}) {
  if (!data || data.length === 0) {
    return <EmptyChartState />;
  }

  return (
    <div aria-label="New and lost backlinks chart">
      <div className="sr-only">
        <table>
          <caption>New and lost backlinks data</caption>
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">New backlinks</th>
              <th scope="col">Lost backlinks</th>
            </tr>
          </thead>
          <tbody>
            {data.map((item) => (
              <tr key={item.date}>
                <td>{item.date}</td>
                <td>{item.newBacklinks ?? "—"}</td>
                <td>{item.lostBacklinks ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SeriesTrendChart rows={toTimeRows(data)} series={NEW_LOST_SERIES} />
    </div>
  );
}
