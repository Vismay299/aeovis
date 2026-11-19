// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/dashboard/Ga4Card.tsx:43-180
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { curveMonotoneX } from "d3-shape";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { CardShell } from "@/components/app/CardShell";
import { MetricsTable } from "@/components/app/MetricsTable";
import {
  ChartTooltip,
  Grid,
  Line,
  LineChart,
  XAxis,
  YAxis,
} from "@/components/charts";
import { Ga4ErrorState } from "./Ga4ErrorState";
import { LimitedDataNotice } from "./LimitedDataNotice";

type OverviewCurrent = {
  sessions: number | null;
  activeUsers: number | null;
  engagedSessions: number | null;
  engagementRate: number | null;
  keyEvents: number | null;
  transactions: number | null;
  purchaseRevenue: number | null;
};

type OverviewComparison = Record<
  string,
  { percentChange: number | null } | null | undefined
>;

function formatInteger(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return Math.round(value).toLocaleString();
}

function formatRate(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatMoney(value: number | null, currency: string): string {
  if (value === null || !Number.isFinite(value)) return "—";
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return value.toLocaleString();
  }
}

function ChangeValue({ percentChange }: { percentChange: number | null }) {
  if (percentChange === null || !Number.isFinite(percentChange)) return <>—</>;
  const pct = percentChange * 100;
  const text = `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(1)}%`;
  const tone = pct >= 0 ? "text-emerald-600" : "text-destructive";
  return (
    <span className={tone}>
      {text}{" "}
      <span className="sr-only">{pct >= 0 ? "increase" : "decrease"}</span>
    </span>
  );
}

const SESSIONS_COLOR = "var(--chart-1)";

type TrendPoint = { date?: string; yearWeek?: string; sessions: number | null };

function shortDate(date: string): string {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!parsed) return date;
  return new Date(
    Number(parsed[1]),
    Number(parsed[2]) - 1,
    Number(parsed[3]),
  ).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const DAY_MS = 86_400_000;

/** A GA4 day ("2026-08-01" or "20260801") as local midnight, or null. */
function dayToTime(value: string): number | null {
  const parsed = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(value);
  if (!parsed) return null;
  return new Date(
    Number(parsed[1]),
    Number(parsed[2]) - 1,
    Number(parsed[3]),
  ).getTime();
}

/**
 * A year-week ("202632", "2026-W32") placed on the time axis at the Monday of
 * that ISO week. Only the position comes from this; labels and the tooltip
 * keep the year-week text exactly as Google Analytics sent it.
 */
function yearWeekToTime(value: string): number | null {
  const parsed = /^(\d{4})-?W?(\d{2})$/.exec(value);
  if (!parsed) return null;
  const year = Number(parsed[1]);
  const week = Number(parsed[2]);
  if (week < 1 || week > 53) return null;
  // ISO week 1 is the week holding January 4th.
  const jan4 = new Date(year, 0, 4);
  const week1Monday = new Date(year, 0, 4 - ((jan4.getDay() + 6) % 7));
  return new Date(
    week1Monday.getFullYear(),
    week1Monday.getMonth(),
    week1Monday.getDate() + (week - 1) * 7,
  ).getTime();
}

type ChartRow = {
  time: number;
  /** The x value as Google Analytics sent it (shown in the tooltip). */
  label: string;
  sessions: number | null;
};

/**
 * Trend rows on a real time axis, oldest first. A day (or week) missing
 * between two reported ones gets a `null` row, so the line breaks there
 * instead of joining across it: no data is drawn as a gap, never as 0.
 */
function toChartRows(trend: TrendPoint[], weekly: boolean): ChartRow[] {
  const step = weekly ? 7 * DAY_MS : DAY_MS;
  const rows = trend
    .map((point) => {
      const label = (weekly ? point.yearWeek : point.date) ?? "";
      const time = weekly ? yearWeekToTime(label) : dayToTime(label);
      return time === null
        ? null
        : {
            time,
            label,
            sessions:
              typeof point.sessions === "number" &&
              Number.isFinite(point.sessions)
                ? point.sessions
                : null,
          };
    })
    .filter((row): row is ChartRow => row !== null)
    .sort((a, b) => a.time - b.time);

  const out: ChartRow[] = [];
  for (const row of rows) {
    const previous = out[out.length - 1];
    if (previous) {
      // Round, not floor: a daylight-saving day is 23 or 25 hours long.
      const missing = Math.min(
        Math.round((row.time - previous.time) / step) - 1,
        MAX_GAP_ROWS,
      );
      for (let i = 1; i <= missing; i++) {
        const day = new Date(previous.time);
        day.setDate(day.getDate() + (weekly ? 7 : 1) * i);
        out.push({
          time: day.getTime(),
          label: weekly ? isoYearWeek(day, previous.label) : isoDay(day),
          sessions: null,
        });
      }
    }
    out.push(row);
  }
  return out;
}

/** Upper bound on gap rows between two reported points (a year of days). */
const MAX_GAP_ROWS = 366;

/** The ISO year-week of a Monday, written like `template` ("202632" or "2026-W32"). */
function isoYearWeek(monday: Date, template: string): string {
  // The ISO year is the year of that week's Thursday.
  const thursday = new Date(
    monday.getFullYear(),
    monday.getMonth(),
    monday.getDate() + 3,
  );
  const year = thursday.getFullYear();
  const week1 = yearWeekToTime(`${year}01`) ?? thursday.getTime();
  const week = Math.round((monday.getTime() - week1) / (7 * DAY_MS)) + 1;
  const ww = String(week).padStart(2, "0");
  return template.includes("-W") ? `${year}-W${ww}` : `${year}${ww}`;
}

function isoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function TrendTooltip({ point }: { point: ChartRow }) {
  return (
    <div className="px-2.5 py-1.5 text-xs text-popover-foreground">
      {`${point.label}: ${formatInteger(point.sessions)} sessions`}
    </div>
  );
}

function SessionsTrend({
  trend,
  weekly,
}: {
  trend: TrendPoint[];
  weekly: boolean;
}) {
  const rows = toChartRows(trend, weekly);
  const labels = rows.map((row) =>
    weekly ? row.label : shortDate(row.label),
  );
  return (
    <LineChart
      data={rows}
      xDataKey="time"
      aspectRatio=""
      className="h-32 w-full"
      animationDuration={700}
      margin={{ left: 44, right: 8, top: 8, bottom: 28 }}
    >
      <Grid horizontal />
      <Line
        dataKey="sessions"
        stroke={SESSIONS_COLOR}
        strokeWidth={2}
        curve={curveMonotoneX}
        fadeEdges={false}
      />
      <YAxis allowDecimals={false} />
      <XAxis labels={labels} />
      <ChartTooltip
        dateLabels={labels}
        content={({ point }) => <TrendTooltip point={point as ChartRow} />}
      />
    </LineChart>
  );
}

/**
 * The organic overview card (§6.6.3): period comparison metrics plus a daily
 * (or weekly) sessions trend. Gaps in the trend are drawn as gaps.
 */
export function OrganicOverviewCard({
  data,
  isLoading,
  isFetching,
  error,
  canManage,
  onRetry,
}: {
  data: Record<string, any> | undefined;
  isLoading: boolean;
  isFetching: boolean;
  error: unknown;
  canManage: boolean;
  onRetry: () => void;
}) {
  if (isLoading) {
    return (
      <CardShell title="Organic search traffic">
        <div className="space-y-3" aria-busy>
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      </CardShell>
    );
  }

  if (error && !data) {
    return (
      <CardShell title="Organic search traffic">
        <Ga4ErrorState
          error={error}
          canManage={canManage}
          onRetry={onRetry}
          isRetrying={isFetching}
        />
      </CardShell>
    );
  }

  if (!data) return null;

  const current = (data.current ?? null) as OverviewCurrent | null;
  const comparison = (data.comparison ?? {}) as OverviewComparison;
  const trend = (data.trend ?? []) as TrendPoint[];
  const trendFilled = data.trendFilled === true;
  const hasLimitedData =
    (data.reportMetadata as { hasLimitedData?: boolean } | undefined)
      ?.hasLimitedData === true;
  const diagnostics = (data.diagnostics ?? []) as Array<{
    code?: string;
    evidence?: { current?: number; previous?: number; percentChange?: number };
  }>;
  const decline = diagnostics.find(
    (diagnostic) => diagnostic.code === "key_events_sharp_decline",
  );
  const request = (data.request ?? {}) as {
    resolvedDateRange?: { startDate?: string; endDate?: string };
    trend?: string;
  };
  const start = request.resolvedDateRange?.startDate ?? "";
  const end = request.resolvedDateRange?.endDate ?? "";
  const rangeDays = (() => {
    const parsed =
      /^(\d{4})-(\d{2})-(\d{2})$/.exec(start) &&
      /^(\d{4})-(\d{2})-(\d{2})$/.exec(end)
        ? Math.round(
            (new Date(`${end}T00:00:00Z`).valueOf() -
              new Date(`${start}T00:00:00Z`).valueOf()) /
              86_400_000,
          ) + 1
        : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 28;
  })();
  const currency =
    typeof request === "object" &&
    typeof (data.request as { currencyCode?: unknown })?.currencyCode ===
      "string"
      ? (data.request as { currencyCode: string }).currencyCode
      : "USD";
  const noSessions =
    current !== null &&
    (current.sessions === 0 ||
      (current.sessions === null &&
        trend.every((point) => point.sessions === 0)));

  const rows = [
    { label: "Sessions", value: formatInteger(current?.sessions ?? null), change: <ChangeValue percentChange={comparison.sessions?.percentChange ?? null} /> },
    { label: "Active users", value: formatInteger(current?.activeUsers ?? null), change: <ChangeValue percentChange={comparison.activeUsers?.percentChange ?? null} /> },
    { label: "Engaged sessions", value: formatInteger(current?.engagedSessions ?? null), change: <ChangeValue percentChange={comparison.engagedSessions?.percentChange ?? null} /> },
    { label: "Engagement rate", value: formatRate(current?.engagementRate ?? null), change: <ChangeValue percentChange={comparison.engagementRate?.percentChange ?? null} /> },
    { label: "Key events", value: formatInteger(current?.keyEvents ?? null), change: <ChangeValue percentChange={comparison.keyEvents?.percentChange ?? null} /> },
    { label: "Transactions", value: formatInteger(current?.transactions ?? null), change: <ChangeValue percentChange={comparison.transactions?.percentChange ?? null} /> },
    { label: "Revenue", value: formatMoney(current?.purchaseRevenue ?? null, currency), change: <ChangeValue percentChange={comparison.purchaseRevenue?.percentChange ?? null} /> },
  ];

  const chartLabel =
    request.trend === "weekly"
      ? `Organic sessions per week, ${start} to ${end}`
      : `Organic sessions per day, ${start} to ${end}`;

  return (
    <CardShell
      title="Organic search traffic"
      titleInfo={
        start && end ? (
          <span className="text-sm font-normal text-muted-foreground">
            Google Analytics · {start} – {end} vs the previous {rangeDays} days
          </span>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {error ? (
          <Ga4ErrorState
            error={error}
            canManage={canManage}
            onRetry={onRetry}
            isRetrying={isFetching}
          />
        ) : null}
        {decline ? (
          <Alert variant="warning">
            <AlertDescription>
              Organic key events fell{" "}
              {decline.evidence?.percentChange != null
                ? `${Math.abs(decline.evidence.percentChange * 100).toFixed(0)}%`
                : "sharply"}{" "}
              compared with the previous {rangeDays} days (
              {decline.evidence?.previous ?? "—"} →{" "}
              {decline.evidence?.current ?? "—"}).
            </AlertDescription>
          </Alert>
        ) : null}
        {hasLimitedData ? <LimitedDataNotice /> : null}
        {noSessions ? (
          <p className="text-sm text-muted-foreground">
            No organic search traffic recorded in this period.
          </p>
        ) : (
          <>
            <MetricsTable rows={rows} showChange />
            <div>
              <div aria-label={chartLabel}>
                <SessionsTrend
                  trend={trend}
                  weekly={request.trend === "weekly"}
                />
              </div>
              {!trendFilled && trend.length > 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Days without data from Google Analytics are left blank.
                </p>
              ) : null}
            </div>
          </>
        )}
      </div>
    </CardShell>
  );
}
