"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/billing/BillingUsageChart.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * F03 §6.6.1 — daily spend, stacked by how well the cost is known.
 *
 * `days[].usd` ALREADY contains `unknownUsd`, so the bars stack `knownUsd` then
 * `unknownUsd` rather than drawing `usd` itself. The estimated half is hatched
 * so the two halves are distinguishable without colour, and the same days are
 * repeated in a visually hidden table for screen readers.
 */

import { useId } from "react";
import { Bar, BarChart } from "recharts";
import { ChartGrid, ChartXAxis, ChartYAxis } from "@/components/app/ChartAxes";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
import { formatUsd } from "@/shared/money";
import type { WorkspaceUsage } from "@/shared/costs";

const usageChartConfig = {
  knownUsd: { label: "Priced or reported", color: "var(--chart-1)" },
  unknownUsd: {
    label: "Estimated (cost not reported)",
    color: "var(--chart-2)",
  },
} satisfies ChartConfig;

type UsageDay = WorkspaceUsage["days"][number];

/** A local calendar date (`YYYY-MM-DD`) as a local-midnight Date. */
function parseDay(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** "Sep 22" in the viewer's locale. */
function formatShortDate(date: string): string {
  const parsed = parseDay(date);
  if (!parsed) return date;
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatTooltipValue(value: unknown): string {
  return typeof value === "number" ? formatUsd(value) : "";
}

type TooltipPayloadEntry = { payload?: UsageDay };

/**
 * One line for the whole day: the accounted total and, when any call was
 * unpriced, the estimated part inside it.
 */
function UsageTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: readonly TooltipPayloadEntry[];
}) {
  if (!active || !payload?.length) return null;
  const day = payload[0]?.payload;
  if (!day) return null;

  return (
    <div className="rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-sm">
      {`${formatShortDate(day.date)}: ${formatUsd(day.usd)} (${formatUsd(day.unknownUsd)} estimated)`}
    </div>
  );
}

export function UsageChart({
  days,
  range,
}: {
  days: WorkspaceUsage["days"];
  range: WorkspaceUsage["range"];
}) {
  // React's id contains colons, which `url(#…)` cannot address.
  const hatchId = `usage-unknown-${useId().replace(/:/g, "")}`;
  const total = days.reduce((sum, day) => sum + day.usd, 0);

  if (total <= 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        No usage recorded yet
      </div>
    );
  }

  return (
    <ChartContainer
      config={usageChartConfig}
      className="h-40 w-full md:h-56"
      aria-label={`Daily spend, ${range}`}
    >
      <>
        <div className="sr-only">
          <table>
            <caption>{`Daily spend, ${range}`}</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Spend</th>
                <th scope="col">Estimated</th>
              </tr>
            </thead>
            <tbody>
              {days.map((day) => (
                <tr key={day.date}>
                  <td>{day.date}</td>
                  <td>{formatUsd(day.usd)}</td>
                  <td>{formatUsd(day.unknownUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <BarChart data={days} margin={{ left: 8, right: 8, top: 8, bottom: 0 }}>
          <defs>
            <pattern
              id={hatchId}
              width="8"
              height="8"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect
                width="8"
                height="8"
                fill="var(--color-unknownUsd)"
                fillOpacity={0.2}
              />
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="8"
                stroke="var(--color-unknownUsd)"
                strokeWidth="2"
              />
            </pattern>
          </defs>
          <ChartGrid />
          <ChartXAxis
            dataKey="date"
            tickFormatter={formatShortDate}
            minTickGap={24}
          />
          <ChartYAxis tickFormatter={formatTooltipValue} width={64} />
          <ChartTooltip content={<UsageTooltip />} />
          <ChartLegend content={<ChartLegendContent />} />
          <Bar
            dataKey="knownUsd"
            stackId="spend"
            fill="var(--color-knownUsd)"
            isAnimationActive={false}
          />
          <Bar
            dataKey="unknownUsd"
            stackId="spend"
            fill={`url(#${hatchId})`}
            stroke="var(--color-unknownUsd)"
            strokeWidth={1}
            isAnimationActive={false}
          />
        </BarChart>
      </>
    </ChartContainer>
  );
}
