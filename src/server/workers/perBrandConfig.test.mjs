import test from "node:test";
import assert from "node:assert/strict";
import {
  runSourcingPhase,
  runProbingPhase,
  resolvePromptTarget,
  createChunkTally,
} from "./scanWorker.js";
import { resolveEnabledEngines } from "../../shared/scoring/enginePipeline.js";
import { resolveSerpGeo } from "../../shared/engines/serpGeo.js";

/**
 * R3.4.4 — Worker honors per-brand prompt_target, engines and geo from the
 * brand's scan_schedules row, falling back to global env only when absent.
 *
 * These tests prove:
 *  1. The pure resolvers accept an override (the per-brand path) and fall back
 *     to env when absent.
 *  2. runSourcingPhase reads getScanSchedule, passes per-brand values into the
 *     checkpoint, and those values appear on the returned checkpoint object.
 *  3. runProbingPhase reads checkpoint.geo and passes it to engine.probe.
 */

// ---------------------------------------------------------------------------
// 1. resolvePromptTarget — override vs. env fallback
// ---------------------------------------------------------------------------

test("resolvePromptTarget(60) returns 60 (per-brand override)", () => {
  assert.equal(resolvePromptTarget(60), 60);
});

test("resolvePromptTarget(15) is clamped to minimum 10", () => {
  assert.equal(resolvePromptTarget(15), 15);
});

test("resolvePromptTarget(10) is at the lower bound", () => {
  assert.equal(resolvePromptTarget(10), 10);
});

test("resolvePromptTarget(100) is at the upper bound", () => {
  assert.equal(resolvePromptTarget(100), 100);
});

test("resolvePromptTarget(200) is clamped to maximum 100", () => {
  assert.equal(resolvePromptTarget(200), 100);
});

test("resolvePromptTarget(undefined) falls back to env PROMPT_TARGET", () => {
  const prev = process.env.PROMPT_TARGET;
  try {
    process.env.PROMPT_TARGET = "45";
    assert.equal(resolvePromptTarget(undefined), 45);
  } finally {
    if (prev === undefined) delete process.env.PROMPT_TARGET;
    else process.env.PROMPT_TARGET = prev;
  }
});

test("resolvePromptTarget(null) falls back to env PROMPT_TARGET", () => {
  const prev = process.env.PROMPT_TARGET;
  try {
    process.env.PROMPT_TARGET = "25";
    assert.equal(resolvePromptTarget(null), 25);
  } finally {
    if (prev === undefined) delete process.env.PROMPT_TARGET;
    else process.env.PROMPT_TARGET = prev;
  }
});

test("resolvePromptTarget() with no override and no env returns the default (30)", () => {
  const prev = process.env.PROMPT_TARGET;
  try {
    delete process.env.PROMPT_TARGET;
    assert.equal(resolvePromptTarget(), 30, "the DEFAULT_UNBRANDED_TARGET is 30");
  } finally {
    if (prev === undefined) delete process.env.PROMPT_TARGET;
    else process.env.PROMPT_TARGET = prev;
  }
});

// ---------------------------------------------------------------------------
// 2. resolveEnabledEngines — override string is honored
// ---------------------------------------------------------------------------

test("resolveEnabledEngines({ engines: 'aio,chatgpt' }) honors the override string over env", () => {
  const oldEngines = process.env.ENGINES;
  const oldBrightdata = process.env.BRIGHTDATA_API_KEY;
  try {
    // Set env to something different — the override must win.
    process.env.ENGINES = "perplexity";
    process.env.BRIGHTDATA_API_KEY = "test-key";

    const engines = resolveEnabledEngines({ engines: "aio,chatgpt" });
    const names = engines.map((e) => e.name);
    // aio is configured (BRIGHTDATA_API_KEY is set), chatgpt may or may not be.
    // The point: "perplexity" from env was IGNORED and "aio,chatgpt" was used.
    assert.ok(names.includes("aio"), "aio must be in the set from the override string");
    assert.ok(!names.includes("perplexity"), "perplexity from env must be ignored when override is present");
  } finally {
    if (oldEngines === undefined) delete process.env.ENGINES;
    else process.env.ENGINES = oldEngines;
    if (oldBrightdata === undefined) delete process.env.BRIGHTDATA_API_KEY;
    else process.env.BRIGHTDATA_API_KEY = oldBrightdata;
  }
});

test("resolveEnabledEngines({ engines: 'aio' }) returns only aio from the override", () => {
  const oldBrightdata = process.env.BRIGHTDATA_API_KEY;
  try {
    process.env.BRIGHTDATA_API_KEY = "test-key";
    const engines = resolveEnabledEngines({ engines: "aio" });
    assert.deepEqual(
      engines.map((e) => e.name),
      ["aio"]
    );
  } finally {
    if (oldBrightdata === undefined) delete process.env.BRIGHTDATA_API_KEY;
    else process.env.BRIGHTDATA_API_KEY = oldBrightdata;
  }
});

// ---------------------------------------------------------------------------
// 3. resolveSerpGeo — override vs. env fallback
// ---------------------------------------------------------------------------

test("resolveSerpGeo('us') returns 'us' (per-brand override)", () => {
  assert.equal(resolveSerpGeo("us"), "us");
});

test("resolveSerpGeo('GB') normalises to lowercase 'gb'", () => {
  assert.equal(resolveSerpGeo("GB"), "gb");
});

test("resolveSerpGeo() with no override falls back to env SERP_GEO", () => {
  const prev = process.env.SERP_GEO;
  try {
    process.env.SERP_GEO = "de";
    assert.equal(resolveSerpGeo(), "de");
  } finally {
    if (prev === undefined) delete process.env.SERP_GEO;
    else process.env.SERP_GEO = prev;
  }
});

test("resolveSerpGeo() with no override and no env returns the default ('in')", () => {
  const prev = process.env.SERP_GEO;
  try {
    delete process.env.SERP_GEO;
    assert.equal(resolveSerpGeo(), "in", "the DEFAULT_SERP_GEO is 'in'");
  } finally {
    if (prev === undefined) delete process.env.SERP_GEO;
    else process.env.SERP_GEO = prev;
  }
});

// ---------------------------------------------------------------------------
// 4. runSourcingPhase — reads the schedule row and passes per-brand values
//    through to the checkpoint.
// ---------------------------------------------------------------------------

const JOB = { brand: "Acme", url: "acme.com", industry: "saas", competitors: "RivalA" };

function fullPool(n = 10) {
  return Array.from({ length: n }, (_, i) => ({
    text: `unbranded seed ${i}`,
    intent_tier: "informational",
    topic: "General",
    weight: 1,
    enabled: true,
    source: "llm_generated",
    created_at: "2026-07-01T00:00:00Z",
  }));
}

/**
 * Sourcing deps with a schedule row that carries per-brand values.
 * The schedule mock returns a row with prompt_target=60, engines="aio,chatgpt",
 * and geo="us".
 *
 * NOTE: deps.promptTarget is intentionally OMITTED so the schedule's
 * prompt_target flows through via `resolvePromptTarget(schedule?.prompt_target)`
 * — the same path production uses (runScanChunk passes deps without
 * promptTarget). Setting it would short-circuit the schedule value.
 */
function sourcingDepsWithSchedule(scheduleRow) {
  return {
    // deps.promptTarget intentionally absent — production doesn't set it
    getPromptsForBrand: async () => fullPool(60),
    upsertPrompts: async () => ({}),
    generateUnbrandedPrompts: async () => {
      throw new Error("must not generate — the pool is already full");
    },
    buildBrandedQueries: () => [
      { text: "acme reviews", source: "branded_seed", topic: "Brand Presence", intent_tier: "branded" },
    ],
    resolveEnabledEngines: ({ engines } = {}) => {
      // Mirror the real resolver's override behavior: if engines string is
      // present, parse it; otherwise default to ["aio"].
      if (engines) {
        return engines.split(",").map((s) => ({ name: s.trim() }));
      }
      return [{ name: "aio" }];
    },
    // Return the per-brand schedule row
    getScanSchedule: async () => scheduleRow,
    insertScanScheduleIfNotExists: async () => null, // existing row
  };
}

test("runSourcingPhase — checkpoint carries per-brand prompt_target from the schedule row", async () => {
  const scheduleRow = {
    brand: "acme.com",
    prompt_target: 60,
    engines: "aio,chatgpt",
    geo: "us",
  };

  const checkpoint = await runSourcingPhase(
    JOB,
    sourcingDepsWithSchedule(scheduleRow),
    createChunkTally()
  );

  assert.equal(
    checkpoint.prompt_target,
    60,
    "prompt_target must come from the schedule row, not the deps default (10)"
  );
});

test("runSourcingPhase — checkpoint carries per-brand geo from the schedule row", async () => {
  const scheduleRow = {
    brand: "acme.com",
    prompt_target: 60,
    engines: "aio,chatgpt",
    geo: "us",
  };

  const checkpoint = await runSourcingPhase(
    JOB,
    sourcingDepsWithSchedule(scheduleRow),
    createChunkTally()
  );

  assert.equal(
    checkpoint.geo,
    "us",
    "geo must come from the schedule row ('us'), not the default ('in')"
  );
});

test("runSourcingPhase — checkpoint carries per-brand engines from the schedule row", async () => {
  const scheduleRow = {
    brand: "acme.com",
    prompt_target: 60,
    engines: "aio,chatgpt",
    geo: "us",
  };

  const checkpoint = await runSourcingPhase(
    JOB,
    sourcingDepsWithSchedule(scheduleRow),
    createChunkTally()
  );

  assert.deepEqual(
    checkpoint.engines,
    ["aio", "chatgpt"],
    "engines must come from the schedule row parsed as a comma-separated list"
  );
});

test("runSourcingPhase — when getScanSchedule returns null, falls back to env/defaults", async () => {
  const deps = {
    // No promptTarget — falls through to resolvePromptTarget(undefined) which
    // uses the default (30). Provide a pool of 30 so no generation is needed.
    getPromptsForBrand: async () => fullPool(30),
    upsertPrompts: async () => ({}),
    generateUnbrandedPrompts: async () => {
      throw new Error("must not generate — the pool is already full");
    },
    buildBrandedQueries: () => [],
    resolveEnabledEngines: () => [{ name: "aio" }],
    getScanSchedule: async () => null, // no schedule row
    insertScanScheduleIfNotExists: async () => null,
  };

  const checkpoint = await runSourcingPhase(JOB, deps, createChunkTally());

  assert.equal(checkpoint.prompt_target, 30, "prompt_target falls back to the default (30)");
  assert.equal(checkpoint.geo, "in", "geo falls back to the env default ('in')");
  assert.deepEqual(checkpoint.engines, ["aio"], "engines falls back to resolveEnabledEngines default");
});

test("runSourcingPhase — when getScanSchedule throws, falls back to env/defaults", async () => {
  const deps = {
    // No promptTarget — falls through to resolvePromptTarget(undefined) which
    // uses the default (30). Provide a pool of 30 so no generation is needed.
    getPromptsForBrand: async () => fullPool(30),
    upsertPrompts: async () => ({}),
    generateUnbrandedPrompts: async () => {
      throw new Error("must not generate — the pool is already full");
    },
    buildBrandedQueries: () => [],
    resolveEnabledEngines: () => [{ name: "aio" }],
    getScanSchedule: async () => {
      throw new Error("DB connection lost");
    },
    insertScanScheduleIfNotExists: async () => null,
  };

  const checkpoint = await runSourcingPhase(JOB, deps, createChunkTally());

  assert.equal(checkpoint.prompt_target, 30, "prompt_target falls back to the default on schedule read failure");
  assert.equal(checkpoint.geo, "in", "geo falls back to default on schedule read failure");
});

test("runSourcingPhase — per-brand prompt_target is passed through to sourceUnbrandedQueries", async () => {
  let capturedPromptTarget = null;
  const scheduleRow = {
    brand: "acme.com",
    prompt_target: 55,
    engines: "aio",
    geo: "in",
  };

  const deps = {
    // Capture what sourceUnbrandedQueries receives
    getPromptsForBrand: async () => fullPool(5), // only 5 in pool
    upsertPrompts: async () => ({}),
    generateUnbrandedPrompts: async (brand, url, industry, stats, shortfall) => {
      // Generate to meet target
      return Array.from({ length: shortfall }, (_, i) => ({
        text: `generated ${i}`,
        intent_tier: "informational",
        topic: "General",
        source: "llm_generated",
      }));
    },
    buildBrandedQueries: () => [],
    resolveEnabledEngines: () => [{ name: "aio" }],
    getScanSchedule: async () => scheduleRow,
    insertScanScheduleIfNotExists: async () => null,
    // Override sourceUnbrandedQueries to capture the promptTarget it receives
    sourceUnbrandedQueries: async (brand, url, industry, stats, brandAliases, innerDeps) => {
      capturedPromptTarget = innerDeps.promptTarget;
      return {
        queries: fullPool(innerDeps.promptTarget || 10),
        newlyGenerated: [],
        prompt_source: "db",
        static_pack_prompts: 0,
      };
    },
  };

  const checkpoint = await runSourcingPhase(JOB, deps, createChunkTally());

  assert.equal(capturedPromptTarget, 55, "the per-brand prompt_target from the schedule reaches sourceUnbrandedQueries");
  assert.equal(checkpoint.prompt_target, 55, "and also appears on the checkpoint");
});

// ---------------------------------------------------------------------------
// 5. runProbingPhase — passes checkpoint.geo to engine.probe
// ---------------------------------------------------------------------------

test("runProbingPhase — passes checkpoint.geo to engine.probe as options.geo", async () => {
  const capturedProbeOptions = [];
  const queries = [{ text: "query 1", source: "test", topic: "General", intent_tier: "informational" }];

  const checkpoint = {
    brand: "Acme",
    url: "acme.com",
    competitors: [],
    queries,
    prompt_key: "acme.com",
    engines: ["aio"],
    geo: "us",
    prompt_target: 30,
    stats: { cost: 0, tokens: 0 },
    sourced_at: new Date().toISOString(),
  };

  const deps = {
    updateScanJob: async () => ({}),
    getCompletedPairsForJob: async () => new Set(),
    upsertPromptResults: async () => {},
    resolveEnabledEngines: () => [
      {
        name: "aio",
        concurrency: 1,
        probe: async (query, brand, brandAliases, brandDomain, competitors, stats, options) => {
          capturedProbeOptions.push({ ...options });
          return {
            engine: "aio",
            prompt: query.text,
            answer_present: false,
            aio_present: false,
            text: "",
            citations: [],
            references: [],
            brand_mentioned_in_text: false,
            brand_cited: false,
            visible: false,
            competitors_found_in_text: [],
            competitors_cited: [],
            is_branded_query: false,
            topic: "General",
            source: "test",
            intent_tier: "informational",
            brands: [],
            error: null,
            cost: 0,
          };
        },
      },
    ],
    now: () => Date.now(),
    chunkBudgetMs: 300_000,
  };

  const tally = createChunkTally();
  await runProbingPhase("job-1", checkpoint, deps, Date.now(), tally);

  assert.ok(capturedProbeOptions.length > 0, "engine.probe must have been called");
  assert.equal(
    capturedProbeOptions[0].geo,
    "us",
    "checkpoint.geo ('us') must be passed to engine.probe as options.geo"
  );
});

test("runProbingPhase — when checkpoint.geo is absent, falls back to resolveSerpGeo()", async () => {
  const capturedProbeOptions = [];
  const queries = [{ text: "query 1", source: "test", topic: "General", intent_tier: "informational" }];

  const checkpoint = {
    brand: "Acme",
    url: "acme.com",
    competitors: [],
    queries,
    prompt_key: "acme.com",
    engines: ["aio"],
    // No geo field — simulates an older checkpoint
    stats: { cost: 0, tokens: 0 },
    sourced_at: new Date().toISOString(),
  };

  const prev = process.env.SERP_GEO;
  try {
    process.env.SERP_GEO = "gb";

    const deps = {
      updateScanJob: async () => ({}),
      getCompletedPairsForJob: async () => new Set(),
      upsertPromptResults: async () => {},
      resolveEnabledEngines: () => [
        {
          name: "aio",
          concurrency: 1,
          probe: async (query, brand, brandAliases, brandDomain, competitors, stats, options) => {
            capturedProbeOptions.push({ ...options });
            return {
              engine: "aio",
              prompt: query.text,
              answer_present: false,
              aio_present: false,
              text: "",
              citations: [],
              references: [],
              brand_mentioned_in_text: false,
              brand_cited: false,
              visible: false,
              competitors_found_in_text: [],
              competitors_cited: [],
              is_branded_query: false,
              topic: "General",
              source: "test",
              intent_tier: "informational",
              brands: [],
              error: null,
              cost: 0,
            };
          },
        },
      ],
      now: () => Date.now(),
      chunkBudgetMs: 300_000,
    };

    const tally = createChunkTally();
    await runProbingPhase("job-2", checkpoint, deps, Date.now(), tally);

    assert.ok(capturedProbeOptions.length > 0, "engine.probe must have been called");
    assert.equal(
      capturedProbeOptions[0].geo,
      "gb",
      "when checkpoint.geo is absent, falls back to SERP_GEO env"
    );
  } finally {
    if (prev === undefined) delete process.env.SERP_GEO;
    else process.env.SERP_GEO = prev;
  }
});

test("runProbingPhase — checkpoint.geo='in' overrides SERP_GEO env", async () => {
  const capturedProbeOptions = [];
  const queries = [{ text: "query 1", source: "test", topic: "General", intent_tier: "informational" }];

  const checkpoint = {
    brand: "Acme",
    url: "acme.com",
    competitors: [],
    queries,
    prompt_key: "acme.com",
    engines: ["aio"],
    geo: "in", // per-brand override
    stats: { cost: 0, tokens: 0 },
    sourced_at: new Date().toISOString(),
  };

  const prev = process.env.SERP_GEO;
  try {
    process.env.SERP_GEO = "gb"; // env says gb, but checkpoint says in

    const deps = {
      updateScanJob: async () => ({}),
      getCompletedPairsForJob: async () => new Set(),
      upsertPromptResults: async () => {},
      resolveEnabledEngines: () => [
        {
          name: "aio",
          concurrency: 1,
          probe: async (query, brand, brandAliases, brandDomain, competitors, stats, options) => {
            capturedProbeOptions.push({ ...options });
            return {
              engine: "aio",
              prompt: query.text,
              answer_present: false,
              aio_present: false,
              text: "",
              citations: [],
              references: [],
              brand_mentioned_in_text: false,
              brand_cited: false,
              visible: false,
              competitors_found_in_text: [],
              competitors_cited: [],
              is_branded_query: false,
              topic: "General",
              source: "test",
              intent_tier: "informational",
              brands: [],
              error: null,
              cost: 0,
            };
          },
        },
      ],
      now: () => Date.now(),
      chunkBudgetMs: 300_000,
    };

    const tally = createChunkTally();
    await runProbingPhase("job-3", checkpoint, deps, Date.now(), tally);

    assert.ok(capturedProbeOptions.length > 0, "engine.probe must have been called");
    assert.equal(
      capturedProbeOptions[0].geo,
      "in",
      "checkpoint.geo ('in') wins over SERP_GEO env ('gb')"
    );
  } finally {
    if (prev === undefined) delete process.env.SERP_GEO;
    else process.env.SERP_GEO = prev;
  }
});
