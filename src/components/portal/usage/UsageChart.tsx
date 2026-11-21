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
import {
  Bar,
  BarChart,
  BarXAxis,
  ChartTooltip,
  Grid,
  YAxis,
} from "@/components/charts";
import { ChartLegend } from "@/components/app/ChartLegend";
import { formatUsd } from "@/shared/money";
import type { WorkspaceUsage } from "@/shared/costs";

const KNOWN_COLOR = "var(--chart-1)";
const UNKNOWN_COLOR = "var(--chart-2)";

const LEGEND = [
  { label: "Priced or reported", color: KNOWN_COLOR },
  { label: "Estimated (cost not reported)", color: UNKNOWN_COLOR },
];

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

/**
 * One line for the whole day: the accounted total and, when any call was
 * unpriced, the estimated part inside it.
 */
function UsageTooltip({ day }: { day: UsageDay }) {
  return (
    <div className="px-2.5 py-1.5 text-xs text-popover-foreground">
      {`${formatShortDate(day.date)}: ${formatUsd(day.usd)} (${formatUsd(day.unknownUsd)} estimated)`}
    </div>
  );
}

/**
 * Bars are categories, so each day needs a unique label: "Sep 22", or the
 * full date when a range repeats a short label (it spans more than a year).
 */
function dayLabels(days: readonly UsageDay[]): string[] {
  const short = days.map((day) => formatShortDate(day.date));
  return new Set(short).size === short.length
    ? short
    : days.map((day) => day.date);
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

  const labels = dayLabels(days);
  const bars = days.map((day, index) => ({ ...day, label: labels[index] }));

  return (
    <div
      className="flex h-40 w-full flex-col md:h-56"
      aria-label={`Daily spend, ${range}`}
    >
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
      <BarChart
        data={bars}
        xDataKey="label"
        stacked
        aspectRatio=""
        className="min-h-0 flex-1"
        animationDuration={700}
        margin={{ left: 64, right: 8, top: 8, bottom: 32 }}
      >
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
              fill={UNKNOWN_COLOR}
              fillOpacity={0.2}
            />
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="8"
              stroke={UNKNOWN_COLOR}
              strokeWidth="2"
            />
          </pattern>
        </defs>
        <Grid horizontal />
        <Bar dataKey="knownUsd" fill={KNOWN_COLOR} lineCap="butt" />
        <Bar
          dataKey="unknownUsd"
          fill={`url(#${hatchId})`}
          stroke={UNKNOWN_COLOR}
          lineCap="butt"
        />
        <YAxis formatValue={formatTooltipValue} />
        <BarXAxis />
        <ChartTooltip
          content={({ point }) => <UsageTooltip day={point as UsageDay} />}
        />
      </BarChart>
      <ChartLegend items={LEGEND} />
    </div>
  );
}
