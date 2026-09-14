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

/**
 * R1.7.4 — a deployment with only SERPAPI_KEY set makes no serpapi.com request
 * from promptGen. The PAA path is gated by the same capability check as the
 * AIO probe (BRIGHTDATA_API_KEY), so a stale SERPAPI_KEY must not reach any
 * network call.
 *
 * This test exercises the real fetchPeopleAlsoAsk from serp.js (not a stub)
 * with no BRIGHTDATA_API_KEY set, proving the gate fires before any request.
 */
test("R1.7.4 — stale SERPAPI_KEY alone makes no PAA request from promptGen", async () => {
  const oldBD = process.env.BRIGHTDATA_API_KEY;
  const oldSerp = process.env.SERPAPI_KEY;
  const oldSerpZone = process.env.BRIGHTDATA_SERP_ZONE;
  delete process.env.BRIGHTDATA_API_KEY;
  delete process.env.BRIGHTDATA_SERP_ZONE;
  process.env.SERPAPI_KEY = "stale-serpapi-key";

  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    networkCalls++;
    throw new Error(`should not have made a network call: ${args[0]}`);
  };

  try {
    // Use the REAL fetchPeopleAlsoAsk, not the noNetwork stub.
    const { fetchPeopleAlsoAsk } = await import("../engines/serp.js");
    const result = await fetchPeopleAlsoAsk(["best crm software"]);

    assert.deepEqual(result, [], "PAA must return empty when Bright Data is not configured");
    assert.equal(networkCalls, 0, "no network call must be made with only a stale SERPAPI_KEY");
  } finally {
    globalThis.fetch = originalFetch;
    if (oldBD === undefined) delete process.env.BRIGHTDATA_API_KEY;
    else process.env.BRIGHTDATA_API_KEY = oldBD;
    if (oldSerp === undefined) delete process.env.SERPAPI_KEY;
    else process.env.SERPAPI_KEY = oldSerp;
    if (oldSerpZone === undefined) delete process.env.BRIGHTDATA_SERP_ZONE;
    else process.env.BRIGHTDATA_SERP_ZONE = oldSerpZone;
  }
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
      // Names the provider-neutral vars (R5.1.1), not a vendor the deployment
      // may not even be pointed at.
      assert.match(err.message, /LLM_API_KEY/);
      assert.match(err.message, /LLM_MODEL/);
      assert.match(err.message, /LLM_BASE_URL/);
      return true;
    }
  );
});
