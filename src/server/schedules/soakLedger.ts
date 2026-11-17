import { computeNextRunAt, type ScheduleInterval } from "../../shared/schedule.ts";

export type ExpectedWindowsInput = {
  interval: ScheduleInterval;
  anchor: string;
  from: string;
  to: string;
};

export type RecordedWindow =
  | { window_at: string }
  | { windowAt: string };

function advance(interval: ScheduleInterval, anchor: string): string {
  return computeNextRunAt(interval, anchor, undefined, {
    now: () => Date.parse(anchor),
  });
}

function previousMonthlyWindow(anchor: string): string {
  const date = new Date(anchor);
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const dayShift =
    date.getUTCDate() === 1
      ? 1
      : date.getUTCDate() === lastDay - 1
        ? -1
        : 0;
  const month = date.getUTCMonth() - (dayShift === 1 ? 2 : 1);
  return new Date(
    Date.UTC(
      date.getUTCFullYear(),
      month + 1,
      dayShift,
      date.getUTCHours(),
      date.getUTCMinutes(),
    ),
  ).toISOString();
}

function previousWindow(interval: ScheduleInterval, anchor: string): string {
  if (interval === "monthly") return previousMonthlyWindow(anchor);
  const days = interval === "daily" ? 1 : 7;
  return new Date(Date.parse(anchor) - days * 86_400_000).toISOString();
}

/** List all interval windows in the inclusive range, using `anchor` as a slot. */
export function expectedWindows(input: ExpectedWindowsInput): string[] {
  const from = Date.parse(input.from);
  const to = Date.parse(input.to);
  let cursorMs = Date.parse(input.anchor);
  if (![from, to, cursorMs].every(Number.isFinite) || to < from) return [];

  let cursor = new Date(cursorMs).toISOString();
  while (Date.parse(cursor) > from) {
    cursor = previousWindow(input.interval, cursor);
  }
  while (Date.parse(cursor) < from) {
    cursor = advance(input.interval, cursor);
  }

  const expected: string[] = [];
  while (Date.parse(cursor) <= to) {
    expected.push(cursor);
    cursor = advance(input.interval, cursor);
  }
  return expected;
}

/** Return expected windows that do not have a corresponding ledger row. */
export function unexplainedGaps(
  expected: readonly string[],
  recorded: readonly RecordedWindow[],
): string[] {
  const recordedAt = new Set(
    recorded.map((window) => {
      const at = "window_at" in window ? window.window_at : window.windowAt;
      return Date.parse(at);
    }),
  );
  return expected.filter((windowAt) => !recordedAt.has(Date.parse(windowAt)));
}
