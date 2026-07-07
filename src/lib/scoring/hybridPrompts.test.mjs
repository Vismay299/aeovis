import test from "node:test";
import assert from "node:assert/strict";
import { mergePromptPools } from "./hybridPrompts.js";

test("mergePromptPools - dedupes and caps at 20", () => {
  const pool = mergePromptPools(
    [
      { text: "best analytics tool", source: "paa" },
      { text: "analytics software comparison", source: "autocomplete" },
    ],
    [
      { text: "Best Analytics Tool", source: "llm_generated" },
      { text: "how to track saas metrics", source: "llm_generated" },
    ]
  );

  assert.equal(pool.length, 3);
  assert.equal(pool[0].source, "paa");
  assert.equal(pool[1].source, "autocomplete");
  assert.equal(pool[2].source, "llm_generated");
});

test("mergePromptPools - respects max prompt limit", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({
    text: `query number ${i}`,
    source: "llm_generated",
  }));

  const pool = mergePromptPools(many);
  assert.equal(pool.length, 20);
});