// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/rank-tracking.test.ts schedule cases.
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MAX_CATCH_UP_WINDOWS,
  SCHEDULE_INTERVALS,
  SKIP_REASONS,
  WEEKDAYS,
  browserTimeZoneLabel,
  computeNextRunAt,
  describeSchedule,
  formatNextRun,
  planWindows,
  scheduleLabel,
  scheduleTimeSchema,
  scheduledChecksPerMonth,
  skipReasonMessage,
} from "./schedule.ts";

const at = (iso: string) => Date.parse(iso);
const fixed = (iso: string) => ({ now: () => at(iso), random: () => 0 });

test("schedule interval and time schema match the shared contract", () => {
  assert.deepEqual(SCHEDULE_INTERVALS, ["daily", "weekly", "monthly"]);
  assert.equal(MAX_CATCH_UP_WINDOWS, 1);
  assert.deepEqual(
    scheduleTimeSchema.parse({ weekday: 1, hour: 9, minute: 30, timeZone: "Asia/Kolkata" }),
    { weekday: 1, hour: 9, minute: 30, timeZone: "Asia/Kolkata" },
  );
  assert.equal(scheduleTimeSchema.safeParse({ hour: 24, minute: 0 }).success, false);
  assert.equal(scheduleTimeSchema.safeParse({ hour: 9, minute: 0, timeZone: "Mars/Olympus" }).success, false);
});

test("new monthly schedules land on this month's end when it is still ahead", () => {
  assert.equal(
    computeNextRunAt("monthly", null, undefined, fixed("2026-01-15T12:00:00.000Z")),
    "2026-01-31T04:00:00.000Z",
  );
});

test("new monthly schedules advance after this month's chosen time passes", () => {
  assert.equal(
    computeNextRunAt("monthly", null, undefined, fixed("2026-01-31T10:00:00.000Z")),
    "2026-02-28T04:00:00.000Z",
  );
});

test("monthly schedules advance from their month-end anchor past now", () => {
  assert.equal(
    computeNextRunAt("monthly", "2026-01-31T05:30:00.000Z", undefined, fixed("2026-02-01T00:00:00.000Z")),
    "2026-02-28T05:30:00.000Z",
  );
  assert.equal(
    computeNextRunAt("monthly", "2026-01-31T05:30:00.000Z", undefined, fixed("2026-03-10T00:00:00.000Z")),
    "2026-03-31T05:30:00.000Z",
  );
});

test("daily and weekly overdue schedules keep their anchored time without drift", () => {
  assert.equal(
    computeNextRunAt("daily", "2026-01-31T05:30:00.000Z", undefined, fixed("2026-03-10T12:00:00.000Z")),
    "2026-03-11T05:30:00.000Z",
  );
  assert.equal(
    computeNextRunAt("weekly", "2026-01-31T05:30:00.000Z", undefined, fixed("2026-03-10T12:00:00.000Z")),
    "2026-03-14T05:30:00.000Z",
  );
});

test("chosen times use their next daily or weekly occurrence", () => {
  const now = fixed("2026-03-10T12:00:00.000Z");
  assert.equal(
    computeNextRunAt("weekly", null, { weekday: 0, hour: 21, minute: 0 }, now),
    "2026-03-15T21:00:00.000Z",
  );
  assert.equal(
    computeNextRunAt("weekly", null, { weekday: 2, hour: 9, minute: 0 }, now),
    "2026-03-17T09:00:00.000Z",
  );
  assert.equal(
    computeNextRunAt("daily", null, { hour: 21, minute: 15 }, now),
    "2026-03-10T21:15:00.000Z",
  );
});

test("timezone conversion includes the selected weekday and ignores current seconds", () => {
  const now = fixed("2026-03-10T12:00:45.000Z");
  assert.equal(
    computeNextRunAt(
      "weekly",
      null,
      { weekday: 0, hour: 21, minute: 0, timeZone: "America/New_York" },
      now,
    ),
    "2026-03-16T01:00:00.000Z",
  );
  assert.equal(
    computeNextRunAt(
      "weekly",
      null,
      { weekday: 0, hour: 21, minute: 0, timeZone: "Asia/Kolkata" },
      now,
    ),
    "2026-03-15T15:30:00.000Z",
  );
});

test("monthly schedules preserve the user's last day across a UTC date change", () => {
  const now = fixed("2026-02-10T12:00:00.000Z");
  const losAngeles = computeNextRunAt(
    "monthly",
    null,
    { hour: 21, minute: 0, timeZone: "America/Los_Angeles" },
    now,
  );
  const kolkata = computeNextRunAt(
    "monthly",
    null,
    { hour: 1, minute: 0, timeZone: "Asia/Kolkata" },
    now,
  );
  assert.equal(losAngeles, "2026-03-01T05:00:00.000Z");
  assert.equal(kolkata, "2026-02-27T19:30:00.000Z");
  assert.equal(
    computeNextRunAt("monthly", losAngeles, undefined, fixed("2026-03-02T12:00:00.000Z")),
    "2026-04-01T05:00:00.000Z",
  );
  assert.equal(
    computeNextRunAt("monthly", kolkata, undefined, fixed("2026-03-02T12:00:00.000Z")),
    "2026-03-30T19:30:00.000Z",
  );
});

test("default daily and weekly slots use the injected clock and random source", () => {
  const deps = { now: () => at("2026-03-10T12:00:00.000Z"), random: () => 0.5 };
  assert.equal(computeNextRunAt("daily", null, undefined, deps), "2026-03-11T07:30:00.000Z");
  assert.equal(computeNextRunAt("weekly", null, undefined, deps), "2026-03-17T07:30:00.000Z");
});

test("planWindows returns not-due, one-due, and bounded catch-up plans", () => {
  const next = "2026-01-04T09:00:00.000Z";
  assert.deepEqual(planWindows(next, "daily", at("2026-01-03T12:00:00.000Z")), {
    run: null,
    missed: [],
    next,
  });
  assert.deepEqual(planWindows(next, "daily", at("2026-01-04T10:00:00.000Z")), {
    run: next,
    missed: [],
    next: "2026-01-05T09:00:00.000Z",
  });
  assert.deepEqual(
    planWindows("2026-01-01T09:00:00.000Z", "daily", at("2026-01-03T12:00:00.000Z")),
    {
      run: "2026-01-03T09:00:00.000Z",
      missed: ["2026-01-01T09:00:00.000Z", "2026-01-02T09:00:00.000Z"],
      next: "2026-01-04T09:00:00.000Z",
    },
  );
});

test("planWindows keeps at most 50 older missed windows and advances next past now", () => {
  const now = at("2026-03-01T12:00:00.000Z");
  const plan = planWindows("2026-01-01T09:00:00.000Z", "daily", now);
  assert.equal(plan.missed.length, 50);
  assert.equal(plan.run, "2026-03-01T09:00:00.000Z");
  assert.ok(Date.parse(plan.next) > now);
});

test("schedule display helpers use the supplied interval, timezone, and locale", () => {
  assert.equal(scheduleLabel("daily"), "Daily");
  assert.equal(scheduleLabel("weekly"), "Weekly");
  assert.equal(scheduleLabel("monthly"), "Monthly");
  assert.deepEqual(WEEKDAYS, ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
  assert.equal(browserTimeZoneLabel("Asia/Kolkata", new Date("2026-03-10T12:00:00.000Z")), "Kolkata (UTC+5:30)");
  assert.equal(
    describeSchedule("weekly", { weekday: 1, hour: 9, minute: 0 }, new Date("2026-03-10T12:00:00.000Z")).startsWith("Runs weekly on Mondays at "),
    true,
  );
  assert.equal(typeof formatNextRun("2026-03-10T12:00:00.000Z", "en-US"), "string");
});

test("skipReasonMessage covers every reason and has the specified fallback", () => {
  assert.deepEqual(SKIP_REASONS, [
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
  ]);
  const expectedMessages: Record<string, string> = {
    scheduling_disabled: "Scheduled scans are turned off for this workspace.",
    workspace_inactive: "This workspace is inactive.",
    dispatch_paused: "Answer collection is paused for maintenance.",
    brand_not_allowlisted: "Answer collection is limited to selected workspaces right now.",
    panel_not_approved: "There are no approved questions. Approve your questions to resume scheduled scans.",
    no_engines: "No answer engines are set up for scans yet.",
    over_scan_limit: "The scan is above the per-scan limit. Remove questions or contact support.",
    price_changed: "The scan now costs more than you approved. Review the new price to resume.",
    daily_capacity_reached: "Today's collection capacity was used up.",
    daily_cap: "Today's spend limit for this workspace was reached.",
    workspace_cap: "This month's spend limit for this workspace was reached.",
    feature_disabled: "Scans are not enabled for this workspace.",
    active_scan_overlap: "A scan was already running.",
    start_failed: "The scheduled scan could not start.",
    bounded_catchup_elapsed: "Missed while scheduling was unavailable.",
  };
  for (const reason of SKIP_REASONS) {
    assert.equal(skipReasonMessage(reason), expectedMessages[reason], reason);
  }
  assert.equal(skipReasonMessage("future_reason"), "The scheduled scan could not start.");
  assert.equal(scheduledChecksPerMonth("daily"), 30);
});

test("shared schedule module has no server-library imports", async () => {
  const source = await readFile(new URL("./schedule.ts", import.meta.url), "utf8");
  assert.equal(source.includes("../server/"), false);
  assert.equal(source.includes("@/server/"), false);
});
