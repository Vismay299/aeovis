"use client";

/**
 * Visibility over time, as a Bklit line on a fixed 0–100% axis. Each scan is
 * a point at its scan time; the latest reading is labelled at the line's end.
 */

import { curveMonotoneX } from "d3-shape";
import { Card, EmptyState, ProgressBar, Skeleton, formatPct } from "../ui";
import { TrendingUp } from "lucide-react";
import { ChartTooltip, Grid, Line, LineChart, XAxis, YAxis } from "@/components/charts";
import { useChartStable } from "@/components/charts/chart-context";
import { TooltipContent } from "@/components/charts/tooltip";
import { engineLabel, scanSeries, shortDate, toNumber } from "./overviewModel";

const GRID = [0, 25, 50, 75, 100];
const COLOR = "var(--primary)";

/**
 * The latest value, drawn above the last point. Reads the chart's scales, so
 * it sits on the line whatever the width. No `dataKey` prop on purpose: a
 * child with one would be registered as a series.
 */
function LatestValueLabel({ text }) {
  const { data, xScale, yScale, xAccessor, chartPhase } = useChartStable();
  const last = data[data.length - 1];
  if (!last || typeof last.visibility !== "number" || chartPhase !== "ready") return null;
  const x = xScale(xAccessor(last)) ?? 0;
  const y = yScale(last.visibility) ?? 0;
  return (
    <text
      x={x}
      y={y - 12}
      textAnchor="end"
      className="fill-foreground text-xs font-semibold tabular-nums"
      aria-hidden="true"
    >
      {text}
    </text>
  );
}

function Chart({ points }) {
  // A scan without a timestamp cannot be placed on the time axis; it stays in
  // the text summary below but is not drawn.
  const data = points
    .map((p) => ({ ...p, time: p.at ? new Date(p.at).getTime() : Number.NaN }))
    .filter((p) => Number.isFinite(p.time));
  const labels = data.map((p) => shortDate(p.at));
  const last = data[data.length - 1] ?? points[points.length - 1];
  const summary = points.map((p) => `${shortDate(p.at)}: ${formatPct(p.visibility)}`).join(", ");

  return (
    <div className="pt-6" role="img" aria-label={`AI visibility by scan. ${summary}.`}>
      <LineChart
        data={data}
        xDataKey="time"
        aspectRatio=""
        className="h-[230px]"
        margin={{ top: 8, right: 12, bottom: 28, left: 44 }}
        yDomainOverrides={{ left: [0, 100] }}
      >
        <Grid horizontal rowTickValues={GRID} />
        <Line
          dataKey="visibility"
          stroke={COLOR}
          strokeWidth={2}
          curve={curveMonotoneX}
          fadeEdges={false}
          showMarkers
          markers={{ radius: 3.5, fill: "var(--background)", stroke: COLOR, strokeWidth: 2 }}
        />
        <LatestValueLabel text={formatPct(last.visibility)} />
        <YAxis tickValues={GRID} formatValue={(v) => `${v}%`} />
        <XAxis labels={labels} />
        <ChartTooltip
          dateLabels={labels}
          content={({ point }) => (
            <TooltipContent
              title={shortDate(point.at)}
              rows={[{ color: COLOR, label: "Visibility", value: formatPct(point.visibility) }]}
            />
          )}
        />
      </LineChart>
    </div>
  );
}

function ByEngine({ metrics }) {
  const rows = (Array.isArray(metrics) ? metrics : []).filter((row) => row && row.date);
  if (!rows.length) return null;
  const latestDate = rows.reduce((max, row) => (String(row.date) > max ? String(row.date) : max), "");
  const engines = rows
    .filter((row) => String(row.date) === latestDate && toNumber(row.visibility_pct) !== null)
    .map((row) => ({ engine: row.engine, value: toNumber(row.visibility_pct) }))
    .sort((a, b) => b.value - a.value);
  if (!engines.length) return null;

  return (
    <div className="grid gap-3 mt-5 pt-4 border-t border-border">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">By engine</h3>
      {engines.map((item) => (
        <div key={item.engine} className="flex items-center gap-3">
          <span className="w-40 text-sm text-foreground truncate">{engineLabel(item.engine)}</span>
          <div className="flex-1"><ProgressBar value={item.value} size="sm" label={`${engineLabel(item.engine)} visibility`} /></div>
          <span className="w-12 text-right text-sm font-medium tabular-nums text-foreground">{formatPct(item.value)}</span>
        </div>
      ))}
    </div>
  );
}

export default function VisibilityTrend({ overview }) {
  const loading = !overview;
  const points = loading ? [] : scanSeries(overview.scans);

  return (
    <Card title="Visibility over time" description="Share of tracked questions where AI engines named you">
      {loading ? (
        <Skeleton height={200} />
      ) : points.length < 2 ? (
        <EmptyState icon={TrendingUp} title="Your trend appears after your second scan">
          Each scan asks the same questions again, so the change over time becomes visible from the second run.
        </EmptyState>
      ) : (
        <Chart points={points} />
      )}
      {loading ? null : <ByEngine metrics={overview.metrics} />}
    </Card>
  );
}
