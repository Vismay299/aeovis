import assert from "node:assert/strict";
import test from "node:test";
import { expectedWindows, unexplainedGaps } from "./soakLedger.ts";

test("expectedWindows walks daily windows and includes both range boundaries", () => {
  assert.deepEqual(
    expectedWindows({
      interval: "daily",
      anchor: "2026-03-09T09:00:00.000Z",
      from: "2026-03-10T09:00:00.000Z",
      to: "2026-03-12T09:00:00.000Z",
    }),
    [
      "2026-03-10T09:00:00.000Z",
      "2026-03-11T09:00:00.000Z",
      "2026-03-12T09:00:00.000Z",
    ],
  );
});

test("expectedWindows uses an anchor after the range to recover earlier slots", () => {
  assert.deepEqual(
    expectedWindows({
      interval: "weekly",
      anchor: "2026-03-30T09:00:00.000Z",
      from: "2026-03-02T09:00:00.000Z",
      to: "2026-03-16T09:00:00.000Z",
    }),
    [
      "2026-03-02T09:00:00.000Z",
      "2026-03-09T09:00:00.000Z",
      "2026-03-16T09:00:00.000Z",
    ],
  );
});

test("expectedWindows preserves monthly end-of-month shifts while rewinding", () => {
  assert.deepEqual(
    expectedWindows({
      interval: "monthly",
      anchor: "2026-04-01T05:00:00.000Z",
      from: "2026-02-01T05:00:00.000Z",
      to: "2026-04-01T05:00:00.000Z",
    }),
    [
      "2026-02-01T05:00:00.000Z",
      "2026-03-01T05:00:00.000Z",
      "2026-04-01T05:00:00.000Z",
    ],
  );
});

test("expectedWindows returns no values for invalid or reversed ranges", () => {
  assert.deepEqual(
    expectedWindows({
      interval: "daily",
      anchor: "not-a-date",
      from: "2026-03-10T00:00:00.000Z",
      to: "2026-03-11T00:00:00.000Z",
    }),
    [],
  );
  assert.deepEqual(
    expectedWindows({
      interval: "daily",
      anchor: "2026-03-11T00:00:00.000Z",
      from: "2026-03-11T00:00:00.000Z",
      to: "2026-03-10T00:00:00.000Z",
    }),
    [],
  );
});

test("unexplainedGaps returns expected windows absent from measurement_windows", () => {
  const expected = [
    "2026-03-10T09:00:00.000Z",
    "2026-03-11T09:00:00.000Z",
    "2026-03-12T09:00:00.000Z",
  ];
  assert.deepEqual(
    unexplainedGaps(expected, [
      { window_at: "2026-03-10T09:00:00.000+00:00" },
      { windowAt: "2026-03-12T09:00:00.000Z" },
    ]),
    ["2026-03-11T09:00:00.000Z"],
  );
  assert.deepEqual(unexplainedGaps(expected, expected.map((windowAt) => ({ windowAt }))), []);
});
