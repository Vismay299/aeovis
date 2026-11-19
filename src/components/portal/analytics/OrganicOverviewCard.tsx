// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/dashboard/Ga4Card.tsx:43-180
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

import { Area, AreaChart } from "recharts";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { CardShell } from "@/components/app/CardShell";
import { MetricsTable } from "@/components/app/MetricsTable";
import { ChartGrid, ChartXAxis, ChartYAxis } from "@/components/app/ChartAxes";
import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from "@/components/ui/chart";
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

type TrendPoint = { date?: string; yearWeek?: string; sessions: number };

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

const trendConfig = {
  sessions: { label: "Sessions", color: "var(--chart-1)" },
} satisfies ChartConfig;

function shortDate(date: string): string {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!parsed) return date;
  return new Date(
    Number(parsed[1]),
    Number(parsed[2]) - 1,
    Number(parsed[3]),
  ).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function TrendTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: readonly { payload?: TrendPoint }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload;
  if (!point) return null;
  const date = point.date ?? point.yearWeek ?? label ?? "";
  return (
    <div className="rounded-lg border border-border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-sm">
      {`${date}: ${formatInteger(point.sessions)} sessions`}
    </div>
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
              <ChartContainer
                config={trendConfig}
                className="h-32 w-full"
                aria-label={chartLabel}
              >
                <AreaChart
                  data={trend}
                  margin={{ left: 8, right: 8, top: 8, bottom: 0 }}
                >
                  <ChartGrid />
                  <ChartXAxis
                    dataKey={request.trend === "weekly" ? "yearWeek" : "date"}
                    tickFormatter={(value: string) =>
                      request.trend === "weekly" ? String(value) : shortDate(String(value))
                    }
                  />
                  <ChartYAxis />
                  <ChartTooltip content={<TrendTooltip />} />
                  <Area
                    type="monotone"
                    dataKey="sessions"
                    fill="var(--color-sessions)"
                    stroke="var(--color-sessions)"
                    animationDuration={700}
            animationEasing="ease-out"
                    connectNulls={false}
                  />
                </AreaChart>
              </ChartContainer>
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
