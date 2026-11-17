import test from "node:test";
import assert from "node:assert/strict";
import { callStepLlm, CONTENT_STEP_BUDGET_MS } from "./shared.js";

test("schema correction shares the original step deadline instead of buying another time budget", async () => {
  const deadlines = [];
  const before = Date.now();
  const out = await callStepLlm({
    step: "review", prompt: "fixture",
    llm: async (_prompt, options) => {
      deadlines.push(options.deadlineMs);
      return deadlines.length === 1 ? null : { valid: true };
    },
    validate: (value) => value?.valid
      ? { ok: true, value }
      : { ok: false, errors: ["missing result"] },
  });
  assert.deepEqual(out, { valid: true });
  assert.equal(deadlines.length, 2);
  assert.equal(deadlines[0], deadlines[1]);
  assert.ok(deadlines[0] >= before + CONTENT_STEP_BUDGET_MS);
  assert.ok(deadlines[0] <= Date.now() + CONTENT_STEP_BUDGET_MS);
});
