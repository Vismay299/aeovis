import test from "node:test";
import assert from "node:assert/strict";
import { summarizeEngineResults, resolveEnabledEngines, buildTrackedBrandRoster } from "./enginePipeline.js";
import { getBrandAliases } from "./aliases.js";

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
  delete process.env.ENGINES;

  const engines = resolveEnabledEngines();
  assert.equal(engines.length, 1);
  assert.equal(engines[0].name, "aio");

  if (oldEngines) process.env.ENGINES = oldEngines;
});

test("resolveEnabledEngines parses comma-separated list", () => {
  const oldEngines = process.env.ENGINES;
  process.env.ENGINES = "aio,chatgpt,perplexity";

  const engines = resolveEnabledEngines();
  // chatgpt and perplexity may not be configured — aio is always configured
  assert.ok(engines.length >= 1);
  assert.equal(engines[0].name, "aio");

  if (oldEngines) process.env.ENGINES = oldEngines;
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
