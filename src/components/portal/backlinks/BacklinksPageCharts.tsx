"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/backlinks/BacklinksPageCharts.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

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
import type { BacklinksOverview } from "@/shared/backlinks";
import { formatNumber } from "@/shared/backlinks";

const trendChartConfig = {
  backlinks: { label: "Backlinks", color: "#2563eb" },
  referringDomains: { label: "Referring domains", color: "#14b8a6" },
} satisfies ChartConfig;

const newLostChartConfig = {
  lostBacklinks: { label: "Lost backlinks", color: "#ef4444" },
  newBacklinks: { label: "New backlinks", color: "#16a34a" },
} satisfies ChartConfig;

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
    <ChartContainer
      config={trendChartConfig}
      className="h-56"
      aria-label="Backlink trend chart"
    >
      <>
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
        <LineChart
          data={data}
          margin={{ left: 8, right: 8, top: 8, bottom: 0 }}
        >
          <ChartGrid />
          <ChartXAxis
            dataKey="date"
            tickFormatter={formatChartTick}
            minTickGap={24}
          />
          <ChartYAxis yAxisId="left" tickFormatter={formatAxisValue} width={60} />
          <ChartYAxis
            yAxisId="right"
            orientation="right"
            tickFormatter={formatAxisValue}
            width={60}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={formatChartLabel}
                valueFormatter={formatTooltipValue}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Line
            yAxisId="left"
            type="monotone"
            dataKey="backlinks"
            stroke="var(--color-backlinks)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
          />
          <Line
            yAxisId="right"
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
    <ChartContainer
      config={newLostChartConfig}
      className="h-56"
      aria-label="New and lost backlinks chart"
    >
      <>
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
        <LineChart
          data={data}
          margin={{ left: 8, right: 8, top: 8, bottom: 0 }}
        >
          <ChartGrid />
          <ChartXAxis
            dataKey="date"
            tickFormatter={formatChartTick}
            minTickGap={24}
          />
          <ChartYAxis tickFormatter={formatAxisValue} width={60} />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={formatChartLabel}
                valueFormatter={formatTooltipValue}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Line
            type="monotone"
            dataKey="lostBacklinks"
            stroke="var(--color-lostBacklinks)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
          />
          <Line
            type="monotone"
            dataKey="newBacklinks"
            stroke="var(--color-newBacklinks)"
            strokeWidth={2}
            dot={false}
            connectNulls={false}
          />
        </LineChart>
      </>
    </ChartContainer>
  );
}
