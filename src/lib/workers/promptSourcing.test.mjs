import test from "node:test";
import assert from "node:assert/strict";
import { sourceUnbrandedQueries, resolvePromptTarget } from "./scanWorker.js";
import { LlmUnavailableError } from "../llmErrors.js";
import { PROMPT_SOURCE, STATIC_PACK_SOURCE } from "../scoring/promptSource.js";

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

// ---------------------------------------------------------------------------
// R0.3.4 (finding B7) — a new brand whose prompts cannot be generated.
//
// Before this, generateUnbrandedPrompts topped the set up from the hardcoded
// per-industry pack whenever the LLM came up short, and sourcing returned it
// with no marking at all: a generic prompt set published as a measurement of
// this specific brand.
// ---------------------------------------------------------------------------

test("ABORT PATH — a new brand + an unavailable LLM aborts sourcing with a typed error", async () => {
  const err = await sourceUnbrandedQueries(
    BRAND, URL, "food", {}, ALIASES,
    {
      promptTarget: 30,
      getPromptsForBrand: async () => [],           // new brand: nothing persisted
      upsertPrompts: async () => ({}),
      generateUnbrandedPrompts: async () => {
        throw new LlmUnavailableError("LLM_API_KEY is not configured", {
          reason: "missing_key",
          provider: "openrouter",
        });
      },
    }
  ).catch((e) => e);

  assert.equal(err.name, "PromptSourcingUnavailableError");
  assert.equal(err.stage, "sourcing");
  assert.equal(err.reason, "missing_key");
  assert.match(err.message, /Sleepy Owl Coffee/);
});

test("sourcing — a NON-LLM generation failure is not relabelled as an LLM outage", async () => {
  const boom = new Error("scrape target refused the connection");
  const err = await sourceUnbrandedQueries(
    BRAND, URL, "food", {}, ALIASES,
    {
      promptTarget: 30,
      getPromptsForBrand: async () => [],
      upsertPrompts: async () => ({}),
      generateUnbrandedPrompts: async () => {
        throw boom;
      },
    }
  ).catch((e) => e);
  assert.equal(err, boom);
});

test("STATIC PACK PATH — a set topped up from the industry pack reports prompt_source=static_industry_pack", async () => {
  const generated = [
    ...Array.from({ length: 20 }, (_, i) => ({
      text: `generated query ${i}`,
      topic: "General",
      intent_tier: "informational",
      source: "llm_generated",
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      text: `generic industry question ${i}`,
      topic: "Food",
      intent_tier: "informational",
      source: STATIC_PACK_SOURCE,
    })),
  ];
  const out = await sourceUnbrandedQueries(
    BRAND, URL, "food", {}, ALIASES,
    {
      promptTarget: 30,
      getPromptsForBrand: async () => [],
      upsertPrompts: async () => ({}),
      generateUnbrandedPrompts: async () => generated,
    }
  );
  assert.equal(out.queries.length, 30);
  assert.equal(out.prompt_source, PROMPT_SOURCE.STATIC_INDUSTRY_PACK);
  assert.equal(out.static_pack_prompts, 10);
});

test("sourcing — a fully generated set reports prompt_source=llm_generated", async () => {
  const out = await sourceUnbrandedQueries(
    BRAND, URL, "food", {}, ALIASES,
    {
      promptTarget: 30,
      getPromptsForBrand: async () => [],
      upsertPrompts: async () => ({}),
      generateUnbrandedPrompts: async () =>
        Array.from({ length: 30 }, (_, i) => ({
          text: `generated query ${i}`,
          topic: "General",
          intent_tier: "informational",
          source: "llm_generated",
        })),
    }
  );
  assert.equal(out.prompt_source, PROMPT_SOURCE.LLM_GENERATED);
  assert.equal(out.static_pack_prompts, 0);
});

test("sourcing — the reused-pool early return also reports provenance", async () => {
  const pool = makePool(29).concat(dbRow("generic industry question", 29, { source: STATIC_PACK_SOURCE }));
  const out = await sourceUnbrandedQueries(
    BRAND, URL, "food", {}, ALIASES,
    {
      promptTarget: 30,
      getPromptsForBrand: async (key) => (key === "sleepyowl.co" ? pool : []),
      upsertPrompts: async () => ({}),
      generateUnbrandedPrompts: async () => {
        throw new Error("generation must not run when the pool is full");
      },
    }
  );
  assert.equal(out.newlyGenerated.length, 0);
  assert.equal(out.prompt_source, PROMPT_SOURCE.STATIC_INDUSTRY_PACK);
  assert.equal(out.static_pack_prompts, 1);
});


test("customer sourcing isolates prompts by workspace and never migrates another brand's pool", async () => {
  const calls = [];
  const result = await sourceUnbrandedQueries(BRAND, URL, "food", {}, ALIASES, {
    brandKey: "workspace-a", promptTarget: 2,
    getPromptsForBrand: async (key) => {
      calls.push(key);
      return key === "workspace-a" ? [] : makePool(30);
    },
    upsertPrompts: async () => { throw new Error("Must not copy legacy prompts"); },
    generateUnbrandedPrompts: async () => [
      { text: "best coffee for a cold brew", intent_tier: "informational", weight: 1 },
      { text: "how to choose coffee beans", intent_tier: "informational", weight: 1 },
    ],
  });
  assert.deepEqual(calls, ["workspace-a"]);
  assert.equal(result.promptKey, "workspace-a");
});
