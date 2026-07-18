import test from "node:test";
import assert from "node:assert/strict";
import { generateUnbrandedPrompts } from "./promptGen.js";

const brand = "Acme";
const website = "https://acme.io";

function makeItems(prefix, n, opts = {}) {
  return Array.from({ length: n }, (_, i) => ({
    text: `${prefix} query number ${i} example`,
    topic: opts.topic || "General",
    intent_tier: opts.intent_tier || "informational",
  }));
}

const noNetwork = {
  scrapeForSummary: async () => "A tool for teams to manage projects.",
  fetchPeopleAlsoAsk: async () => {
    throw new Error("PAA should not be called in this test");
  },
  fetchAutocomplete: async () => {
    throw new Error("Autocomplete should not be called in this test");
  },
};

test("generateUnbrandedPrompts - single clean pass of 30 needs only one LLM call", async () => {
  let calls = 0;
  const llmJson = async () => {
    calls++;
    return makeItems("clean", 35); // over-generate like a real model would
  };

  const prompts = await generateUnbrandedPrompts(brand, website, "", {}, 30, {
    ...noNetwork,
    llmJson,
  });

  assert.equal(prompts.length, 30);
  assert.equal(calls, 1, "a full first pass should not trigger a second LLM call");
  assert.ok(prompts.every((p) => !/acme/i.test(p.text)));
});

test("generateUnbrandedPrompts - tops up to exactly 30 across two LLM passes", async () => {
  let calls = 0;
  const llmJson = async () => {
    calls++;
    if (calls === 1) return makeItems("first", 12);
    return makeItems("second", 25);
  };

  const prompts = await generateUnbrandedPrompts(brand, website, "", {}, 30, {
    ...noNetwork,
    llmJson,
  });

  assert.equal(prompts.length, 30);
  assert.equal(calls, 2);
});

test("generateUnbrandedPrompts - drops branded leaks, dupes, and single-word noise", async () => {
  const llmJson = async () => [
    ...makeItems("valid", 29),
    { text: "Acme pricing plans", topic: "General", intent_tier: "commercial" }, // branded leak
    { text: "valid query number 0 example", topic: "General", intent_tier: "informational" }, // dupe (case-insensitive of makeItems item 0)
    { text: "saas", topic: "General", intent_tier: "informational" }, // single word
  ];

  const prompts = await generateUnbrandedPrompts(brand, website, "", {}, 30, {
    ...noNetwork,
    llmJson,
  });

  assert.equal(prompts.length, 30);
  assert.ok(!prompts.some((p) => /acme/i.test(p.text)));
  assert.ok(!prompts.some((p) => p.text.trim().toLowerCase() === "saas"));
  const dupeCount = prompts.filter(
    (p) => p.text.toLowerCase() === "valid query number 0 example"
  ).length;
  assert.equal(dupeCount, 1);
});

test("generateUnbrandedPrompts - throws a clear error when it cannot reach count", async () => {
  const llmJson = async () => makeItems("short", 3);

  await assert.rejects(
    () =>
      generateUnbrandedPrompts(brand, website, "totally-unknown-industry", {}, 30, {
        scrapeForSummary: async () => "",
        fetchPeopleAlsoAsk: async () => [],
        fetchAutocomplete: async () => [],
        llmJson,
      }),
    (err) => {
      assert.match(err.message, /OPENROUTER/);
      return true;
    }
  );
});
