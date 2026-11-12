// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/rank-tracking.ts, src/types/schemas/schedule-time.ts,
//   src/client/features/rank-tracking/scheduleTime.ts.
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
export { scheduledChecksPerMonth } from "./ai-visibility-pricing.ts";

export const SCHEDULE_INTERVALS = ["daily", "weekly", "monthly"] as const;
export type ScheduleInterval = (typeof SCHEDULE_INTERVALS)[number];

function isTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** An IANA timezone name, e.g. "America/New_York". */
export const timeZoneSchema = z
  .string()
  .refine(isTimeZone, "Unknown IANA timezone");

/** A user-chosen run time, in their own timezone. */
export const scheduleTimeSchema = z.object({
  weekday: z
    .number()
    .int()
    .min(0)
    .max(6)
    .optional()
    .describe(
      "Day of week, 0 = Sunday. Required for weekly schedules, ignored by the others.",
    ),
  hour: z.number().int().min(0).max(23).describe("Hour, 0-23."),
  minute: z.number().int().min(0).max(59).describe("Minute, 0-59."),
  timeZone: timeZoneSchema
    .optional()
    .describe(
      'IANA timezone the weekday, hour, and minute are in, e.g. "America/New_York". Defaults to UTC.',
    ),
});

export type ScheduleTime = z.infer<typeof scheduleTimeSchema>;

export const MAX_CATCH_UP_WINDOWS = 1;

/**
 * Monthly checks run on the last day of the month where the user is. That day
 * can fall on a neighbouring UTC date, so the anchor sits `dayShift` days from
 * the UTC month end: -1, 0, or +1.
 */
function monthEndWithTime(
  year: number,
  month: number,
  dayShift: number,
  time: { hour: number; minute: number },
): Date {
  return new Date(Date.UTC(year, month + 1, dayShift, time.hour, time.minute));
}

/** Read the UTC month-end relationship back from a stored monthly anchor. */
function monthlyAnchorDayShift(anchor: Date): number {
  if (anchor.getUTCDate() === 1) return 1;
  const lastDay = new Date(
    Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 0),
  ).getUTCDate();
  return anchor.getUTCDate() === lastDay - 1 ? -1 : 0;
}

type UtcScheduleTime = {
  weekday?: number;
  hour: number;
  minute: number;
  /** Days the chosen date moved when converting to UTC: -1, 0, or +1. */
  dayShift: number;
};

/** Convert a chosen local time to UTC using the timezone's offset at `now`. */
function scheduleTimeInUtc(
  scheduleTime: ScheduleTime,
  now: number,
): UtcScheduleTime {
  if (!scheduleTime.timeZone) return { ...scheduleTime, dayShift: 0 };

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: scheduleTime.timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const wallClockAsUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
  );
  // The wall clock above has no seconds, so drop them from `now` too.
  const offsetMinutes = (wallClockAsUtc - now + (now % 60_000)) / 60_000;

  const utcMinutes =
    scheduleTime.hour * 60 + scheduleTime.minute - offsetMinutes;
  const dayShift = Math.floor(utcMinutes / 1440);
  const minutesOfDay = utcMinutes - dayShift * 1440;
  return {
    weekday:
      scheduleTime.weekday === undefined
        ? undefined
        : (scheduleTime.weekday + dayShift + 7) % 7,
    hour: Math.floor(minutesOfDay / 60),
    minute: minutesOfDay % 60,
    dayShift,
  };
}

/**
 * Compute the next scheduled run. An existing anchor advances by interval
 * steps without drift; a new schedule starts at its chosen time or a random
 * 04:00–10:00 UTC slot.
 */
export function computeNextRunAt(
  interval: ScheduleInterval,
  previousNextRunAt?: string | null,
  chosenTime?: ScheduleTime,
  deps?: { now?: () => number; random?: () => number },
): string {
  const now = deps?.now?.() ?? Date.now();
  const random = deps?.random ?? Math.random;
  const scheduleTime = chosenTime && scheduleTimeInUtc(chosenTime, now);

  if (interval === "monthly") {
    if (previousNextRunAt) {
      const anchor = new Date(previousNextRunAt);
      const year = anchor.getUTCFullYear();
      const dayShift = monthlyAnchorDayShift(anchor);
      const time = {
        hour: anchor.getUTCHours(),
        minute: anchor.getUTCMinutes(),
      };
      // A +1 anchor sits on the 1st, which belongs to the month before it.
      let month = anchor.getUTCMonth() + (dayShift === 1 ? 0 : 1);
      let nextDate = monthEndWithTime(year, month, dayShift, time);
      while (nextDate.getTime() <= now) {
        month += 1;
        nextDate = monthEndWithTime(year, month, dayShift, time);
      }
      return nextDate.toISOString();
    }

    const time = {
      hour: scheduleTime?.hour ?? 4 + Math.floor(random() * 6),
      minute: scheduleTime?.minute ?? Math.floor(random() * 60),
    };
    const dayShift = scheduleTime?.dayShift ?? 0;
    const today = new Date(now);
    const year = today.getUTCFullYear();
    // Start a month back: a +1 shift puts last month's run early in this one.
    let month = today.getUTCMonth() - 1;
    let nextDate = monthEndWithTime(year, month, dayShift, time);
    while (nextDate.getTime() <= now) {
      month += 1;
      nextDate = monthEndWithTime(year, month, dayShift, time);
    }
    return nextDate.toISOString();
  }

  const daysAhead = interval === "daily" ? 1 : 7;

  if (previousNextRunAt) {
    const anchor = new Date(previousNextRunAt).getTime();
    const intervalMs = daysAhead * 86_400_000;
    const steps = Math.floor(Math.max(0, now - anchor) / intervalMs) + 1;
    return new Date(anchor + steps * intervalMs).toISOString();
  }

  if (scheduleTime) {
    // Next occurrence of the chosen time, so a pick later today runs today.
    const nextDate = new Date(now);
    nextDate.setUTCHours(scheduleTime.hour, scheduleTime.minute, 0, 0);
    const weekday = interval === "weekly" ? scheduleTime.weekday : undefined;
    if (weekday !== undefined) {
      const daysUntilWeekday = (weekday - nextDate.getUTCDay() + 7) % 7;
      nextDate.setUTCDate(nextDate.getUTCDate() + daysUntilWeekday);
    }
    if (nextDate.getTime() <= now) {
      nextDate.setUTCDate(
        nextDate.getUTCDate() + (weekday === undefined ? 1 : 7),
      );
    }
    return nextDate.toISOString();
  }

  const nextDate = new Date(now);
  nextDate.setUTCDate(nextDate.getUTCDate() + daysAhead);
  const hour = 4 + Math.floor(random() * 6);
  const minute = Math.floor(random() * 60);
  nextDate.setUTCHours(hour, minute, 0, 0);
  return nextDate.toISOString();
}

export function planWindows(
  nextRunAt: string,
  interval: ScheduleInterval,
  now: number,
): { run: string | null; missed: string[]; next: string } {
  const due: string[] = [];
  let cursor = nextRunAt;

  while (Date.parse(cursor) <= now) {
    due.push(cursor);
    // Use the current anchor as the clock so each call advances exactly once.
    cursor = computeNextRunAt(interval, cursor, undefined, {
      now: () => Date.parse(cursor),
    });
  }

  if (due.length === 0) return { run: null, missed: [], next: nextRunAt };
  const latestRun = due.length - MAX_CATCH_UP_WINDOWS;
  return {
    run: due[latestRun],
    missed: due.slice(0, latestRun).slice(-50),
    next: cursor,
  };
}

export function scheduleLabel(i: ScheduleInterval): "Daily" | "Weekly" | "Monthly" {
  if (i === "daily") return "Daily";
  if (i === "weekly") return "Weekly";
  return "Monthly";
}

export const WEEKDAYS: readonly string[] = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function nextLocalOccurrence(time: {
  weekday: number;
  hour: number;
  minute: number;
}, now: Date): Date {
  const date = new Date(now);
  date.setHours(time.hour, time.minute, 0, 0);
  date.setDate(date.getDate() + ((time.weekday - date.getDay() + 7) % 7));
  return date;
}

export function describeSchedule(
  i: ScheduleInterval,
  t: { weekday: number; hour: number; minute: number },
  now = new Date(),
): string {
  const date = nextLocalOccurrence(t, now);
  const localTime = date.toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  const utcTime = date.toLocaleTimeString("en-GB", {
    timeZone: "UTC",
    hour: "2-digit",
    minute: "2-digit",
  });
  const utcWeekday =
    i === "weekly" && date.getUTCDay() !== date.getDay()
      ? `${WEEKDAYS[date.getUTCDay()].slice(0, 3)} `
      : "";
  const when =
    i === "daily"
      ? "daily"
      : i === "weekly"
        ? `weekly on ${WEEKDAYS[t.weekday]}s`
        : "on the last day of each month";
  return `Runs ${when} at ${localTime} (${utcWeekday}${utcTime} UTC)`;
}

export function browserTimeZoneLabel(
  tz = Intl.DateTimeFormat().resolvedOptions().timeZone,
  now = new Date(),
): string {
  const city = tz.slice(tz.lastIndexOf("/") + 1).replaceAll("_", " ");
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const wallClockAsUtc = Date.UTC(
    part("year"),
    part("month") - 1,
    part("day"),
    part("hour"),
    part("minute"),
  );
  const nowMs = now.getTime();
  const offsetMinutes =
    (wallClockAsUtc - nowMs + (nowMs % 60_000)) / 60_000;
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  const offset = `${sign}${hours}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
  return `${city} (UTC${offset})`;
}

export function formatNextRun(iso: string, locale?: string): string {
  return new Date(iso).toLocaleString(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export const SKIP_REASONS: readonly string[] = [
  "scheduling_disabled",
  "workspace_inactive",
  "dispatch_paused",
  "brand_not_allowlisted",
  "panel_not_approved",
  "no_engines",
  "over_scan_limit",
  "price_changed",
  "daily_capacity_reached",
  "daily_cap",
  "workspace_cap",
  "feature_disabled",
  "active_scan_overlap",
  "start_failed",
  "bounded_catchup_elapsed",
];

const SKIP_MESSAGES: Readonly<Record<string, string>> = {
  scheduling_disabled: "Scheduled scans are turned off for this workspace.",
  workspace_inactive: "This workspace is inactive.",
  dispatch_paused: "Answer collection is paused for maintenance.",
  brand_not_allowlisted:
    "Answer collection is limited to selected workspaces right now.",
  panel_not_approved:
    "There are no approved questions. Approve your questions to resume scheduled scans.",
  no_engines: "No answer engines are set up for scans yet.",
  over_scan_limit:
    "The scan is above the per-scan limit. Remove questions or contact support.",
  price_changed:
    "The scan now costs more than you approved. Review the new price to resume.",
  daily_capacity_reached: "Today's collection capacity was used up.",
  daily_cap: "Today's spend limit for this workspace was reached.",
  workspace_cap: "This month's spend limit for this workspace was reached.",
  feature_disabled: "Scans are not enabled for this workspace.",
  active_scan_overlap: "A scan was already running.",
  start_failed: "The scheduled scan could not start.",
  bounded_catchup_elapsed: "Missed while scheduling was unavailable.",
};

export function skipReasonMessage(reason: string): string {
  return SKIP_MESSAGES[reason] ?? "The scheduled scan could not start.";
}

export type LocalScheduleTime = {
  weekday: number;
  hour: number;
  minute: number;
};

export function localScheduleTimeFrom(date: Date): LocalScheduleTime {
  return {
    weekday: date.getDay(),
    hour: date.getHours(),
    minute: date.getMinutes(),
  };
}

/** Same default the server picks: a random minute between 04:00 and 10:00 UTC. */
export function randomScheduleDate(): Date {
  const date = new Date();
  date.setUTCHours(
    4 + Math.floor(Math.random() * 6),
    Math.floor(Math.random() * 60),
    0,
    0,
  );
  return date;
}

export function withBrowserTimeZone(
  time: LocalScheduleTime,
): ScheduleTime {
  return {
    ...time,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
