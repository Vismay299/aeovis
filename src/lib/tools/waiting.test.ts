import test from "node:test";
import assert from "node:assert/strict";
import { withProgressWait } from "./waiting.ts";
import type { ToolOutcome } from "./run.ts";

const success = (status: string, progressPct: number): ToolOutcome => ({
  ok: true,
  output: { status, progressPct },
  summary: status + ":" + progressPct,
  link: null,
  untrusted: [],
  truncated: null,
});

test("returns a finished result without waiting", async () => {
  let calls = 0;
  const result = await withProgressWait(
    async () => {
      calls++;
      return success("completed", 100);
    },
    { statusPath: "status", runningValues: ["pending", "running"], progressPath: "progressPct", budgetMs: 45_000 },
    { sleep: async () => assert.fail("finished result should not sleep"), now: () => 0 },
  );
  assert.equal(calls, 1);
  assert.equal(result.ok, true);
});

test("waits while running and returns when progress changes", async () => {
  const values = [success("running", 3), success("running", 3), success("running", 56)];
  let calls = 0;
  let time = 0;
  const result = await withProgressWait(
    async () => values[calls++],
    { statusPath: "status", runningValues: ["pending", "running"], progressPath: "progressPct", budgetMs: 45_000 },
    { sleep: async (ms) => { time += ms; }, now: () => time },
  );
  assert.equal(calls, 3);
  assert.equal(result.ok && result.summary, "running:56");
});

test("stops waiting at the budget while status and progress remain unchanged", async () => {
  let calls = 0;
  let time = 0;
  const result = await withProgressWait(
    async () => {
      calls++;
      return success("running", 3);
    },
    { statusPath: "status", runningValues: ["pending", "running"], progressPath: "progressPct", budgetMs: 4_000 },
    { sleep: async (ms) => { time += ms; }, now: () => time },
  );
  assert.equal(calls, 2);
  assert.equal(result.ok && result.summary, "running:3");
});
