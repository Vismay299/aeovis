import test from "node:test";
import assert from "node:assert/strict";
import { sourceUnbrandedQueries, resolvePromptTarget } from "./scanWorker.js";

const BRAND = "Sleepy Owl Coffee";
const URL = "sleepyowl.co";
const ALIASES = ["sleepy owl", "sleepy owl coffee", "sleepyowl"];

function dbRow(text, i = 0, overrides = {}) {
  return {
    text,
    intent_tier: "informational",
    topic: "General",
    weight: 1,
    enabled: true,
    source: "llm_generated",
    created_at: `2026-07-0${(i % 9) + 1}T00:00:00Z`,
    ...overrides,
  };
}

function makePool(n) {
  return Array.from({ length: n }, (_, i) => dbRow(`unbranded query number ${i}`, i));
}

test("sourcing — reuses the saved pool keyed by domain, no generation", async () => {
  const calls = [];
  const { queries, newlyGenerated, promptKey } = await sourceUnbrandedQueries(
    BRAND, URL, "food", {}, ALIASES,
    {
      promptTarget: 30,
      getPromptsForBrand: async (key) => {
        calls.push(key);
        return key === "sleepyowl.co" ? makePool(30) : [];
      },
      upsertPrompts: async () => ({}),
      generateUnbrandedPrompts: async () => {
        throw new Error("generation must not run when the pool is full");
      },
    }
  );

  assert.equal(promptKey, "sleepyowl.co");
  assert.deepEqual(calls, ["sleepyowl.co"]);
  assert.equal(queries.length, 30);
  assert.equal(newlyGenerated.length, 0);
});

test("sourcing — FAIL-LOUD: DB error aborts the scan, never regenerates", async () => {
  let generated = false;
  await assert.rejects(
    sourceUnbrandedQueries(BRAND, URL, "food", {}, ALIASES, {
      promptTarget: 30,
      getPromptsForBrand: async () => {
        throw new Error("connection refused");
      },
      upsertPrompts: async () => ({}),
      generateUnbrandedPrompts: async () => {
        generated = true;
        return makePool(30);
      },
    }),
    /Couldn't load the tracked prompt set.*Scan aborted/s
  );
  assert.equal(generated, false, "must not silently regenerate on DB failure");
});

test("sourcing — legacy pool under typed brand name is migrated to the domain key", async () => {
  const upserts = [];
  const pools = new Map([[BRAND, makePool(30)]]); // legacy location only

  const { queries, promptKey } = await sourceUnbrandedQueries(
    BRAND, URL, "food", {}, ALIASES,
    {
      promptTarget: 30,
      getPromptsForBrand: async (key) => pools.get(key) || [],
      upsertPrompts: async (key, rows) => {
        upserts.push({ key, count: rows.length });
        pools.set(key, rows.map((r, i) => dbRow(r.text, i, r)));
        return {};
      },
      generateUnbrandedPrompts: async () => {
        throw new Error("generation must not run — legacy pool exists");
      },
    }
  );

  assert.equal(promptKey, "sleepyowl.co");
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].key, "sleepyowl.co");
  assert.equal(upserts[0].count, 30);
  assert.equal(queries.length, 30);
});

test("sourcing — additive top-up when target is raised (30 -> 40 keeps original 30)", async () => {
  const pool = makePool(30);
  const { queries, newlyGenerated } = await sourceUnbrandedQueries(
    BRAND, URL, "food", {}, ALIASES,
    {
      promptTarget: 40,
      getPromptsForBrand: async (key) => (key === "sleepyowl.co" ? pool : []),
      upsertPrompts: async () => ({}),
      generateUnbrandedPrompts: async (_b, _u, _i, _s, shortfall) =>
        Array.from({ length: shortfall }, (_, i) => ({
          text: `fresh expansion query ${i}`,
          topic: "General",
          intent_tier: "commercial",
          source: "llm_generated",
        })),
    }
  );

  assert.equal(queries.length, 40);
  // Original 30 must survive, in order, at the front.
  pool.forEach((p, i) => assert.equal(queries[i].text, p.text));
  assert.equal(newlyGenerated.length, 10);
});

test("sourcing — onboarding (empty pool) generates the full set", async () => {
  const { queries, newlyGenerated } = await sourceUnbrandedQueries(
    BRAND, URL, "food", {}, ALIASES,
    {
      promptTarget: 30,
      getPromptsForBrand: async () => [],
      upsertPrompts: async () => ({}),
      generateUnbrandedPrompts: async (_b, _u, _i, _s, shortfall) =>
        Array.from({ length: shortfall }, (_, i) => ({
          text: `generated query ${i}`,
          topic: "General",
          intent_tier: "informational",
          source: "llm_generated",
        })),
    }
  );

  assert.equal(queries.length, 30);
  assert.equal(newlyGenerated.length, 30);
});

test("resolvePromptTarget — default 30, env override clamped to [10,100]", () => {
  const prev = process.env.PROMPT_TARGET;
  try {
    delete process.env.PROMPT_TARGET;
    assert.equal(resolvePromptTarget(), 30);
    process.env.PROMPT_TARGET = "50";
    assert.equal(resolvePromptTarget(), 50);
    process.env.PROMPT_TARGET = "5";
    assert.equal(resolvePromptTarget(), 10);
    process.env.PROMPT_TARGET = "500";
    assert.equal(resolvePromptTarget(), 100);
    process.env.PROMPT_TARGET = "not-a-number";
    assert.equal(resolvePromptTarget(), 30);
  } finally {
    if (prev === undefined) delete process.env.PROMPT_TARGET;
    else process.env.PROMPT_TARGET = prev;
  }
});
