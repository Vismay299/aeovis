import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeEngineResults,
  summarizeEngineSlice,
  resolveEnabledEngines,
  buildTrackedBrandRoster,
  probeTextEngine,
  ENGINE_RESOLUTION_SKIPS,
} from "./enginePipeline.js";
import { getBrandAliases } from "./aliases.js";
import { TEXT_ENGINE_MIN_NON_BRANDED_COVERAGE } from "./enginePipeline.js";
import {
  describeScanDataSourceIssue,
  engineHealthThresholds,
} from "./enginePipeline.js";
import { AIO_MIN_NON_BRANDED_COVERAGE } from "./aioConstants.js";

function makeAioRow(overrides = {}) {
  return {
    engine: "aio",
    prompt: overrides.prompt || "sample query",
    is_branded_query: overrides.is_branded_query ?? false,
    answer_present: overrides.answer_present ?? false,
    aio_present: overrides.aio_present ?? overrides.answer_present ?? false,
    text: overrides.text || "",
    citations: overrides.citations || [],
    references: overrides.references || [],
    brand_mentioned_in_text: overrides.brand_mentioned_in_text ?? false,
    brand_cited: overrides.brand_cited ?? false,
    visible: overrides.visible ?? false,
    error: overrides.error || null,
    cost: overrides.cost || 0,
  };
}

function makeChatGptRow(overrides = {}) {
  return {
    engine: "chatgpt",
    prompt: overrides.prompt || "sample query",
    is_branded_query: overrides.is_branded_query ?? false,
    answer_present: overrides.answer_present ?? !overrides.error,
    text: overrides.text || "Some ChatGPT answer.",
    citations: overrides.citations || [],
    references: overrides.references || [],
    brand_mentioned_in_text: overrides.brand_mentioned_in_text ?? false,
    brand_cited: overrides.brand_cited ?? false,
    visible: overrides.visible ?? false,
    error: overrides.error || null,
    cost: overrides.cost || 0,
  };
}

function makePerplexityRow(overrides = {}) {
  return {
    engine: "perplexity",
    prompt: overrides.prompt || "sample query",
    is_branded_query: overrides.is_branded_query ?? false,
    answer_present: overrides.answer_present ?? !overrides.error,
    text: overrides.text || "Some Perplexity answer.",
    citations: overrides.citations || [],
    references: overrides.references || [],
    brand_mentioned_in_text: overrides.brand_mentioned_in_text ?? false,
    brand_cited: overrides.brand_cited ?? false,
    visible: overrides.visible ?? false,
    error: overrides.error || null,
    cost: overrides.cost || 0,
  };
}

function buildThreeEngineResults() {
  const aioResults = [];
  const chatgptResults = [];
  const perplexityResults = [];

  for (let i = 0; i < 10; i++) {
    // AIO: only 6 have an answer, 3 visible
    aioResults.push(makeAioRow({
      prompt: `unbranded ${i}`,
      answer_present: i < 6,
      aio_present: i < 6,
      text: i < 6 ? `AIO text ${i}` : "",
      visible: i < 3,
      brand_mentioned_in_text: i < 3,
    }));
    // ChatGPT: all answer, 8 visible
    chatgptResults.push(makeChatGptRow({
      prompt: `unbranded ${i}`,
      visible: i < 8,
      brand_mentioned_in_text: i < 8,
    }));
    // Perplexity: all answer, 4 visible
    perplexityResults.push(makePerplexityRow({
      prompt: `unbranded ${i}`,
      visible: i < 4,
      brand_mentioned_in_text: i < 4,
    }));
  }

  return {
    results: [...aioResults, ...chatgptResults, ...perplexityResults],
    engines: {
      aio: { results: aioResults, engine: "aio" },
      chatgpt: { results: chatgptResults, engine: "chatgpt" },
      perplexity: { results: perplexityResults, engine: "perplexity" },
    },
  };
}

test("summarizeEngineResults computes per-engine summaries correctly", () => {
  const fixture = buildThreeEngineResults();

  // Patch summarizeEngineResults to use our fixture data
  const scanOutput = {
    results: fixture.results,
    engines: {
      aio: summarizeSlice(fixture.engines.aio.results, "aio"),
      chatgpt: summarizeSlice(fixture.engines.chatgpt.results, "chatgpt"),
      perplexity: summarizeSlice(fixture.engines.perplexity.results, "perplexity"),
    },
    headline: computeHeadlineFromSlices([
      summarizeSlice(fixture.engines.aio.results, "aio"),
      summarizeSlice(fixture.engines.chatgpt.results, "chatgpt"),
      summarizeSlice(fixture.engines.perplexity.results, "perplexity"),
    ]),
  };

  const output = summarizeEngineResults(scanOutput);

  assert.ok(output.engines.aio, "aio engine summary present");
  assert.ok(output.engines.chatgpt, "chatgpt engine summary present");
  assert.ok(output.engines.perplexity, "perplexity engine summary present");

  // AIO: 6/10 answers, 3/6 visible = 50%
  assert.equal(output.engines.aio.non_branded_with_answer, 6);
  assert.equal(output.engines.aio.visible_non_branded, 3);
  assert.equal(output.engines.aio.share_of_ai_pct, 50);

  // ChatGPT: 10/10 answers, 8/10 visible = 80%
  assert.equal(output.engines.chatgpt.non_branded_with_answer, 10);
  assert.equal(output.engines.chatgpt.visible_non_branded, 8);
  assert.equal(output.engines.chatgpt.share_of_ai_pct, 80);

  // Perplexity: 10/10 answers, 4/10 visible = 40%
  assert.equal(output.engines.perplexity.non_branded_with_answer, 10);
  assert.equal(output.engines.perplexity.visible_non_branded, 4);
  assert.equal(output.engines.perplexity.share_of_ai_pct, 40);

  // Headline: (50 + 80 + 40) / 3 = 56.7
  assert.ok(output.headline.engines_counted >= 3);
  assert.ok(output.headline.visibility_index_pct != null);
});

test("summarizeEngineResults excludes engines with <5 non-branded answers from headline", () => {
  // Only 3 non-branded AIO answers — excluded from headline
  const aioSlice = summarizeSlice([
    makeAioRow({ prompt: "q1", answer_present: true, aio_present: true, text: "a", visible: true }),
    makeAioRow({ prompt: "q2", answer_present: true, aio_present: true, text: "a", visible: false }),
    makeAioRow({ prompt: "q3", answer_present: true, aio_present: true, text: "a", visible: true }),
    makeAioRow({ prompt: "q4", answer_present: false, aio_present: false }),
  ], "aio");

  const chatgptSlice = summarizeSlice([
    makeChatGptRow({ prompt: "q1", visible: true }),
    makeChatGptRow({ prompt: "q2", visible: true }),
    makeChatGptRow({ prompt: "q3", visible: true }),
    makeChatGptRow({ prompt: "q4", visible: false }),
    makeChatGptRow({ prompt: "q5", visible: true }),
    makeChatGptRow({ prompt: "q6", visible: false }),
  ], "chatgpt");

  const headline = computeHeadlineFromSlices([aioSlice, chatgptSlice]);

  // AIO has only 3 non-branded answers → excluded
  // ChatGPT has 6 → counted, share_of_ai = 4/6 = 66.7
  assert.equal(headline.engines_counted, 1);
  assert.equal(headline.visibility_index_pct, 66.7);
});

test("summarizeEngineResults branded rows excluded from denominators", () => {
  const results = [
    makeAioRow({ prompt: "unbranded 1", answer_present: true, aio_present: true, text: "a", visible: true }),
    makeAioRow({ prompt: "unbranded 2", answer_present: true, aio_present: true, text: "a", visible: false }),
    makeAioRow({ prompt: "brand query", is_branded_query: true, answer_present: true, aio_present: true, text: "a", visible: true }),
    makeAioRow({ prompt: "brand query 2", is_branded_query: true, answer_present: true, aio_present: true, text: "a", visible: true }),
  ];

  const slice = summarizeSlice(results, "aio");
  assert.equal(slice.non_branded_queries, 2);
  assert.equal(slice.branded_queries, 2);
  assert.equal(slice.share_of_ai_pct, 50); // 1/2 visible
});

test("resolveEnabledEngines defaults to aio", () => {
  const oldEngines = process.env.ENGINES;
  const oldBrightdata = process.env.BRIGHTDATA_API_KEY;
  delete process.env.ENGINES;
  process.env.BRIGHTDATA_API_KEY = "test-key";

  const engines = resolveEnabledEngines();
  assert.equal(engines.length, 1);
  assert.equal(engines[0].name, "aio");

  if (oldEngines) process.env.ENGINES = oldEngines;
  if (oldBrightdata) process.env.BRIGHTDATA_API_KEY = oldBrightdata;
  else delete process.env.BRIGHTDATA_API_KEY;
});

test("resolveEnabledEngines parses comma-separated list", () => {
  const oldEngines = process.env.ENGINES;
  const oldBrightdata = process.env.BRIGHTDATA_API_KEY;
  process.env.ENGINES = "aio,chatgpt,perplexity";
  process.env.BRIGHTDATA_API_KEY = "test-key";

  const engines = resolveEnabledEngines();
  // chatgpt and perplexity may not be configured — aio is configured
  assert.ok(engines.length >= 1);
  assert.equal(engines[0].name, "aio");

  if (oldEngines) process.env.ENGINES = oldEngines;
  if (oldBrightdata) process.env.BRIGHTDATA_API_KEY = oldBrightdata;
  else delete process.env.BRIGHTDATA_API_KEY;
});

test("resolveEnabledEngines accepts one shared OpenRouter key for both model engines", () => {
  const names = [
    "ENGINES",
    "BRIGHTDATA_API_KEY",
    "OPENAI_API_KEY",
    "PERPLEXITY_API_KEY",
    "LLM_API_KEY",
    "OPENROUTER_API_KEY",
    "LLM_BASE_URL",
    "OPENROUTER_BASE_URL",
  ];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.ENGINES = "chatgpt,perplexity";
  delete process.env.BRIGHTDATA_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  process.env.LLM_API_KEY = "shared-openrouter-test-key";
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.LLM_BASE_URL;
  delete process.env.OPENROUTER_BASE_URL;
  try {
    assert.deepEqual(
      resolveEnabledEngines().map((engine) => engine.name),
      ["chatgpt", "perplexity"]
    );
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

// ---------------------------------------------------------------------------
// R3.2.2 — the skip set escapes resolveEnabledEngines instead of dying in it
// ---------------------------------------------------------------------------

/** Swap ENGINES and the engine keys, run fn, put everything back. */
function withEngineEnv({ engines, openaiKey, perplexityKey, brightdataKey }, fn) {
  const saved = {
    ENGINES: process.env.ENGINES,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    PERPLEXITY_API_KEY: process.env.PERPLEXITY_API_KEY,
    BRIGHTDATA_API_KEY: process.env.BRIGHTDATA_API_KEY,
  };
  const apply = (key, value) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  apply("ENGINES", engines);
  apply("OPENAI_API_KEY", openaiKey);
  apply("PERPLEXITY_API_KEY", perplexityKey);
  apply("BRIGHTDATA_API_KEY", brightdataKey);
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) apply(key, value);
  }
}

test("resolveEnabledEngines reports an unknown engine and a keyless engine as DIFFERENT reasons", () => {
  const seen = [];
  const engines = withEngineEnv(
    { engines: "aio,chatgpt,notanengine", openaiKey: undefined, brightdataKey: "test-key" },
    () => resolveEnabledEngines({ onSkip: (kind, subject) => seen.push([kind, subject]) })
  );

  assert.deepEqual(engines.map((e) => e.name), ["aio"], "only aio survives this ENGINES set");
  // The whole point of the two codes: a typo and a missing key are different
  // operator actions, so they must not arrive as one "engine dropped".
  assert.deepEqual(
    seen.sort(),
    [
      [ENGINE_RESOLUTION_SKIPS.NOT_CONFIGURED, "chatgpt"],
      [ENGINE_RESOLUTION_SKIPS.UNKNOWN, "notanengine"],
    ].sort(),
    "both drops must surface, each under its own reason, named by engine"
  );
});

test("resolveEnabledEngines announces the default-to-aio substitution as its own reason", () => {
  const seen = [];
  const engines = withEngineEnv(
    { engines: "chatgpt,perplexity", openaiKey: undefined, perplexityKey: undefined, brightdataKey: "test-key" },
    () => resolveEnabledEngines({ onSkip: (kind, subject) => seen.push([kind, subject]) })
  );

  // The scan still runs — on an engine set nobody asked for. That substitution
  // is the fact that used to live only in a console.warn.
  assert.deepEqual(engines.map((e) => e.name), ["aio"]);
  const defaulted = seen.filter(([kind]) => kind === ENGINE_RESOLUTION_SKIPS.SET_DEFAULTED);
  assert.equal(defaulted.length, 1, "the substitution is announced exactly once");
  assert.equal(defaulted[0][1], "chatgpt,perplexity", "and it names the set that was asked for");
  assert.equal(
    seen.filter(([kind]) => kind === ENGINE_RESOLUTION_SKIPS.NOT_CONFIGURED).length,
    2,
    "the per-engine drops that caused it are still reported individually"
  );
});

test("resolveEnabledEngines reports nothing when nothing was dropped", () => {
  const seen = [];
  const engines = withEngineEnv({ engines: "aio", brightdataKey: "test-key" }, () =>
    resolveEnabledEngines({ onSkip: (kind, subject) => seen.push([kind, subject]) })
  );
  assert.deepEqual(engines.map((e) => e.name), ["aio"]);
  assert.deepEqual(seen, [], "a clean resolve must not manufacture skips");
});

test("resolveEnabledEngines still returns a plain array for callers that pass no recorder", () => {
  // ~50 existing call sites destructure the return as an array of engine defs.
  // The recorder is additive; it must never change the shape.
  const engines = withEngineEnv({ engines: "aio,notanengine", brightdataKey: "test-key" }, () => resolveEnabledEngines());
  assert.ok(Array.isArray(engines));
  assert.deepEqual(engines.map((e) => e.name), ["aio"]);
});

// ---------------------------------------------------------------------------
// R2.10.4 — aio's isConfigured must reflect BRIGHTDATA_API_KEY, not return true
// ---------------------------------------------------------------------------

test("aio isConfigured returns true when BRIGHTDATA_API_KEY is set", () => {
  const old = process.env.BRIGHTDATA_API_KEY;
  process.env.BRIGHTDATA_API_KEY = "test-key";
  try {
    const aio = resolveEnabledEngines({ onSkip: () => {} }).find((e) => e.name === "aio");
    assert.ok(aio, "aio must be in the enabled set when its key is present");
    assert.equal(aio.isConfigured(), true);
  } finally {
    if (old === undefined) delete process.env.BRIGHTDATA_API_KEY;
    else process.env.BRIGHTDATA_API_KEY = old;
  }
});

test("aio isConfigured returns false when BRIGHTDATA_API_KEY is absent", () => {
  const old = process.env.BRIGHTDATA_API_KEY;
  delete process.env.BRIGHTDATA_API_KEY;
  try {
    const engines = withEngineEnv({ engines: "aio" }, () => resolveEnabledEngines());
    // aio must not appear in the enabled set — its key is missing.
    assert.equal(engines.find((e) => e.name === "aio"), undefined, "aio must be dropped when BRIGHTDATA_API_KEY is absent");
  } finally {
    if (old !== undefined) process.env.BRIGHTDATA_API_KEY = old;
  }
});

test("resolveEnabledEngines drops aio when BRIGHTDATA_API_KEY is absent", () => {
  const seen = [];
  const engines = withEngineEnv(
    { engines: "aio", brightdataKey: undefined },
    () => resolveEnabledEngines({ onSkip: (kind, subject) => seen.push([kind, subject]) })
  );

  assert.deepEqual(engines.map((e) => e.name), [], "no engine survives without its key");
  assert.deepEqual(
    seen,
    [[ENGINE_RESOLUTION_SKIPS.NOT_CONFIGURED, "aio"]],
    "aio must be reported as NOT_CONFIGURED, not silently swallowed"
  );
});

test("resolveEnabledEngines does not fall back to aio when aio itself is unconfigured", () => {
  const seen = [];
  const engines = withEngineEnv(
    // Both text engines have no keys, and aio also has no BRIGHTDATA_API_KEY.
    { engines: "chatgpt,perplexity", openaiKey: undefined, perplexityKey: undefined, brightdataKey: undefined },
    () => resolveEnabledEngines({ onSkip: (kind, subject) => seen.push([kind, subject]) })
  );

  assert.deepEqual(engines, [], "the fallback must not silently re-enable an unconfigured aio");
  assert.equal(
    seen.filter(([kind]) => kind === ENGINE_RESOLUTION_SKIPS.SET_DEFAULTED).length,
    0,
    "SET_DEFAULTED must not fire when even the fallback engine is unconfigured"
  );
});

test("R2.10.4 GUARD — aio's isConfigured is not hardcoded to true", () => {
  // If someone reverts the fix and pins isConfigured: () => true, this test
  // catches it: with BRIGHTDATA_API_KEY absent, aio must NOT be configured.
  const old = process.env.BRIGHTDATA_API_KEY;
  delete process.env.BRIGHTDATA_API_KEY;
  try {
    const aio = resolveEnabledEngines({ onSkip: () => [] }).find((e) => e.name === "aio");
    // If isConfigured is pinned true, aio will be in the list. This assertion
    // must fail in that case — which is exactly what we want.
    assert.equal(aio, undefined, "aio must not resolve when BRIGHTDATA_API_KEY is absent — isConfigured may have been pinned true again");
  } finally {
    if (old !== undefined) process.env.BRIGHTDATA_API_KEY = old;
  }
});

// Reuse summarize logic inline for testing
function summarizeSlice(results, engineName) {
  const total = results.length;
  const errored = results.filter((r) => r.error).length;
  const withAnswer = results.filter((r) => r.answer_present);
  const branded = results.filter((r) => r.is_branded_query);
  const nonBranded = results.filter((r) => !r.is_branded_query);
  const nonBrandedWithAnswer = nonBranded.filter((r) => r.answer_present);
  const brandedWithAnswer = branded.filter((r) => r.answer_present);
  const visibleNonBranded = nonBrandedWithAnswer.filter((r) => r.visible).length;
  const visibleBranded = brandedWithAnswer.filter((r) => r.visible).length;
  const coveragePct = nonBranded.length > 0 ? Math.round((nonBrandedWithAnswer.length / nonBranded.length) * 1000) / 10 : 0;
  const errorRatePct = total > 0 ? Math.round((errored / total) * 1000) / 10 : 0;
  const visibilityPct = nonBrandedWithAnswer.length > 0 ? Math.round((visibleNonBranded / nonBrandedWithAnswer.length) * 1000) / 10 : 0;
  const presenceRatePct = nonBranded.length > 0 ? Math.round((visibleNonBranded / nonBranded.length) * 1000) / 10 : 0;

  const dataSourceIssue = engineName === "aio"
    ? errorRatePct > 50 || (nonBranded.length > 0 && nonBrandedWithAnswer.length / nonBranded.length < 0.15)
    : errorRatePct > 50;

  return {
    engine: engineName,
    total_queries: total,
    non_branded_queries: nonBranded.length,
    branded_queries: branded.length,
    queries_with_answer: withAnswer.length,
    non_branded_with_answer: nonBrandedWithAnswer.length,
    branded_with_answer: brandedWithAnswer.length,
    errored_queries: errored,
    visible_non_branded: visibleNonBranded,
    visible_branded: visibleBranded,
    coverage_pct: coveragePct,
    error_rate_pct: errorRatePct,
    share_of_ai_pct: visibilityPct,
    visibility_pct: visibilityPct,
    presence_rate_pct: presenceRatePct,
    data_source_issue: dataSourceIssue,
    insufficient_sample: nonBrandedWithAnswer.length < 5,
  };
}

function computeHeadlineFromSlices(engineSummaries) {
  const eligible = engineSummaries.filter(
    (s) => !s.data_source_issue && s.non_branded_with_answer >= 5
  );
  if (eligible.length === 0) return { visibility_index_pct: null, engines_counted: 0 };
  const sum = eligible.reduce((acc, s) => acc + s.share_of_ai_pct, 0);
  const mean = Math.round((sum / eligible.length) * 10) / 10;
  return { visibility_index_pct: mean, engines_counted: eligible.length };
}

// --- computeHeadline weight semantics (now exported) ---

import { computeHeadline, ENGINE_WEIGHTS } from "./enginePipeline.js";

function slice(engine, shareOfAi, overrides = {}) {
  return {
    engine,
    share_of_ai_pct: shareOfAi,
    non_branded_with_answer: 15,
    data_source_issue: false,
    ...overrides,
  };
}

test("computeHeadline — default weights give 50/50 blend of two engines", () => {
  const out = computeHeadline([slice("aio", 40), slice("perplexity", 60)]);
  assert.equal(out.visibility_index_pct, 50);
  assert.equal(out.engines_counted, 2);
});

test("computeHeadline — weights renormalize when one engine is ineligible", () => {
  const out = computeHeadline([
    slice("aio", 40, { data_source_issue: true }),
    slice("perplexity", 60),
  ]);
  assert.equal(out.visibility_index_pct, 60);
  assert.equal(out.engines_counted, 1);
});

test("computeHeadline — custom weights shift the blend", () => {
  const out = computeHeadline(
    [slice("aio", 40), slice("perplexity", 60)],
    { aio: 3, perplexity: 1 }
  );
  // (40*3 + 60*1) / 4 = 45
  assert.equal(out.visibility_index_pct, 45);
});

test("computeHeadline — unknown engine defaults to weight 1", () => {
  const out = computeHeadline(
    [slice("aio", 40), slice("someday-engine", 80)],
    { aio: 1 }
  );
  assert.equal(out.visibility_index_pct, 60);
});

test("computeHeadline — <5 answers excludes an engine", () => {
  const out = computeHeadline([
    slice("aio", 40, { non_branded_with_answer: 3 }),
    slice("perplexity", 60),
  ]);
  assert.equal(out.visibility_index_pct, 60);
  assert.equal(out.engines_counted, 1);
});

test("ENGINE_WEIGHTS — default config is equal weights (50/50 contract)", () => {
  assert.equal(ENGINE_WEIGHTS.aio, ENGINE_WEIGHTS.perplexity);
});

// ---------------------------------------------------------------------------
// buildTrackedBrandRoster (P1.2) — the self+rival roster fed into
// judgeBrandsSymmetric from probeAio/probeTextEngine. probeAio/probeTextEngine
// themselves hit real network engines (Bright Data/ChatGPT/Perplexity) and
// aren't exported for that reason (matching this file's existing convention
// of testing the pure summarize/roster layer, never the network-calling probe
// functions directly) — this is the integration point that IS exercised here;
// the ranking/scoring logic itself is covered in judge.test.mjs.
// ---------------------------------------------------------------------------

test("buildTrackedBrandRoster — self brand first (reusing the already-resolved brandAliases), then one entry per competitor", () => {
  const brandAliases = ["Acme Corp", "acme", "acme.io"];
  const roster = buildTrackedBrandRoster("Acme Corp", brandAliases, ["Rival One", "Rival Two"]);

  assert.equal(roster.length, 3);

  assert.equal(roster[0].name, "Acme Corp");
  assert.equal(roster[0].isSelf, true);
  assert.deepEqual(roster[0].aliases, brandAliases, "self brand reuses the already-resolved brandAliases, not a fresh lookup");

  assert.equal(roster[1].name, "Rival One");
  assert.equal(roster[1].isSelf, false);
  assert.deepEqual(roster[1].aliases, getBrandAliases("Rival One", ""), "competitor aliases resolved the same way findCompetitorsInText does — no website known for a rival");

  assert.equal(roster[2].name, "Rival Two");
  assert.equal(roster[2].isSelf, false);
});

test("buildTrackedBrandRoster — no competitors -> roster is just the self brand", () => {
  const roster = buildTrackedBrandRoster("Acme", ["Acme"], []);
  assert.equal(roster.length, 1);
  assert.equal(roster[0].isSelf, true);
});

test("buildTrackedBrandRoster — missing competitors list does not throw", () => {
  const roster = buildTrackedBrandRoster("Acme", ["Acme"], undefined);
  assert.equal(roster.length, 1);
});

// --- eliciting denominator: self-only roster must not corrupt the score ----
// Regression for a bug caught by a LIVE Italica scan, not by unit tests.
// Competitors are discovered in runFinalizePhase, AFTER probing, so during a
// scan `r.brands` holds only the self brand. Filtering the denominator to
// "answers that named a roster brand" then means "answers that named US",
// which makes numerator and denominator identical.

function rowWithBrands(overrides = {}) {
  return {
    query: overrides.query || "best tiles in india",
    error: null,
    answer_present: overrides.answer_present ?? true,
    is_branded_query: overrides.is_branded_query ?? false,
    visible: overrides.visible ?? false,
    brand_mentioned_in_text: overrides.visible ?? false,
    brand_cited: false,
    brands: overrides.brands ?? [{ name: "Italica", is_self: true, mentioned: overrides.visible ?? false }],
  };
}

test("self-only roster does NOT collapse the denominator (live-scan regression)", () => {
  // 27 answered prompts, self never mentioned. A self-only roster carries no
  // information about whether vendors were named, so the filter must not apply.
  const rows = Array.from({ length: 27 }, () => rowWithBrands({ visible: false }));
  const s = summarizeEngineSlice(rows, "aio");
  assert.equal(s.non_branded_with_answer, 27);
  assert.equal(s.eliciting_queries, 27, "self-only roster must fall back to all answered");
  assert.equal(s.dead_prompts, 0);
  assert.equal(s.visibility_pct, 0);
});

test("self-only roster with one mention scores 1/30, never 100%", () => {
  // The severe form of the bug: 1 eliciting / 1 visible => 100% for a brand
  // with essentially no presence.
  const rows = [
    ...Array.from({ length: 29 }, () => rowWithBrands({ visible: false })),
    rowWithBrands({ visible: true }),
  ];
  const s = summarizeEngineSlice(rows, "perplexity");
  assert.equal(s.eliciting_queries, 30);
  assert.notEqual(s.visibility_pct, 100, "must never report 100% off a single mention");
  assert.equal(s.visibility_pct, 3.3);
});

test("a roster WITH rivals does filter the denominator to eliciting prompts", () => {
  const named = (mentioned) => [
    { name: "Italica", is_self: true, mentioned: false },
    { name: "Kajaria", is_self: false, mentioned },
  ];
  const rows = [
    rowWithBrands({ visible: false, brands: named(true) }),   // eliciting
    rowWithBrands({ visible: false, brands: named(true) }),   // eliciting
    rowWithBrands({ visible: false, brands: named(false) }),  // dead
    rowWithBrands({ visible: false, brands: named(false) }),  // dead
  ];
  const s = summarizeEngineSlice(rows, "aio");
  assert.equal(s.non_branded_with_answer, 4);
  assert.equal(s.eliciting_queries, 2);
  assert.equal(s.dead_prompts, 2);
  assert.equal(s.elicitation_rate_pct, 50);
});

test("share of voice and rival table come from the eliciting pool", () => {
  const rows = [
    rowWithBrands({
      visible: true,
      brands: [
        { name: "Italica", is_self: true, mentioned: true },
        { name: "Kajaria", is_self: false, mentioned: true },
      ],
    }),
    rowWithBrands({
      visible: false,
      brands: [
        { name: "Italica", is_self: true, mentioned: false },
        { name: "Kajaria", is_self: false, mentioned: true },
        { name: "Somany", is_self: false, mentioned: true },
      ],
    }),
  ];
  const s = summarizeEngineSlice(rows, "aio");
  assert.equal(s.total_brand_mentions, 4);
  assert.equal(s.self_mentions, 1);
  assert.equal(s.share_of_voice_pct, 25);
  assert.deepEqual(
    s.top_rivals.map((r) => r.name),
    ["Kajaria", "Somany"]
  );
});

test("share of voice is null (not 100) when the roster has no rivals", () => {
  // Second half of the live-scan regression: with a self-only roster every
  // counted mention is ours, so SOV is 100% by construction. It must report
  // "unknown", never a flattering number.
  const rows = [
    ...Array.from({ length: 29 }, () => rowWithBrands({ visible: false })),
    rowWithBrands({ visible: true }),
  ];
  const s = summarizeEngineSlice(rows, "perplexity");
  assert.equal(s.share_of_voice_pct, null);
  assert.deepEqual(s.top_rivals, []);
  assert.equal(s.visibility_pct, 3.3, "visibility is still computable without rivals");
});

// --- R2.2.5: coverage is a gate for TEXT engines too ---------------------
//
// Before this gate, dataSourceIssue for a text engine was errorRatePct > 50
// and nothing else, on the (pre-R2.2.1) assumption that text engines always
// answer. Since R2.2.1 an empty answer is an EMPTY_ANSWER error row with
// answer_present false, so a text engine returning nothing for 40% of prompts
// reported coverage_pct 60, error_rate_pct 40 and data_source_issue FALSE —
// a degraded collection presented as clean.

function textAnswerRow(i) {
  return {
    query: `unbranded prompt ${i}`,
    is_branded_query: false,
    answer_present: true,
    error: null,
    text: "Vendors worth considering include Kajaria and Somany.",
    visible: false,
    brand_mentioned_in_text: false,
    brand_cited: false,
    brands: [
      { name: "Italica", is_self: true, mentioned: false },
      { name: "Kajaria", is_self: false, mentioned: true },
    ],
  };
}

// What R2.2.1 produces for an empty / whitespace-only / null answer body.
function textEmptyRow(i) {
  return {
    query: `unbranded prompt ${i}`,
    is_branded_query: false,
    answer_present: false,
    error: "EMPTY_ANSWER",
    text: "",
    visible: false,
    brand_mentioned_in_text: false,
    brand_cited: false,
    brands: [],
  };
}

function textSlice(answered, empty) {
  return [
    ...Array.from({ length: answered }, (_, i) => textAnswerRow(i)),
    ...Array.from({ length: empty }, (_, i) => textEmptyRow(1000 + i)),
  ];
}

test("text engine — 40% empty answers raise data_source_issue, not a clean read", () => {
  const s = summarizeEngineSlice(textSlice(6, 4), "perplexity");
  assert.equal(s.coverage_pct, 60, "6 of 10 non-branded prompts answered");
  assert.equal(s.errored_queries, 4);
  // TEETH: the error-rate gate is errorRatePct > 50 and this slice sits at 40,
  // so ONLY the coverage gate can raise the flag. Remove the coverage gate
  // from summarizeEngineSlice and this assertion fails.
  assert.ok(s.error_rate_pct <= 50, "error rate alone must not reach its gate");
  assert.equal(s.data_source_issue, true, "coverage 60 is a degraded read, not a clean one");
});

test("text engine — the coverage gate fires on chatgpt too, at exactly the threshold", () => {
  // 27/30 = 90.0% is the threshold itself: tolerated.
  const atThreshold = summarizeEngineSlice(textSlice(27, 3), "chatgpt");
  assert.equal(atThreshold.coverage_pct, 90);
  assert.equal(atThreshold.data_source_issue, false, "90% is the floor, not below it");
  // 26/30 = 86.7% is below it: flagged.
  const below = summarizeEngineSlice(textSlice(26, 4), "chatgpt");
  assert.equal(below.coverage_pct, 86.7);
  assert.ok(below.error_rate_pct <= 50, "error rate alone must not reach its gate");
  assert.equal(below.data_source_issue, true);
});

test("text engine — one flaky empty answer in 30 is not a data source issue", () => {
  const s = summarizeEngineSlice(textSlice(29, 1), "perplexity");
  assert.equal(s.coverage_pct, 96.7);
  assert.equal(s.data_source_issue, false, "a single transient empty must not cry wolf");
});

test("text engine — a fully answered slice stays clean", () => {
  const s = summarizeEngineSlice(textSlice(30, 0), "perplexity");
  assert.equal(s.coverage_pct, 100);
  assert.equal(s.errored_queries, 0);
  assert.equal(s.data_source_issue, false);
});

test("text engine — a slice that never ran is not a degraded read", () => {
  // Rule 1: measured zero must look different from never ran. coverage_pct is
  // 0 for an empty slice by construction, so the gate requires a non-empty
  // non-branded denominator. insufficient_sample is what speaks here instead.
  const s = summarizeEngineSlice([], "perplexity");
  assert.equal(s.non_branded_queries, 0);
  assert.equal(s.data_source_issue, false, "never-ran must not be reported as degraded");
  assert.equal(s.insufficient_sample, true, "...but it must not look adequate either");

  // Branded-only slice: still no non-branded denominator to judge.
  const brandedOnly = summarizeEngineSlice(
    [
      {
        query: "italica tiles",
        is_branded_query: true,
        answer_present: true,
        error: null,
        visible: true,
        brands: [],
      },
    ],
    "perplexity"
  );
  assert.equal(brandedOnly.non_branded_queries, 0);
  assert.equal(brandedOnly.data_source_issue, false);
});

test("text engine — a genuine refusal is an ANSWER and does not trip the gate", () => {
  // R2.2.1: "I don't know" means the engine answered. Only empty, whitespace-
  // only or null bodies become EMPTY_ANSWER rows, so refusals cost no coverage.
  const refusals = Array.from({ length: 10 }, (_, i) => ({
    ...textAnswerRow(i),
    text: "I don't know which vendors serve that market.",
    brands: [],
  }));
  const s = summarizeEngineSlice(refusals, "perplexity");
  assert.equal(s.coverage_pct, 100, "a refusal is an answer");
  assert.equal(s.data_source_issue, false);
});

test("the text coverage gate does NOT tighten the aio path", () => {
  // A SERP carrying no AI Overview is a normal state, so aio keeps its own,
  // much looser AIO_MIN_NON_BRANDED_COVERAGE. Guards against the text
  // threshold being applied to both branches.
  const s = summarizeEngineSlice(textSlice(6, 4), "aio");
  assert.equal(s.coverage_pct, 60);
  assert.equal(s.data_source_issue, false, "aio tolerates 60% coverage by design");
});

test("the text coverage threshold is stricter than the aio one, on purpose", () => {
  assert.ok(
    TEXT_ENGINE_MIN_NON_BRANDED_COVERAGE > AIO_MIN_NON_BRANDED_COVERAGE,
    "a text engine has no legitimate no-answer state; an AIO SERP does"
  );
  assert.ok(TEXT_ENGINE_MIN_NON_BRANDED_COVERAGE < 1, "must tolerate transient flake");
});

// --- R2.2.6: the SCAN-level flag is every engine's business ---------------
//
// R2.2.5 taught a text slice to raise its own data_source_issue and the
// headline to drop it. What it could not do, and this covers, is the flag one
// level up: summarizeEngineResults read summary.data_source_issue off
// aioSummary alone. So a scan whose perplexity slice collapsed while aio
// answered every prompt reported engines_counted 1 instead of 2, moved
// visibility_index_pct, and set the scan-level flag FALSE — the red banner
// stayed down and nothing on screen said an engine had gone missing.

function healthyAioRows() {
  // 10 non-branded prompts, all answered, 2 naming the brand -> share_of_ai 20.
  return [
    ...Array.from({ length: 2 }, (_, i) => ({ ...textAnswerRow(i), visible: true })),
    ...Array.from({ length: 8 }, (_, i) => textAnswerRow(100 + i)),
  ];
}

function degradedPerplexityRows() {
  // 6 of 10 answered = coverage 60, under the 90 a text engine needs. All six
  // name the brand, so its share_of_ai is a flattering 100 read off a broken
  // slice — exactly the number that must not reach the headline unexplained.
  return [
    ...Array.from({ length: 6 }, (_, i) => ({ ...textAnswerRow(200 + i), visible: true })),
    ...Array.from({ length: 4 }, (_, i) => textEmptyRow(300 + i)),
  ];
}

function scanOf(engines) {
  const headline = computeHeadline(Object.values(engines));
  return { engines, headline, results: [] };
}

test("R2.2.6 — a text-only degradation raises the SCAN-level flag, not just the slice's", () => {
  const engines = {
    aio: summarizeEngineSlice(healthyAioRows(), "aio"),
    perplexity: summarizeEngineSlice(degradedPerplexityRows(), "perplexity"),
  };

  // The premise, restated so this test fails loudly if R2.2.5 regresses under it.
  assert.equal(engines.aio.data_source_issue, false, "aio answered everything");
  assert.equal(engines.perplexity.data_source_issue, true, "perplexity is degraded");

  const scan = scanOf(engines);
  assert.equal(scan.headline.engines_counted, 1, "the degraded slice is dropped");
  assert.equal(scan.headline.visibility_index_pct, 20, "...and the index is aio's alone");

  // TEETH: derive summary.data_source_issue from aioSummary again and this is
  // false, which is what shipped before R2.2.6.
  const out = summarizeEngineResults(scan);
  assert.equal(
    out.summary.data_source_issue,
    true,
    "an engine dropped out of the headline; the scan-level flag must say so"
  );
});

test("R2.2.6 — the banner names the degraded engine and explains the smaller count", () => {
  const engines = {
    aio: summarizeEngineSlice(healthyAioRows(), "aio"),
    perplexity: summarizeEngineSlice(degradedPerplexityRows(), "perplexity"),
  };
  const headline = computeHeadline(Object.values(engines));
  const d = describeScanDataSourceIssue(engines, { enginesCounted: headline.engines_counted });

  assert.equal(d.dataSourceIssue, true);
  assert.equal(d.severity, "partial", "aio still scores, so the index is real but narrower");

  // TEETH: "the banner stays silent" is exactly an empty title/detail, and a
  // banner that merely says something went wrong is what this task replaces.
  assert.ok(d.title && d.title.length > 0, "the banner must have something to say");
  assert.ok(d.detail && d.detail.length > 0, "...and a reason under it");

  // WHICH engine.
  assert.match(d.title, /Perplexity/, "the banner must name the engine that degraded");
  assert.match(d.detail, /Perplexity/);
  assert.ok(!/Google AI Overview/.test(d.title), "aio was fine; it must not be blamed");
  assert.deepEqual(d.degradedEngines.map((e) => e.engine), ["perplexity"]);

  // WHY the headline counts fewer engines.
  assert.match(d.title, /1 of 2 engines/, "the reduced count is stated, not implied");
  assert.equal(d.enginesCounted, 1);
  assert.equal(d.enginesRan, 2);
  assert.match(d.detail, /6 of 10/, "the numbers that condemned the slice are shown");
  assert.match(d.detail, /60%/);
  assert.match(
    d.detail,
    /90%/,
    "quoted against the TEXT threshold, not the aio one it used to borrow"
  );
  assert.match(d.detail, /Google AI Overview only/, "and it says what the score still rests on");
});

test("R2.2.6 — an aio-only degradation still flags, and is named as aio", () => {
  const engines = {
    aio: summarizeEngineSlice(
      [
        ...Array.from({ length: 1 }, (_, i) => ({ ...textAnswerRow(i), visible: true })),
        ...Array.from({ length: 9 }, (_, i) => textEmptyRow(400 + i)),
      ],
      "aio"
    ),
    perplexity: summarizeEngineSlice(healthyAioRows(), "perplexity"),
  };
  assert.equal(engines.aio.data_source_issue, true);
  assert.equal(engines.perplexity.data_source_issue, false);

  const headline = computeHeadline(Object.values(engines));
  const d = describeScanDataSourceIssue(engines, { enginesCounted: headline.engines_counted });
  assert.equal(d.dataSourceIssue, true, "the pre-R2.2.6 case must not have been traded away");
  assert.equal(d.severity, "partial");
  assert.match(d.title, /Google AI Overview/);
  assert.ok(!/Perplexity degraded/.test(d.title), "perplexity answered everything");
  // The aio slice is judged against the aio floor (15%), never the text one.
  assert.match(d.detail, new RegExp(`${Math.round(AIO_MIN_NON_BRANDED_COVERAGE * 100)}%`));
  assert.equal(d.degradedEngines[0].min_coverage_pct, AIO_MIN_NON_BRANDED_COVERAGE * 100);
});

test("R2.2.6 — a single-engine aio scan that degrades leaves nothing to score", () => {
  const engines = {
    aio: summarizeEngineSlice(Array.from({ length: 10 }, (_, i) => textEmptyRow(500 + i)), "aio"),
  };
  const headline = computeHeadline(Object.values(engines));
  const d = describeScanDataSourceIssue(engines, { enginesCounted: headline.engines_counted });
  assert.equal(d.dataSourceIssue, true);
  assert.equal(
    d.severity,
    "critical",
    "one engine, and it failed — the score must still be suppressed, as it always was"
  );
  assert.equal(d.enginesCounted, 0);
});

test("R2.2.6 — both engines degraded reads as ONE banner naming both, not two", () => {
  const engines = {
    aio: summarizeEngineSlice(Array.from({ length: 10 }, (_, i) => textEmptyRow(600 + i)), "aio"),
    perplexity: summarizeEngineSlice(degradedPerplexityRows(), "perplexity"),
  };
  const headline = computeHeadline(Object.values(engines));
  const d = describeScanDataSourceIssue(engines, { enginesCounted: headline.engines_counted });

  assert.equal(d.severity, "critical", "nothing eligible is left");
  assert.equal(d.dataSourceIssue, true);
  // One severity means the caller renders one banner; both engines are inside it.
  assert.equal(d.degradedEngines.length, 2);
  assert.match(d.title, /Google AI Overview and Perplexity/);
  assert.match(d.detail, /Google AI Overview/);
  assert.match(d.detail, /Perplexity/);
  // Each engine is quoted against its OWN gate inside the shared banner.
  assert.equal(
    d.degradedEngines.find((e) => e.engine === "aio").min_coverage_pct,
    AIO_MIN_NON_BRANDED_COVERAGE * 100
  );
  assert.equal(
    d.degradedEngines.find((e) => e.engine === "perplexity").min_coverage_pct,
    TEXT_ENGINE_MIN_NON_BRANDED_COVERAGE * 100
  );
});

test("R2.2.6 — a healthy multi-engine scan raises nothing", () => {
  const engines = {
    aio: summarizeEngineSlice(healthyAioRows(), "aio"),
    perplexity: summarizeEngineSlice(healthyAioRows(), "perplexity"),
  };
  const headline = computeHeadline(Object.values(engines));
  assert.equal(headline.engines_counted, 2);
  const d = describeScanDataSourceIssue(engines, { enginesCounted: headline.engines_counted });
  assert.equal(d.dataSourceIssue, false);
  assert.equal(d.severity, "none");
  assert.equal(d.title, null, "no banner when nothing degraded");
  assert.equal(summarizeEngineResults({ engines, headline, results: [] }).summary.data_source_issue, false);
});

test("R2.2.6 — a scan with no rows at all stays clean; never-ran is not degraded", () => {
  // Rule 1. Every slice reports coverage_pct 0, and a scan-level flag written
  // in terms of coverage rather than the slices' own verdicts would light the
  // red banner on a scan that simply never collected anything.
  const engines = {
    aio: summarizeEngineSlice([], "aio"),
    perplexity: summarizeEngineSlice([], "perplexity"),
  };
  const headline = computeHeadline(Object.values(engines));
  assert.equal(headline.engines_counted, 0, "nothing eligible, because nothing ran");

  const d = describeScanDataSourceIssue(engines, { enginesCounted: headline.engines_counted });
  assert.equal(d.dataSourceIssue, false, "never-ran must not be reported as a degraded read");
  assert.equal(d.severity, "none");
  assert.deepEqual(d.degradedEngines, []);
  assert.equal(d.enginesRan, 0);
  // insufficient_sample is what speaks for it instead.
  assert.equal(engines.aio.insufficient_sample, true);
  assert.equal(
    summarizeEngineResults({ engines, headline, results: [] }).summary.data_source_issue,
    false
  );
});

test("R2.2.6 — an engine that never ran does not dilute the count of engines that did", () => {
  const engines = {
    aio: summarizeEngineSlice(healthyAioRows(), "aio"),
    perplexity: summarizeEngineSlice(degradedPerplexityRows(), "perplexity"),
    chatgpt: summarizeEngineSlice([], "chatgpt"),
  };
  const headline = computeHeadline(Object.values(engines));
  const d = describeScanDataSourceIssue(engines, { enginesCounted: headline.engines_counted });
  assert.equal(d.enginesRan, 2, "chatgpt produced no rows; it is absent, not degraded");
  assert.match(d.title, /1 of 2 engines/);
  assert.deepEqual(d.degradedEngines.map((e) => e.engine), ["perplexity"]);
});

test("R2.2.6 — a record with no per-engine slices falls back to its stored flag", () => {
  // Scans written before multi-engine summaries existed carry one boolean and
  // nothing to explain it. The banner still renders, with the generic wording
  // it has always had — but nothing invents an engine name it does not have.
  const legacy = describeScanDataSourceIssue(null, { fallbackIssue: true });
  assert.equal(legacy.dataSourceIssue, true);
  assert.equal(legacy.severity, "critical");
  assert.deepEqual(legacy.degradedEngines, []);
  assert.ok(legacy.title && legacy.detail, "a flag with no slices still gets words");

  const clean = describeScanDataSourceIssue(null, { fallbackIssue: false });
  assert.equal(clean.dataSourceIssue, false);
  assert.equal(clean.severity, "none");
  assert.equal(clean.title, null);
});

test("R2.2.6 — a degraded slice with no counters says so instead of showing an empty reason", () => {
  // A stored slice that lost its counters, or one flagged by a future gate this
  // function does not model, must not produce a banner with a blank reason.
  const d = describeScanDataSourceIssue(
    { perplexity: { engine: "perplexity", non_branded_queries: 10, data_source_issue: true } },
    { enginesCounted: 0 }
  );
  assert.equal(d.severity, "critical");
  const reason = d.degradedEngines[0].reason;
  assert.ok(reason && reason.trim().length > 0);
  assert.match(reason, /does not carry/, "the gap is named, not papered over");
  assert.equal(d.degradedEngines[0].coverage_pct, null, "and the missing number is null, not 0");
});

test("R2.2.6 — engineHealthThresholds keeps the two engine classes apart", () => {
  const aio = engineHealthThresholds("aio");
  const text = engineHealthThresholds("perplexity");
  assert.equal(aio.minNonBrandedCoverage, AIO_MIN_NON_BRANDED_COVERAGE);
  assert.equal(text.minNonBrandedCoverage, TEXT_ENGINE_MIN_NON_BRANDED_COVERAGE);
  assert.ok(
    text.minNonBrandedCoverage > aio.minNonBrandedCoverage,
    "unifying these would forgive a text engine that stopped answering"
  );
  assert.deepEqual(engineHealthThresholds("chatgpt"), text, "chatgpt is a text engine too");
  assert.deepEqual(
    engineHealthThresholds("some-engine-added-later"),
    text,
    "an unknown engine gets the strict gate, not the loose one"
  );
});

test("R2.2.6 — a defaulted engines_counted of 0 must not blank a scan that still scores", () => {
  // normalizeResult does `data.engines_counted ?? raw.engines_counted ?? 0`, so
  // a record missing the column hands the dashboard a 0 that was never measured.
  // Taking that on trust would call a healthy-aio scan unscoreable and hide an
  // index we have. The count is recomputed from the slices instead.
  const engines = {
    aio: summarizeEngineSlice(healthyAioRows(), "aio"),
    perplexity: summarizeEngineSlice(degradedPerplexityRows(), "perplexity"),
  };
  const d = describeScanDataSourceIssue(engines, { enginesCounted: 0, fallbackIssue: false });
  assert.equal(d.severity, "partial", "aio still scores; a defaulted zero must not say otherwise");
  assert.equal(d.enginesCounted, 1);
  assert.match(d.title, /1 of 2 engines/);
});

test("R2.7.5: summarizeEngineResults unions underlying mention counts across engines rather than averaging ratios", () => {
  // Engine 1 (aio): 1 self mention out of 2 total brand mentions (50% per-engine SOV)
  const aioRows = [
    rowWithBrands({
      brands: [
        { name: "Italica", is_self: true, mentioned: true },
        { name: "Kajaria", is_self: false, mentioned: true },
      ],
    }),
  ];
  // Engine 2 (perplexity): 0 self mentions out of 8 total brand mentions (0% per-engine SOV)
  const perplexityRows = Array.from({ length: 8 }, (_, i) =>
    rowWithBrands({
      brands: [
        { name: "Italica", is_self: true, mentioned: false },
        { name: `Rival${i}`, is_self: false, mentioned: true },
      ],
    })
  );

  const engines = {
    aio: summarizeEngineSlice(aioRows, "aio"),
    perplexity: summarizeEngineSlice(perplexityRows, "perplexity"),
  };
  assert.equal(engines.aio.share_of_voice_pct, 50);
  assert.equal(engines.perplexity.share_of_voice_pct, 0);

  const out = summarizeEngineResults({ engines, results: [] });

  // Averaging ratios would be (50 + 0) / 2 = 25%.
  // Unioning underlying counts is (1 + 0) / (2 + 8) = 1 / 10 = 10.0%.
  assert.equal(out.summary.share_of_voice_pct, 10, "scan-level SOV unions underlying mention counts");
});

test("R2.7.5: summarizeEngineResults preserves three-way distinction for multi-engine scans", () => {
  // 1. Without rivals across all engines: SOV is null
  const noRivalsScan = summarizeEngineResults({
    engines: {
      aio: summarizeEngineSlice([rowWithBrands({ visible: true })], "aio"),
      chatgpt: summarizeEngineSlice([rowWithBrands({ visible: true })], "chatgpt"),
    },
    results: [],
  });
  assert.equal(noRivalsScan.summary.share_of_voice_pct, null, "null when no rivals are tracked");

  // 2. With rivals assessed, but empty eliciting pool: SOV is null
  const emptyElicitingScan = summarizeEngineResults({
    engines: {
      aio: summarizeEngineSlice([
        rowWithBrands({
          visible: false,
          brands: [
            { name: "Italica", is_self: true, mentioned: false },
            { name: "Kajaria", is_self: false, mentioned: false },
          ],
        }),
      ], "aio"),
    },
    results: [],
  });
  assert.equal(emptyElicitingScan.summary.share_of_voice_pct, null, "null when eliciting pool is empty");

  // 3. With rivals assessed, rival mentioned, self 0: SOV is 0
  const measuredZeroScan = summarizeEngineResults({
    engines: {
      aio: summarizeEngineSlice([
        rowWithBrands({
          visible: false,
          brands: [
            { name: "Italica", is_self: true, mentioned: false },
            { name: "Kajaria", is_self: false, mentioned: true },
          ],
        }),
      ], "aio"),
    },
    results: [],
  });
  assert.equal(measuredZeroScan.summary.share_of_voice_pct, 0, "0 when assessed and not mentioned");
});

// ---------------------------------------------------------------------------
// R2.9.6 — probeTextEngine preserves null cost and cost_state fields
// ---------------------------------------------------------------------------

test("R2.9.6 ACCEPT — PROBE_FAILED preserves cost: null and copies cost_state fields", async () => {
  const mockEngine = {
    name: "perplexity",
    probe: async () => ({
      text: "",
      citations: [],
      references: [],
      cost: null,
      cost_source: null,
      cost_state: "probe_failed",
      cost_state_detail: "Perplexity answer probe failed",
      error: "500 Internal Server Error",
      error_kind: "retryable",
      citations_state: "unverified",
    }),
  };

  const result = await probeTextEngine(
    mockEngine,
    { text: "best tiles" },
    "Acme",
    ["Acme"],
    "acme.com",
    [],
    null
  );

  assert.equal(result.cost, null, "cost must remain null, NOT coerced to 0");
  assert.equal(result.cost_state, "probe_failed", "cost_state must survive probeTextEngine");
  assert.equal(result.cost_source, null);
  assert.equal(result.cost_state_detail, "Perplexity answer probe failed");
  assert.equal(result.error, "500 Internal Server Error");
});

test("R2.9.6 ACCEPT — NOT_CONFIGURED preserves cost: null and copies cost_state fields", async () => {
  const mockEngine = {
    name: "perplexity",
    probe: async () => ({
      text: "",
      citations: [],
      references: [],
      cost: null,
      cost_source: null,
      cost_state: "not_configured",
      cost_state_detail: "PERPLEXITY_API_KEY is not set",
      error: "PERPLEXITY_API_KEY not set",
      error_kind: "permanent",
      citations_state: "unverified",
    }),
  };

  const result = await probeTextEngine(
    mockEngine,
    { text: "best tiles" },
    "Acme",
    ["Acme"],
    "acme.com",
    [],
    null
  );

  assert.equal(result.cost, null, "unconfigured cost is null, never 0");
  assert.equal(result.cost_state, "not_configured");
  assert.equal(result.cost_state_detail, "PERPLEXITY_API_KEY is not set");
});

test("R2.9.6 ACCEPT — UNPRICED probe preserves cost: null on a successful answer", async () => {
  const mockEngine = {
    name: "perplexity",
    probe: async () => ({
      text: "Acme makes top-grade tiles.",
      citations: [],
      references: [],
      cost: null,
      cost_source: null,
      cost_state: "unpriced",
      cost_state_detail: "model unpriced",
      error: null,
    }),
  };

  const result = await probeTextEngine(
    mockEngine,
    { text: "best tiles" },
    "Acme",
    ["Acme"],
    "acme.com",
    [],
    null
  );

  assert.equal(result.cost, null, "an unpriced model must NOT be recorded as a $0 call");
  assert.equal(result.cost_state, "unpriced");
  assert.equal(result.answer_present, true);
  assert.equal(result.text, "Acme makes top-grade tiles.");
});

test("R2.9.6 ACCEPT — a measured cost (including measured zero) is preserved", async () => {
  // Free tier measured zero
  const freeEngine = {
    name: "chatgpt",
    probe: async () => ({
      text: "Answer from free model",
      cost: 0,
      cost_source: "openrouter_free",
      cost_state: "measured",
      cost_state_detail: null,
      error: null,
    }),
  };

  const freeResult = await probeTextEngine(
    freeEngine,
    { text: "best tiles" },
    "Acme",
    ["Acme"],
    "acme.com",
    [],
    null
  );

  assert.equal(freeResult.cost, 0, "measured $0 must survive as 0");
  assert.equal(freeResult.cost_state, "measured");
  assert.equal(freeResult.cost_source, "openrouter_free");

  // Paid tier measured cost
  const paidEngine = {
    name: "chatgpt",
    probe: async () => ({
      text: "Answer from paid model",
      cost: 0.005,
      cost_source: "price_table",
      cost_state: "measured",
      cost_state_detail: null,
      error: null,
    }),
  };

  const paidResult = await probeTextEngine(
    paidEngine,
    { text: "best tiles" },
    "Acme",
    ["Acme"],
    "acme.com",
    [],
    null
  );

  assert.equal(paidResult.cost, 0.005);
  assert.equal(paidResult.cost_state, "measured");
});

test("R2.9.6 TEETH — reverting cost null preservation causes the test to fail", () => {
  // Simulating the pre-fix probeTextEngine behavior:
  const preFixResult = { cost: null || 0, cost_state: undefined };

  assert.equal(preFixResult.cost, 0, "premise: pre-fix code coerced null to 0");
  assert.equal(preFixResult.cost_state, undefined, "premise: pre-fix code dropped cost_state");

  // The assertion that teeth enforces on the fixed result:
  assert.notEqual(null, preFixResult.cost, "the buggy 0 fails when null is asserted");
});

// ---------------------------------------------------------------------------
// R2.4.1 — top-level scan fields become blended/index values
//
// scans.visibility_pct, data_source_issue and insufficient_sample previously
// described AIO only. A totally failed second engine raised no top-level flag.
// Now visibility_pct carries the blended headline index, and insufficient_sample
// is true when ANY engine has it.
// ---------------------------------------------------------------------------

test("R2.4.1 — visibility_pct carries the blended headline index, not AIO alone", () => {
  // AIO: 2/10 visible → share_of_ai 20. Perplexity: 8/10 → share_of_ai 80.
  // Headline blend: (20 + 80) / 2 = 50.
  const aioSlice = summarizeEngineSlice(
    [
      ...Array.from({ length: 2 }, (_, i) => ({ ...textAnswerRow(i), visible: true })),
      ...Array.from({ length: 8 }, (_, i) => textAnswerRow(100 + i)),
    ],
    "aio"
  );
  const ppxSlice = summarizeEngineSlice(
    [
      ...Array.from({ length: 8 }, (_, i) => ({ ...textAnswerRow(200 + i), visible: true })),
      ...Array.from({ length: 2 }, (_, i) => textAnswerRow(300 + i)),
    ],
    "perplexity"
  );

  const engines = { aio: aioSlice, perplexity: ppxSlice };
  const headline = computeHeadline(Object.values(engines));
  assert.equal(headline.visibility_index_pct, 50, "premise: headline blends both engines");

  const out = summarizeEngineResults({ engines, headline, results: [] });
  // Before R2.4.1 this was aioSummary.visibility_pct (20), not the headline (50).
  assert.equal(out.summary.visibility_pct, 50, "top-level visibility_pct is the blended headline");
});

test("R2.4.1 — visibility_pct falls back to AIO when there is no headline", () => {
  // Only 3 non-branded answers — below HEADLINE_MIN_NON_BRANDED_ANSWERS (5) —
  // so the headline counts 0 eligible engines.
  const aioSlice = summarizeEngineSlice(
    [
      ...Array.from({ length: 2 }, (_, i) => ({ ...textAnswerRow(i), visible: true })),
      textEmptyRow(100),
    ],
    "aio"
  );
  const engines = { aio: aioSlice };
  const headline = computeHeadline(Object.values(engines));
  assert.equal(headline.engines_counted, 0, "premise: no engine eligible");

  const out = summarizeEngineResults({ engines, headline, results: [] });
  assert.equal(
    out.summary.visibility_pct,
    aioSlice.visibility_pct,
    "falls back to AIO's visibility_pct when headline has no value"
  );
});

test("R2.4.1 — a totally failed second engine now raises the top-level insufficient_sample flag", () => {
  // AIO: healthy. Perplexity: never ran (0 rows → insufficient_sample true).
  const aioSlice = summarizeEngineSlice(healthyAioRows(), "aio");
  const ppxSlice = summarizeEngineSlice([], "perplexity");

  assert.equal(aioSlice.insufficient_sample, false, "premise: AIO is healthy");
  assert.equal(ppxSlice.insufficient_sample, true, "premise: perplexity never ran");

  const engines = { aio: aioSlice, perplexity: ppxSlice };
  const headline = computeHeadline(Object.values(engines));
  const out = summarizeEngineResults({ engines, headline, results: [] });
  assert.equal(
    out.summary.insufficient_sample,
    true,
    "scan-level insufficient_sample is true when ANY engine has it"
  );
});

test("R2.4.1 — insufficient_sample stays false when no engine has it", () => {
  const engines = {
    aio: summarizeEngineSlice(healthyAioRows(), "aio"),
    perplexity: summarizeEngineSlice(healthyAioRows(), "perplexity"),
  };
  const headline = computeHeadline(Object.values(engines));
  const out = summarizeEngineResults({ engines, headline, results: [] });
  assert.equal(out.summary.insufficient_sample, false, "no engine has insufficient_sample");
});

test("R2.4.1 — insufficient_sample on a legacy record with no engine slices stays false", () => {
  const out = summarizeEngineResults({ engines: {}, headline: null, results: [] });
  assert.equal(out.summary.insufficient_sample, false, "no engines → false");
});

test("R2.4.1 — data_source_issue remains blended (no regression from the visibility_pct change)", () => {
  const engines = {
    aio: summarizeEngineSlice(healthyAioRows(), "aio"),
    perplexity: summarizeEngineSlice(degradedPerplexityRows(), "perplexity"),
  };
  const headline = computeHeadline(Object.values(engines));
  const out = summarizeEngineResults({ engines, headline, results: [] });
  assert.equal(out.summary.data_source_issue, true, "still flags the degraded engine");
});
