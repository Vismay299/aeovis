"use client";

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
import { formatNumber, type BacklinksSnapshot } from "@/shared/backlinks";
import type { SnapshotInterval } from "./hooks/useSnapshotTargets";

const SERIES = [
  { key: "backlinks", label: "Backlinks", color: "var(--chart-1)" },
  { key: "referringDomains", label: "Referring domains", color: "var(--chart-3)" },
] as const;

type ChartPoint = {
  date: string;
  backlinks: number | null;
  referringDomains: number | null;
};

export function TrackedHistoryPanel({
  snapshots,
  interval,
}: {
  snapshots: BacklinksSnapshot[];
  interval?: SnapshotInterval | null;
}) {
  if (snapshots.length === 0) return null;

  const cadence = interval ?? inferInterval(snapshots);
  const points = withMissingPeriods(snapshots, cadence);
  const firstDate = formatDate(snapshots[0].capturedOn);
  // Missing periods are null rows: the lines break there instead of joining.
  const rows = points.map((point) => ({ ...point, time: dayToTime(point.date) }));
  const labels = rows.map((row) => formatMonth(row.date));

  return (
    <section className="space-y-2 rounded-lg border border-border p-3" aria-labelledby="tracked-history-title">
      <div>
        <h3 id="tracked-history-title" className="text-sm font-medium">Tracked history</h3>
        {snapshots.length >= 2 ? (
          <p className="text-xs text-muted-foreground">
            Saved {cadence} since {firstDate}. Free to view.
          </p>
        ) : null}
      </div>
      {snapshots.length < 2 ? (
        <div className="space-y-1">
          <p className="text-sm text-muted-foreground">
            One snapshot so far. The chart appears after the next one.
          </p>
          <p className="text-xs text-muted-foreground">
            {firstDate} · Backlinks {formatNumber(snapshots[0].backlinks)} · Referring domains {formatNumber(snapshots[0].referringDomains)}
          </p>
        </div>
      ) : (
        <div className="flex h-56 flex-col" aria-label="Backlink trend chart">
          <div className="sr-only">
            <table>
              <caption>Tracked backlink trend data</caption>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Backlinks</th>
                  <th scope="col">Referring domains</th>
                </tr>
              </thead>
              <tbody>
                {points.map((point, index) => (
                  <tr key={`${point.date}-${index}`}>
                    <td>{point.date}</td>
                    <td>{formatNumber(point.backlinks)}</td>
                    <td>{formatNumber(point.referringDomains)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <LineChart
            data={rows}
            xDataKey="time"
            aspectRatio=""
            className="min-h-0 flex-1"
            margin={{ left: 60, right: 8, top: 8, bottom: 28 }}
          >
            <Grid horizontal />
            {SERIES.map((series) => (
              <Line
                key={series.key}
                dataKey={series.key}
                stroke={series.color}
                strokeWidth={2}
                curve={curveMonotoneX}
                fadeEdges={false}
              />
            ))}
            <YAxis formatValue={formatAxisValue} />
            <XAxis labels={labels} />
            <ChartTooltip
              dateLabels={labels}
              content={({ point }) => (
                <TooltipContent
                  title={formatDate(String(point.date))}
                  rows={SERIES.map((series) => {
                    const value = point[series.key];
                    return {
                      color: series.color,
                      label: series.label,
                      value: typeof value === "number" ? formatNumber(value) : "—",
                    };
                  })}
                />
              )}
            />
          </LineChart>
          <ChartLegend items={SERIES} />
        </div>
      )}
    </section>
  );
}

function withMissingPeriods(
  snapshots: BacklinksSnapshot[],
  interval: SnapshotInterval,
): ChartPoint[] {
  const sorted = [...snapshots].sort((a, b) => a.capturedOn.localeCompare(b.capturedOn));
  const points: ChartPoint[] = [];
  for (let index = 0; index < sorted.length; index++) {
    const current = sorted[index];
    points.push({
      date: current.capturedOn,
      backlinks: current.backlinks,
      referringDomains: current.referringDomains,
    });
    const next = sorted[index + 1];
    if (!next) continue;
    let expected = addPeriod(current.capturedOn, interval);
    let inserted = 0;
    while (expected < next.capturedOn && inserted < 24) {
      points.push({ date: expected, backlinks: null, referringDomains: null });
      expected = addPeriod(expected, interval);
      inserted += 1;
    }
  }
  return points;
}

function addPeriod(value: string, interval: SnapshotInterval) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (interval === "weekly") date.setUTCDate(date.getUTCDate() + 7);
  else {
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const day = date.getUTCDate();
    const currentMonthLastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    const nextMonthLastDay = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(month + 1);
    date.setUTCDate(
      day === currentMonthLastDay ? nextMonthLastDay : Math.min(day, nextMonthLastDay),
    );
  }
  return date.toISOString().slice(0, 10);
}

function inferInterval(snapshots: BacklinksSnapshot[]): SnapshotInterval {
  if (snapshots.length < 2) return "weekly";
  const first = new Date(`${snapshots[0].capturedOn}T00:00:00.000Z`).getTime();
  const last = new Date(`${snapshots[snapshots.length - 1].capturedOn}T00:00:00.000Z`).getTime();
  const averageDays = (last - first) / 86_400_000 / (snapshots.length - 1);
  return averageDays >= 20 ? "monthly" : "weekly";
}

function formatDate(value: string) {
  const date = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/** "YYYY-MM-DD" at UTC midnight, matching how the periods are stepped. */
function dayToTime(value: string) {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`).getTime();
}

function formatMonth(value: unknown) {
  if (typeof value !== "string") return "";
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" });
}

function formatAxisValue(value: unknown) {
  if (typeof value !== "number") return "";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(0)}K`;
  return String(value);
}
