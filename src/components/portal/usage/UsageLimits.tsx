"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { formatUsd } from "@/shared/money";
import type { WorkspaceUsage } from "@/shared/costs";

/**
 * F03 §6.6.1 — today's and this month's spend against the workspace caps.
 *
 * A cap of 0 is a real "spend nothing" setting and must read as 100 %, not as
 * `NaN`; a null cap is no limit at all and draws no bar. The reset instant is
 * 00:00 UTC, so it is formatted in the viewer's zone rather than described as
 * "tomorrow" — east of UTC that would already be wrong late in the day.
 */

/**
 * The instant a limit next resets. The API's boundaries are 00:00 UTC, so a
 * day is 24 hours and a month is the next calendar month in UTC.
 */
function nextReset(at: string, unit: "day" | "month"): Date | null {
  const start = new Date(at);
  if (Number.isNaN(start.getTime())) return null;
  if (unit === "day") return new Date(start.getTime() + 86_400_000);
  return new Date(
    Date.UTC(
      start.getUTCFullYear(),
      start.getUTCMonth() + 1,
      1,
      start.getUTCHours(),
      start.getUTCMinutes(),
      start.getUTCSeconds(),
    ),
  );
}

/** "22 Oct, 05:30" in the viewer's zone. */
function formatReset(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const read = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${read("day")} ${read("month")}, ${read("hour")}:${read("minute")}`;
}

function usedPercent(used: number, cap: number | null): number {
  if (cap === null) return 0;
  if (cap <= 0) return 100;
  return Math.min(100, (used / cap) * 100);
}

const TONE_CLASS = {
  normal: "",
  warning: "[&_[data-slot=progress-indicator]]:bg-warning",
  destructive: "[&_[data-slot=progress-indicator]]:bg-destructive",
} as const;

function LimitCard({
  title,
  unit,
  used,
  cap,
  resetAt,
  openHolds,
  openHoldsUsd,
  timeZone,
}: {
  title: string;
  unit: "daily" | "monthly";
  used: number;
  cap: number | null;
  resetAt: string;
  openHolds: number;
  openHoldsUsd: number;
  timeZone: string;
}) {
  const percent = usedPercent(used, cap);
  const rounded = Math.round(percent);
  const tone =
    percent >= 100 ? "destructive" : percent >= 80 ? "warning" : "normal";
  const reset = nextReset(resetAt, unit === "daily" ? "day" : "month");
  const resetText = reset ? formatReset(reset, timeZone) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="text-2xl font-semibold tabular-nums">
          {formatUsd(used)}
        </div>

        {cap === null ? (
          <p className="text-sm text-muted-foreground">
            {unit === "daily" ? "No daily limit set" : "No monthly limit set"}
          </p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              {`of ${formatUsd(cap)} ${unit} limit`}
            </p>
            <Progress
              value={percent}
              aria-label={`${title} spend against the ${unit} limit`}
              aria-valuenow={rounded}
              aria-valuemax={100}
              className={TONE_CLASS[tone]}
            />
          </>
        )}

        {openHolds > 0 ? (
          <p className="text-xs text-muted-foreground">
            {`${formatUsd(openHoldsUsd)} is reserved for work in progress and is included above.`}
          </p>
        ) : null}

        {percent >= 100 ? (
          <p className="text-sm text-destructive" role="status">
            {resetText
              ? `Limit reached. Paid actions are paused until ${resetText}.`
              : "Limit reached. Paid actions are paused until the limit resets."}
          </p>
        ) : percent >= 80 ? (
          <p className="text-sm text-warning-foreground" role="status">
            {`You have used ${rounded}% of this limit.`}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function UsageLimits({
  position,
  timeZone,
}: {
  position: WorkspaceUsage["position"];
  timeZone: string;
}) {
  return (
    <>
      <LimitCard
        title="Today"
        unit="daily"
        used={position.todayUsd}
        cap={position.dailyCapUsd}
        resetAt={position.dayStartsAt}
        openHolds={position.openHolds}
        openHoldsUsd={position.openHoldsUsd}
        timeZone={timeZone}
      />
      <LimitCard
        title="This month"
        unit="monthly"
        used={position.monthUsd}
        cap={position.monthlyCapUsd}
        resetAt={position.monthStartsAt}
        openHolds={position.openHolds}
        openHoldsUsd={position.openHoldsUsd}
        timeZone={timeZone}
      />
    </>
  );
}
