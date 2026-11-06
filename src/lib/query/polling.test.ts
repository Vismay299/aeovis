// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/shared.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import {
  pollIntervalMs,
  pacedStaleTime,
  finishTransition,
  isJobActive,
  JOB_ACTIVE_STATUSES,
} from "./polling.ts";

test("pollIntervalMs: returns false when data is undefined or not active", () => {
  assert.equal(pollIntervalMs(undefined, { isActive: () => true }), false);
  assert.equal(
    pollIntervalMs({ status: "completed" }, { isActive: (d) => d.status === "running" }),
    false
  );
});

test("pollIntervalMs: active with pollAfterSeconds 2 and floor 4 -> 4000", () => {
  const data = { status: "running", pollAfterSeconds: 2 };
  const interval = pollIntervalMs(data, {
    isActive: (d) => d.status === "running",
    pollAfterSeconds: (d) => d.pollAfterSeconds,
    floorSeconds: 4,
    fallbackSeconds: 5,
  });
  assert.equal(interval, 4000);
});

test("pollIntervalMs: active with pollAfterSeconds 10 and floor 4 -> 10000", () => {
  const data = { status: "running", pollAfterSeconds: 10 };
  const interval = pollIntervalMs(data, {
    isActive: (d) => d.status === "running",
    pollAfterSeconds: (d) => d.pollAfterSeconds,
    floorSeconds: 4,
    fallbackSeconds: 5,
  });
  assert.equal(interval, 10000);
});

test("pollIntervalMs: active with pollAfterSeconds null/undefined -> fallback * 1000", () => {
  const data = { status: "running", pollAfterSeconds: null };
  const interval = pollIntervalMs(data, {
    isActive: (d) => d.status === "running",
    pollAfterSeconds: (d) => d.pollAfterSeconds,
    floorSeconds: 4,
    fallbackSeconds: 5,
  });
  assert.equal(interval, 5000);
});

test("pollIntervalMs: scan config floor 2.5 / fallback 2.5 -> 2500", () => {
  const data = { status: "running" };
  const interval = pollIntervalMs(data, {
    isActive: () => true,
    floorSeconds: 2.5,
    fallbackSeconds: 2.5,
  });
  assert.equal(interval, 2500);
});

test("pacedStaleTime: 0 while active or undefined data, Infinity when finished", () => {
  assert.equal(pacedStaleTime(undefined, () => false), 0);
  assert.equal(pacedStaleTime({ status: "running" }, (d) => d.status === "running"), 0);
  assert.equal(
    pacedStaleTime({ status: "completed" }, (d) => d.status === "running"),
    Infinity
  );
});

test("finishTransition: true only on active -> finished transition for the same run", () => {
  const isActive = (d: { id: string; status: string }) => d.status === "running";
  const sameRun = (a: { id: string; status: string }, b: { id: string; status: string }) => a.id === b.id;

  // running -> completed, same run => true
  assert.equal(
    finishTransition(
      { id: "run-1", status: "running" },
      { id: "run-1", status: "completed" },
      { isActive, sameRun }
    ),
    true
  );

  // completed -> completed => false
  assert.equal(
    finishTransition(
      { id: "run-1", status: "completed" },
      { id: "run-1", status: "completed" },
      { isActive, sameRun }
    ),
    false
  );

  // undefined -> completed (already finished when first read) => false
  assert.equal(
    finishTransition(undefined, { id: "run-1", status: "completed" }, { isActive, sameRun }),
    false
  );

  // different run ids => false
  assert.equal(
    finishTransition(
      { id: "run-1", status: "running" },
      { id: "run-2", status: "completed" },
      { isActive, sameRun }
    ),
    false
  );
});

test("isJobActive & JOB_ACTIVE_STATUSES", () => {
  assert.deepEqual(JOB_ACTIVE_STATUSES, ["queued", "running"]);
  assert.equal(isJobActive({ status: "queued" }), true);
  assert.equal(isJobActive({ status: "running" }), true);
  assert.equal(isJobActive({ status: "completed" }), false);
  assert.equal(isJobActive({ status: "failed" }), false);
  assert.equal(isJobActive(undefined), false);
});
