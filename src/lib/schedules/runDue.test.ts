// Test cases ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/scheduledAiVisibility.test.ts.
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import test from "node:test";
import { runDueSchedules, type DueItem, type WindowPlan } from "./runDue.ts";

const now = Date.parse("2026-03-10T12:00:00.000Z");
const dueItem = (key: string): DueItem => ({
  key,
  observedNextRunAt: "2026-03-10T09:00:00.000Z",
  interval: "daily",
});
const notDueItem: DueItem = {
  key: "later",
  observedNextRunAt: "2026-03-11T09:00:00.000Z",
  interval: "daily",
};

test("not-due items are left untouched", async () => {
  let calls = 0;
  const result = await runDueSchedules({
    items: [notDueItem],
    now,
    evaluate: async () => {
      calls += 1;
      return { start: null };
    },
    start: async () => {
      calls += 1;
      return { started: true };
    },
    block: async () => {
      calls += 1;
    },
  });

  assert.equal(calls, 0);
  assert.deepEqual(result, { started: 0, skipped: {}, failed: 0, notDue: 1 });
});

test("skip evaluations are blocked once and counted by reason", async () => {
  const blocks: Array<{ key: string; reason: string }> = [];
  let starts = 0;
  const result = await runDueSchedules({
    items: [dueItem("skip")],
    now,
    evaluate: async () => ({ skip: "price_changed" }),
    start: async () => {
      starts += 1;
      return { started: true };
    },
    block: async (item, _plan, reason) => {
      blocks.push({ key: item.key, reason });
    },
  });

  assert.deepEqual(blocks, [{ key: "skip", reason: "price_changed" }]);
  assert.equal(starts, 0);
  assert.deepEqual(result, {
    started: 0,
    skipped: { price_changed: 1 },
    failed: 0,
    notDue: 0,
  });
});

test("successful starts are counted", async () => {
  const plans: WindowPlan[] = [];
  const result = await runDueSchedules({
    items: [dueItem("start")],
    now,
    evaluate: async () => ({ start: "context" }),
    start: async (_item, plan, context) => {
      assert.equal(context, "context");
      plans.push(plan);
      return { started: true };
    },
    block: async () => assert.fail("block must not run after a start"),
  });

  assert.equal(result.started, 1);
  assert.deepEqual(plans, [
    {
      run: "2026-03-10T09:00:00.000Z",
      missed: [],
      next: "2026-03-11T09:00:00.000Z",
    },
  ]);
});

test("a thrown start is blocked as start_failed and does not stop the next item", async () => {
  const blocked: string[] = [];
  const logs: string[] = [];
  let continued = false;
  const result = await runDueSchedules({
    items: [dueItem("throws"), dueItem("continues")],
    now,
    evaluate: async () => ({ start: null }),
    start: async (item) => {
      if (item.key === "throws") throw new Error("private detail");
      continued = true;
      return { started: true };
    },
    block: async (item, _plan, reason) => {
      blocked.push(`${item.key}:${reason}`);
    },
    logger: {
      error: (message) => logs.push(message),
      warn: () => undefined,
    },
  });

  assert.deepEqual(blocked, ["throws:start_failed"]);
  assert.equal(continued, true);
  assert.deepEqual(logs, ["[schedules] start failed"]);
  assert.deepEqual(result, {
    started: 1,
    skipped: { start_failed: 1 },
    failed: 0,
    notDue: 0,
  });
});

test("a failing block is counted and the next item still runs", async () => {
  let secondStarted = false;
  const logs: Array<{ message: string; key: string }> = [];
  const result = await runDueSchedules({
    items: [dueItem("bad-block"), dueItem("next")],
    now,
    evaluate: async (item) =>
      item.key === "bad-block" ? { skip: "dispatch_paused" } : { start: null },
    start: async () => {
      secondStarted = true;
      return { started: true };
    },
    block: async (item) => {
      if (item.key === "bad-block") throw new Error("private detail");
    },
    logger: {
      error: (message, details) => logs.push({
        message,
        key: String((details as { key?: string })?.key),
      }),
      warn: () => undefined,
    },
  });

  assert.equal(secondStarted, true);
  assert.deepEqual(logs, [{ message: "[schedules] block failed", key: "bad-block" }]);
  assert.deepEqual(result, { started: 1, skipped: {}, failed: 1, notDue: 0 });
});

test("wrap receives the window key and planned ISO timestamp", async () => {
  const names: string[] = [];
  const result = await runDueSchedules({
    items: [dueItem("brand.example")],
    now,
    evaluate: async () => ({ start: null }),
    start: async () => ({ started: true }),
    block: async () => undefined,
    wrap: async (name, fn) => {
      names.push(name);
      await fn();
    },
  });

  assert.deepEqual(names, ["window:brand.example:2026-03-10T09:00:00.000Z"]);
  assert.equal(result.started, 1);
});
