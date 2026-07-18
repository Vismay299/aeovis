import test from "node:test";
import assert from "node:assert/strict";
import { summarizeAioResults } from "./aioPipeline.js";
import {
  AIO_MIN_NON_BRANDED_COVERAGE,
  AIO_MIN_NON_BRANDED_WITH_AIO,
} from "./aioConstants.js";

function makeResult({ aioPresent, visible, error = null }) {
  return {
    prompt: "sample query",
    is_branded_query: false,
    aio_present: aioPresent,
    aio_text: aioPresent ? "some AI overview text" : "",
    brand_mentioned_in_text: aioPresent && visible,
    brand_cited: false,
    visible: aioPresent && visible,
    error,
  };
}

// 30 non-branded results: 14 with an AIO, 6 of those visible.
function buildFixedResults() {
  const results = [];
  for (let i = 0; i < 6; i++) results.push(makeResult({ aioPresent: true, visible: true }));
  for (let i = 0; i < 8; i++) results.push(makeResult({ aioPresent: true, visible: false }));
  for (let i = 0; i < 16; i++) results.push(makeResult({ aioPresent: false, visible: false }));
  return results;
}

test("summarizeAioResults - three consistently-defined metrics on the 30-prompt fixture", () => {
  const results = buildFixedResults();
  assert.equal(results.length, 30);

  const { summary } = summarizeAioResults(results);

  assert.equal(summary.non_branded_queries, 30);
  assert.equal(summary.non_branded_with_aio, 14);
  assert.equal(summary.visible_non_branded, 6);

  // Hero: visible ÷ queries_with_aio = 6/14
  assert.equal(summary.visibility_pct, 42.9);
  assert.equal(summary.share_of_ai_pct, summary.visibility_pct);

  // Coverage: queries_with_aio ÷ 30
  assert.equal(summary.aio_coverage_pct, 46.7);

  // Presence: visible ÷ 30
  assert.equal(summary.presence_rate_pct, 20);
});

test("summarizeAioResults - gate booleans reflect the India-adjusted thresholds", () => {
  const results = buildFixedResults();
  const { summary } = summarizeAioResults(results);

  // 14/30 = 46.7% coverage, comfortably above the 15% India floor.
  assert.equal(summary.data_source_issue, false);
  assert.equal(AIO_MIN_NON_BRANDED_COVERAGE, 0.15);
  // 14 queries with AIO is above the minimum sample of 5.
  assert.equal(summary.insufficient_sample, false);
  assert.equal(AIO_MIN_NON_BRANDED_WITH_AIO, 5);
});

test("summarizeAioResults - low India coverage flags data_source_issue, not a fake 0%", () => {
  const results = [];
  for (let i = 0; i < 3; i++) results.push(makeResult({ aioPresent: true, visible: true }));
  for (let i = 0; i < 27; i++) results.push(makeResult({ aioPresent: false, visible: false }));

  const { summary } = summarizeAioResults(results);

  // 3/30 = 10% coverage, below the 15% floor.
  assert.equal(summary.data_source_issue, true);
  assert.equal(summary.insufficient_sample, true);
});
