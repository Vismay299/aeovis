"use client";

import { Line, LineChart } from "recharts";
import {
  ChartGrid,
  ChartXAxis,
  ChartYAxis,
} from "@/components/app/ChartAxes";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatNumber, type BacklinksSnapshot } from "@/shared/backlinks";
import type { SnapshotInterval } from "./hooks/useSnapshotTargets";

const config = {
  backlinks: { label: "Backlinks", color: "#2563eb" },
  referringDomains: { label: "Referring domains", color: "#14b8a6" },
} satisfies ChartConfig;

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
        <ChartContainer config={config} className="h-56" aria-label="Backlink trend chart">
          <>
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
            <LineChart data={points} margin={{ left: 8, right: 8, top: 8, bottom: 0 }}>
              <ChartGrid />
              <ChartXAxis dataKey="date" tickFormatter={formatMonth} minTickGap={24} />
              <ChartYAxis width={60} tickFormatter={formatAxisValue} />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    labelFormatter={(value) => formatDate(String(value))}
                    valueFormatter={(value) => typeof value === "number" ? formatNumber(value) : "—"}
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Line
                type="monotone"
                dataKey="backlinks"
                stroke="var(--color-backlinks)"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
              />
              <Line
                type="monotone"
                dataKey="referringDomains"
                stroke="var(--color-referringDomains)"
                strokeWidth={2}
                dot={false}
                connectNulls={false}
              />
            </LineChart>
          </>
        </ChartContainer>
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
