import test from "node:test";
import assert from "node:assert/strict";
import {
  ANSWER_DISPLAY_LIMIT,
  HISTORY_MAX_EXECUTIONS,
  HISTORY_RANGE_LABELS,
  HISTORY_RANGES,
  excerpt,
  historyPeriod,
  periodToQuery,
} from "./question-history.ts";

test("range registry matches the spec copy", () => {
  assert.deepEqual([...HISTORY_RANGES], ["last_7_days", "last_28_days", "last_90_days", "all", "custom"]);
  assert.deepEqual(HISTORY_RANGE_LABELS, {
    last_7_days: "Last 7 days",
    last_28_days: "Last 28 days",
    last_90_days: "Last 90 days",
    all: "All available history",
    custom: "Custom range",
  });
  assert.equal(HISTORY_MAX_EXECUTIONS, 500);
  assert.equal(ANSWER_DISPLAY_LIMIT, 24_000);
});

test("historyPeriod defaults to last 28 days with inclusive local bounds", () => {
  const now = new Date(2026, 9, 21, 12, 0, 0);
  const period = historyPeriod(undefined, now);
  assert.equal(period.preset, "last_28_days");
  assert.equal(period.end, "2026-10-21");
  assert.equal(period.start, "2026-09-24");
  assert.equal(historyPeriod("last_7_days", now).start, "2026-10-15");
  assert.equal(historyPeriod("last_90_days", now).start, "2026-07-24");
});

test("periodToQuery maps local days to UTC instants in a DST-free zone", () => {
  const query = periodToQuery({ preset: "last_28_days", start: "2026-09-24", end: "2026-10-21" });
  assert.ok(query && "from" in query && "to" in query);
  const from = new Date(query.from as string);
  const to = new Date(query.to as string);
  assert.ok(!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()));
  assert.ok(to.getTime() - from.getTime() >= 27 * 86_400_000);
  assert.deepEqual(periodToQuery({ preset: "all", start: "", end: "" }), {});
  assert.equal(periodToQuery({ preset: "custom", start: "2026-10-21", end: "2026-10-20" }), null);
  assert.equal(periodToQuery({ preset: "custom", start: "", end: "" }), null);
});

test("periodToQuery covers the full local end day (UTC+5:30 style)", () => {
  const query = periodToQuery({ preset: "custom", start: "2026-10-20", end: "2026-10-20" });
  assert.ok(query && query.from && query.to);
  const from = new Date(query.from as string).getTime();
  const to = new Date(query.to as string).getTime();
  assert.equal(to - from, 86_400_000 - 1);
});

test("excerpt keeps radius at text edges", () => {
  const text = "Popular oversized t-shirt brands in India include附近 and more words after the mention here.";
  const at = text.indexOf("附近");
  const part = excerpt(text, { start: at, end: at + 2 }, 70);
  assert.equal(part.match, "附近");
  assert.ok(part.before.length <= 70);
  assert.ok(part.after.length <= 70);
  const start = excerpt("abcdef", { start: 0, end: 2 }, 70);
  assert.deepEqual(start, { before: "", match: "ab", after: "cdef" });
  const end = excerpt("abcdef", { start: 4, end: 6 }, 70);
  assert.deepEqual(end, { before: "abcd", match: "ef", after: "" });
});

test("excerpt never splits a surrogate pair", () => {
  const emoji = "😀";
  const text = `a${emoji}b`;
  const whole = excerpt(text, { start: 1, end: 3 }, 70);
  assert.equal(whole.match, emoji);
  assert.equal(whole.before, "a");
  assert.equal(whole.after, "b");
  const narrow = excerpt(text, { start: 0, end: 4 }, 0);
  assert.equal(narrow.match, text);
});
