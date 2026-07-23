import { test } from "node:test";
import assert from "node:assert/strict";
import { runLearn } from "./steps/learn.js";

function makeDb() {
  const calls = { inserted: [], deactivated: [] };
  return {
    calls,
    listLessons: async () => [{ lesson: "Always pitch the brand at the end.", active: true }],
    insertLessons: async (brand, playbook, lessons, sourceFeedbackId) => {
      calls.inserted.push({ brand, playbook, lessons, sourceFeedbackId });
      return lessons.map((l, i) => ({ id: `l-${i}`, lesson: l }));
    },
    deactivateLessonByText: async (brand, playbook, text) => {
      calls.deactivated.push({ brand, playbook, text });
    },
  };
}

const ITEM = {
  title: "home-collection-margin-trap",
  body_md: "18% of every home-collection order goes to logistics.",
  rubric: { verdict: "pass", weighted_total: 0.87 },
};

test("runLearn distills, supersedes, and inserts lessons", async () => {
  const db = makeDb();
  const llm = async () => ({
    lessons: [
      { lesson: "Never pitch the brand in a post body.", supersedes: "Always pitch the brand at the end." },
      { lesson: "Use cost-per-visit framings for COO posts.", supersedes: null },
    ],
  });

  const result = await runLearn(
    {
      brand: "TestDiag",
      playbook: "linkedin_post",
      verdict: "changes_requested",
      comment: "too salesy at the end, we never pitch. love the cost framing though",
      item: ITEM,
    },
    { llm, ...db, sourceFeedbackId: "fb-1" }
  );

  assert.equal(result.lessons.length, 2);
  assert.equal(db.calls.deactivated.length, 1);
  assert.equal(db.calls.deactivated[0].text, "Always pitch the brand at the end.");
  assert.equal(db.calls.inserted.length, 1);
  assert.deepEqual(db.calls.inserted[0].lessons, [
    "Never pitch the brand in a post body.",
    "Use cost-per-visit framings for COO posts.",
  ]);
  assert.equal(db.calls.inserted[0].sourceFeedbackId, "fb-1");
});

test("runLearn is a no-op without a comment (no LLM call, no inserts)", async () => {
  const db = makeDb();
  let llmCalled = false;
  const llm = async () => {
    llmCalled = true;
    return { lessons: [] };
  };

  const result = await runLearn(
    { brand: "TestDiag", playbook: "linkedin_post", verdict: "approved", comment: "", item: ITEM },
    { llm, ...db }
  );

  assert.deepEqual(result.lessons, []);
  assert.equal(llmCalled, false);
  assert.equal(db.calls.inserted.length, 0);
});

test("runLearn passes existing lessons to the prompt for dedupe", async () => {
  const db = makeDb();
  let seenPrompt = "";
  const llm = async (prompt) => {
    seenPrompt = prompt;
    return { lessons: [] };
  };

  await runLearn(
    { brand: "TestDiag", playbook: "linkedin_post", verdict: "approved", comment: "good", item: ITEM },
    { llm, ...db }
  );

  assert.ok(seenPrompt.includes("Always pitch the brand at the end."));
});
