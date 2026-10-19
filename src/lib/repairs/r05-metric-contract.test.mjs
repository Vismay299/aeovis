import test from "node:test";
import assert from "node:assert/strict";

import { summarizeEngineSlice, computeHeadline, compareHeadlines } from "../scoring/enginePipeline.js";
import {
  createMetric,
  reduceObservations,
  estimateUncertainty,
  validateMetric,
  reconcileDisplayedMetric,
  compareMetrics,
  measurementContext,
  COMPARISON_BOUNDARIES,
  METRIC_IDS,
  METRIC_REASONS,
  METRIC_STATES,
} from "../scoring/metricContract.js";

const self = (mentioned = false, relationship = null) => ({
  name: "Example", is_self: true, mentioned, relationship,
});
const rival = (mentioned = false) => ({ name: "Rival", is_self: false, mentioned });
const rows = (count, mentions = 0) => Array.from({ length: count }, (_, i) => ({
  engine: "chatgpt",
  query: `prompt-${i}`,
  prompt_id: `prompt-${i}`,
  answer_present: true,
  is_branded_query: false,
  text: i < mentions ? "Example appears." : "A generic answer.",
  visible: i < mentions,
  brand_mentioned_in_text: i < mentions,
  brand_cited: false,
  brands: [self(i < mentions)],
}));
const metric = (input, id) => summarizeEngineSlice(input, "chatgpt").metrics[id];
const mention = (input) => metric(input, METRIC_IDS.MENTION);
const citation = (input) => metric(input, METRIC_IDS.CITATION);
const exposure = (input) => metric(input, METRIC_IDS.EXPOSURE);
const promptIds = (n) => Array.from({ length: n }, (_, i) => `prompt-${i}`);
const gate = (n, valid = 30, planned = 30, numerator = 0, denominator = n) => createMetric({
  metricId: METRIC_IDS.EXPOSURE,
  numerator,
  denominator,
  eligiblePromptIds: promptIds(n),
  collection: { valid, planned },
});

test("R05-01 — six self mentions among thirty valid answers are 6/30, not 6/6", () => {
  const m = mention(rows(30, 6));
  assert.equal(m.numerator, 6);
  assert.equal(m.denominator, 30);
  assert.equal(m.value_pct, 20);
});

test("R05-02 — adding an unmentioned tracked rival cannot move self metrics", () => {
  const baseline = rows(30, 6);
  const changed = baseline.map((r) => ({ ...r, brands: [...r.brands, rival(false)] }));
  for (const id of [METRIC_IDS.MENTION, METRIC_IDS.CITATION, METRIC_IDS.EXPOSURE]) {
    const before = metric(baseline, id);
    const after = metric(changed, id);
    assert.deepEqual([after.numerator, after.denominator, after.value_pct],
      [before.numerator, before.denominator, before.value_pct]);
  }
});

test("R05-03 — removing a tracked rival cannot raise the self rate", () => {
  const withRival = rows(30, 6).map((r) => ({ ...r, brands: [...r.brands, rival(false)] }));
  assert.equal(mention(withRival).value_pct, mention(withRival.map((r) => ({
    ...r, brands: r.brands.filter((b) => b.is_self),
  }))).value_pct);
});

test("R05-04 — a citation-only appearance counts exposure and citation, not text mention", () => {
  const input = rows(30);
  input[0] = { ...input[0], brand_cited: true, visible: true, text: "A generic answer." };
  assert.equal(mention(input).numerator, 0);
  assert.equal(citation(input).numerator, 1);
  assert.equal(exposure(input).numerator, 1);
});

test("R05-05 — a raw 1/1 recommendation remains exploratory", () => {
  const input = rows(30);
  input[0] = { ...input[0], brands: [self(true, "recommended")] };
  for (let i = 1; i < input.length; i++) input[i] = { ...input[i], brands: [] };
  const m = metric(input, METRIC_IDS.RECOMMENDATION);
  assert.equal(m.value_pct, 100);
  assert.equal(m.qualified_pct, null);
  assert.equal(m.qualified_reason, METRIC_REASONS.INSUFFICIENT_DISTINCT_PROMPTS);
});

test("R05-06 — the distinct prompt gate changes at exactly 20", () => {
  assert.equal(gate(19).qualified, false);
  assert.equal(gate(20).qualified, true);
});

test("R05-07 — thirty replicates of one prompt cannot unlock qualification", () => {
  const reduced = reduceObservations(Array.from({ length: 30 }, (_, i) => ({
    key: `p1-${i}`, promptId: "p1", replicate: i + 1, value: true,
  })));
  assert.equal(reduced.denominator, 30);
  assert.deepEqual(reduced.eligiblePromptIds, ["p1"]);
  assert.equal(createMetric({ metricId: METRIC_IDS.MENTION,
    ...reduced, collection: { valid: 30, planned: 30 },
  }).qualified, false);
});

test("R05-08 — 29/30 passes the 95% collection gate and 28/30 fails", () => {
  assert.equal(gate(20, 29, 30).qualified, true);
  const low = gate(20, 28, 30);
  assert.equal(low.qualified, false);
  assert.equal(low.qualified_reason, METRIC_REASONS.INSUFFICIENT_COLLECTION);
});

test("R05-09 — an empty denominator is unknown, never measured zero", () => {
  const m = gate(0, 0, 0, 0, 0);
  assert.equal(m.value_pct, null);
  assert.equal(m.state, METRIC_STATES.NOT_ASSESSED);
  assert.equal(m.reason, METRIC_REASONS.NO_ELIGIBLE_OBSERVATIONS);
});

test("R05-10 — zero of twenty eligible answers is a qualified measured zero", () => {
  const m = gate(20);
  assert.equal(m.numerator, 0);
  assert.equal(m.denominator, 20);
  assert.equal(m.value_pct, 0);
  assert.equal(m.qualified_pct, 0);
});

test("R05-11 — brand-free answers stay in the fixed mention panel", () => {
  const m = mention(rows(30));
  assert.equal(m.numerator, 0);
  assert.equal(m.denominator, 30);
  assert.equal(m.qualified_pct, 0);
});

test("R05-12 — absent citation telemetry is unknown, not verified uncited", () => {
  const m = citation(rows(30).map((r) => ({ ...r, citations_state: "unverified" })));
  assert.equal(m.numerator, 0);
  assert.equal(m.denominator, 0);
  assert.equal(m.value_pct, null);
  assert.equal(m.reason, METRIC_REASONS.CITATION_TELEMETRY_ABSENT);
});

test("R05-13 — a negative mention does not become a positive recommendation", () => {
  const input = rows(30);
  input[0] = { ...input[0], text: "Example is poor.", brand_mentioned_in_text: true,
    brands: [self(true, "negative")] };
  assert.equal(mention(input).numerator, 1);
  assert.equal(metric(input, METRIC_IDS.RECOMMENDATION).numerator, 0);
});

test("R05-14 — duplicate delivery changes attempt history, never metric denominator", () => {
  const base = rows(30, 6);
  const m = mention([...base, { ...base[0] }]);
  assert.equal(m.numerator, 6);
  assert.equal(m.denominator, 30);
  assert.equal(m.duplicate_observations, 1);
});

test("R05-15 — seeded count sweep respects percentage bounds and DTO validation", () => {
  for (let denominator = 0; denominator <= 40; denominator++) {
    for (let numerator = 0; numerator <= denominator; numerator++) {
      const m = gate(denominator, 40, 40, numerator, denominator);
      assert.deepEqual(validateMetric(m).contradictions, []);
      if (denominator === 0) assert.equal(m.value_pct, null);
      else assert.ok(m.value_pct >= 0 && m.value_pct <= 100);
    }
  }
});

test("R05-16 — uncertainty resamples prompt clusters with a recorded seed", () => {
  const input = [
    { promptId: "a", replicate: 1, value: true },
    ...Array.from({ length: 29 }, (_, i) => ({ promptId: "a", replicate: i + 2, value: true })),
    { promptId: "b", replicate: 1, value: false },
  ];
  const one = estimateUncertainty(input, { seed: 17, resamples: 200 });
  const two = estimateUncertainty(input, { seed: 17, resamples: 200 });
  assert.deepEqual(one, two);
  assert.equal(one.effective_sample, 2);
  assert.equal(one.observations, 31);
  assert.equal(one.replicate_observations, 29);
  assert.equal(one.cluster_rate_pct, 50);
});

test("R05-17 — a failed frozen engine is explicit and changes the comparison cohort", () => {
  const context = { panelVersion: "panel-a", surfaceVersion: "api-v1", market: "in", modelPolicyVersion: "models-a" };
  const healthy = summarizeEngineSlice(rows(30, 6), "chatgpt", context);
  const otherRows = rows(30, 6).map((r) => ({ ...r, engine: "perplexity" }));
  const other = summarizeEngineSlice(otherRows, "perplexity", context);
  const failed = summarizeEngineSlice(otherRows.map((r) => ({ ...r,
    answer_present: false, text: "", visible: false, error: "provider unavailable",
  })), "perplexity", context);
  const before = computeHeadline([healthy, other], undefined, context);
  const after = computeHeadline([healthy, failed], undefined, context);
  assert.equal(after.engines_counted, 1);
  assert.deepEqual(after.excluded_engines.map((e) => e.engine), ["perplexity"]);
  assert.equal(after.reweighted, true);
  const comparison = compareHeadlines(after, before);
  assert.equal(comparison.comparable, false);
  assert.equal(comparison.boundary_reason, COMPARISON_BOUNDARIES.ENGINE_COHORT);
});

test("R05-18 — panel, market and surface changes each suppress a delta", () => {
  const base = measurementContext({ panelVersion: "a", surfaceVersion: "api", market: "in",
    modelPolicyVersion: "model-a", engineCohort: ["chatgpt"] });
  const first = createMetric({ metricId: METRIC_IDS.EXPOSURE, numerator: 6, denominator: 30,
    eligiblePromptIds: promptIds(30), collection: { valid: 30, planned: 30 }, context: base });
  for (const [field, value, reason] of [
    ["panel_version", "b", COMPARISON_BOUNDARIES.PANEL],
    ["market", "us", COMPARISON_BOUNDARIES.MARKET],
    ["surface_version", "browser", COMPARISON_BOUNDARIES.SURFACE],
  ]) {
    const second = { ...first, context: { ...base, [field]: value } };
    const result = compareMetrics(second, first);
    assert.equal(result.comparable, false);
    assert.equal(result.boundary_reason, reason);
    assert.equal(result.delta_pct, null);
  }
});

test("R05-21 — a contradictory stored percentage is flagged before display", () => {
  const stored = { ...gate(30, 30, 30, 6, 30), value_pct: 100 };
  const validation = validateMetric(stored);
  assert.equal(validation.valid, false);
  assert.ok(validation.contradictions.some((c) => c.code === "value_disagrees_with_counts"));
  const display = reconcileDisplayedMetric(stored);
  assert.notEqual(display.value_pct, 100);
});
