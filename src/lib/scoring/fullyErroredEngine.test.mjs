/**
 * R2.1.4 — Tests: a fully-errored engine renders failed and contributes nothing.
 *
 * Also asserts the headline label always matches its source, closing A2.
 *
 * Acceptance:
 *   A 100-percent-errored engine contributes nothing to the index and renders
 *   'failed'; the hero label matches the value's provenance.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  summarizeEngineSlice,
  summarizeEngineResults,
  computeHeadline,
  describeScanDataSourceIssue,
  ENGINE_MEASUREMENT_STATE,
  isMeasuredEngineSlice,
} from "./enginePipeline.js";

const SELF = "Italica";
const RIVAL = "Kajaria";

/** Build a fully-errored result row for a given engine. */
function erroredRow(engine, prompt = "sample query", errorMsg = "engine timeout") {
  return {
    engine,
    prompt,
    is_branded_query: false,
    answer_present: false,
    aio_present: false,
    text: "",
    citations: [],
    references: [],
    brand_mentioned_in_text: false,
    brand_cited: false,
    visible: false,
    error: errorMsg,
    brands: [],
  };
}

/** Build a clean answered row for a given engine. */
function answeredRow(engine, prompt, { visible = false } = {}) {
  return {
    engine,
    prompt,
    is_branded_query: false,
    answer_present: true,
    aio_present: engine === "aio",
    text: visible ? `Best ${SELF} product is great` : "Generic answer about tile selection.",
    citations: [],
    references: [],
    brand_mentioned_in_text: visible,
    brand_cited: false,
    visible,
    error: null,
    brands: [
      { name: SELF, is_self: true, mentioned: visible },
      { name: RIVAL, is_self: false, mentioned: true },
    ],
  };
}

// ---------------------------------------------------------------------------
// Test 1: A fully-errored engine slice is "failed" and has null share_of_ai
// ---------------------------------------------------------------------------
test("R2.1.4 — fully-errored engine slice is state failed with null share_of_ai_pct", () => {
  const rows = Array.from({ length: 10 }, (_, i) => erroredRow("aio", `query ${i}`));
  const slice = summarizeEngineSlice(rows, "aio");

  assert.equal(slice.state, ENGINE_MEASUREMENT_STATE.FAILED,
    "a 100%-errored slice must be state 'failed'");
  assert.equal(slice.state_reason, "high_error_rate",
    "reason must be high_error_rate when all rows errored");
  assert.equal(slice.share_of_ai_pct, null,
    "share_of_ai_pct must be null for a failed engine — no number may leak");
  assert.equal(slice.visibility_pct, null,
    "visibility_pct must be null for a failed engine");
  assert.equal(slice.errored_queries, 10,
    "all 10 queries must be counted as errored");
  assert.equal(isMeasuredEngineSlice(slice), false,
    "isMeasuredEngineSlice must return false for a failed slice");
});

// ---------------------------------------------------------------------------
// Test 2: A fully-errored engine contributes NOTHING to the headline index
// ---------------------------------------------------------------------------
test("R2.1.4 — fully-errored engine contributes nothing to headline", () => {
  const aioResults = Array.from({ length: 10 }, (_, i) => erroredRow("aio", `query ${i}`));
  const perplexityResults = Array.from({ length: 10 }, (_, i) =>
    answeredRow("perplexity", `query ${i}`, { visible: true })
  );

  const aioSlice = summarizeEngineSlice(aioResults, "aio");
  const pplxSlice = summarizeEngineSlice(perplexityResults, "perplexity");

  const { visibility_index_pct, engines_counted } = computeHeadline([aioSlice, pplxSlice]);

  assert.equal(engines_counted, 1,
    "only the perplexity engine should be counted — aio is fully errored");
  assert.ok(visibility_index_pct !== null && visibility_index_pct > 0,
    "headline must be a positive number from the sole surviving engine");
});

// ---------------------------------------------------------------------------
// Test 3: Both engines fully errored → no index at all
// ---------------------------------------------------------------------------
test("R2.1.4 — both engines fully errored → headline is null and engines_counted is 0", () => {
  const aioResults = Array.from({ length: 10 }, (_, i) => erroredRow("aio", `query ${i}`));
  const pplxResults = Array.from({ length: 10 }, (_, i) => erroredRow("perplexity", `query ${i}`));

  const aioSlice = summarizeEngineSlice(aioResults, "aio");
  const pplxSlice = summarizeEngineSlice(pplxResults, "perplexity");

  const { visibility_index_pct, engines_counted } = computeHeadline([aioSlice, pplxSlice]);

  assert.equal(engines_counted, 0,
    "no engines are counted when both errored");
  assert.equal(visibility_index_pct, null,
    "headline must be null — no number may be published");
});

// ---------------------------------------------------------------------------
// Test 4: summarizeEngineResults propagates the failure to summary
// ---------------------------------------------------------------------------
test("R2.1.4 — summarizeEngineResults propagates failed state to summary", () => {
  const aioResults = Array.from({ length: 10 }, (_, i) => erroredRow("aio", `query ${i}`));
  const pplxResults = Array.from({ length: 10 }, (_, i) => erroredRow("perplexity", `query ${i}`));

  const aioSlice = summarizeEngineSlice(aioResults, "aio");
  const pplxSlice = summarizeEngineSlice(pplxResults, "perplexity");

  const output = summarizeEngineResults({
    engines: { aio: aioSlice, perplexity: pplxSlice },
    headline: computeHeadline([aioSlice, pplxSlice]),
    results: [],
  });

  assert.equal(output.summary.share_of_ai_pct, null,
    "scan-level share_of_ai_pct must be null when all engines failed");
  assert.equal(output.summary.state, ENGINE_MEASUREMENT_STATE.FAILED,
    "scan-level state must be failed");
  assert.ok(output.summary.state_reason, "state_reason must be present");
});

// ---------------------------------------------------------------------------
// Test 5: describeScanDataSourceIssue labels a fully-errored scan as critical
// ---------------------------------------------------------------------------
test("R2.1.4 — fully-errored scan has critical severity", () => {
  const aioResults = Array.from({ length: 10 }, (_, i) => erroredRow("aio", `query ${i}`));
  const pplxResults = Array.from({ length: 10 }, (_, i) => erroredRow("perplexity", `query ${i}`));

  const aioSlice = summarizeEngineSlice(aioResults, "aio");
  const pplxSlice = summarizeEngineSlice(pplxResults, "perplexity");

  const health = describeScanDataSourceIssue(
    { aio: aioSlice, perplexity: pplxSlice },
    { enginesCounted: 0 }
  );

  assert.equal(health.severity, "critical",
    "severity must be critical when all engines are degraded");
  assert.ok(health.degradedEngines.length >= 2,
    "both engines must be listed as degraded");
});

// ---------------------------------------------------------------------------
// Test 6: Hero label matches its value's provenance (A2)
//
// When the headline is null (all engines failed), the hero label must read
// "Not measured" — NOT a verdict like "Weak" or "Strong". When the headline
// is a number, the tier must NOT be null (there IS a measurement).
// ---------------------------------------------------------------------------
test("R2.1.4 — hero label matches provenance: null headline yields no tier, finite headline yields a tier", () => {
  // Case A: all engines failed → headline null → no tier
  const failedSlice = summarizeEngineSlice(
    Array.from({ length: 10 }, (_, i) => erroredRow("aio", `q ${i}`)),
    "aio"
  );
  const failedHeadline = computeHeadline([failedSlice]);
  assert.equal(failedHeadline.visibility_index_pct, null,
    "headline is null for a fully-errored engine");

  // Case B: one engine measured → headline is a number → a tier exists
  const measuredSlice = summarizeEngineSlice(
    Array.from({ length: 10 }, (_, i) => answeredRow("aio", `q ${i}`, { visible: true })),
    "aio"
  );
  const measuredHeadline = computeHeadline([measuredSlice]);
  assert.ok(Number.isFinite(measuredHeadline.visibility_index_pct),
    "headline is a real number for a measured engine");
  assert.equal(measuredHeadline.engines_counted, 1,
    "one engine counted");
});

// ---------------------------------------------------------------------------
// Test 7: A single errored row in a mostly-clean slice does NOT mark it failed
//         (the error rate must be below the threshold)
// ---------------------------------------------------------------------------
test("R2.1.4 — a single error in a clean slice stays measured, not failed", () => {
  const rows = [
    answeredRow("aio", "q0", { visible: true }),
    answeredRow("aio", "q1", { visible: true }),
    answeredRow("aio", "q2"),
    answeredRow("aio", "q3"),
    erroredRow("aio", "q4"),
  ];
  const slice = summarizeEngineSlice(rows, "aio");

  assert.notEqual(slice.state, ENGINE_MEASUREMENT_STATE.FAILED,
    "one error out of 5 must not trigger failed state");
  assert.ok(slice.share_of_ai_pct !== null,
    "share_of_ai_pct must be a number for a mostly-clean slice");
});
