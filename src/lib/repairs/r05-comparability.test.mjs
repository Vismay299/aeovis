/**
 * R05-17 / R05-18 / R05-21 / R05-24 — comparison boundaries, contradiction
 * detection, and one value on every surface.
 *
 * R05-17 — an engine that stopped resolving must not leave a headline that looks
 *   comparable to a wider historical one. The headline names the missing engine,
 *   marks itself reweighted, and the comparison against a two-engine history is
 *   REFUSED with the cohort boundary rather than presented as movement.
 * R05-18 — panel, surface, market, model policy and metric version are the
 *   dimensions a delta needs. Differ in any one of them (or fail to carry one at
 *   all) and the delta is suppressed with the specific reason.
 * R05-21 — a stored percentage that contradicts its own counts is reported, and a
 *   display may not silently prefer the flattering field.
 * R05-24 — the SAME scan read through the finalizer, the persisted record, the API
 *   payload and the UI/export normalizer agrees exactly on numerator, denominator,
 *   unit, versions and qualification state.
 *
 * WHAT R05-24 DOES AND DOES NOT TOUCH. The four legs are the real ones: the
 * finalizer is `summarizeEngineResults` (bound as `summarizeMulti` by the worker
 * and spread onto `raw_results.summary_stats`), the API leg is that same
 * `summary_stats` object, which both scan routes hand back verbatim, the
 * persistence leg is `buildScanBaseRecord` (the row db.js writes) and the
 * UI/export leg is `normalizeResult` — the normalizer the dashboard and the
 * download read `perEngineSummaries` from. No network, no provider, no database:
 * the routes' own modules import the Supabase SDK, so they are exercised through
 * the payload contract they share with the worker rather than imported here.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  computeHeadline,
  compareHeadlines,
  describeScanDataSourceIssue,
  summarizeEngineResults,
  summarizeEngineSlice,
} from "../scoring/enginePipeline.js";
import {
  COMPARISON_BOUNDARIES,
  METRIC_CONTRACT_VERSION,
  METRIC_IDS,
  METRIC_REASONS,
  METRIC_STATES,
  METRIC_UNITS,
  checkComparability,
  compareMetrics,
  createMetric,
  describeComparisonBoundary,
  findMetricContradictions,
  measurementContext,
  reconcileDisplayedMetric,
  validateMetric,
} from "../scoring/metricContract.js";
import { buildScanBaseRecord } from "../db/scanRow.js";
import { buildMetricsRows, summaryToMetricsRow } from "../analytics/rollup.js";
import { normalizeResult } from "../../services/api.js";

const SELF = "Acme";
const RIVAL = "RivalAlpha";

const CONTEXT_OPTIONS = {
  panelVersion: "panel-v1",
  surfaceVersion: "surface-v1",
  market: "in",
  modelPolicyVersion: "model-policy-v1",
};

function probeRow(i, { engine = "aio", names = "nobody", answered = true } = {}) {
  const mentionsSelf = names === "self";
  const mentionsRival = names === "rival";
  return {
    engine,
    prompt: `buyer question ${i}`,
    is_branded_query: false,
    answer_present: answered,
    aio_present: answered,
    text: answered ? (mentionsSelf ? "Acme is a solid choice." : mentionsRival ? "RivalAlpha is a solid choice." : "Follow the documentation.") : "",
    citations: [],
    references: [],
    brand_mentioned_in_text: mentionsSelf,
    brand_cited: false,
    visible: mentionsSelf,
    brands: [
      { name: SELF, is_self: true, mentioned: mentionsSelf, position: mentionsSelf ? 1 : null, sentiment: mentionsSelf ? 100 : null },
      { name: RIVAL, is_self: false, mentioned: mentionsRival, position: mentionsRival ? 1 : null, sentiment: mentionsRival ? 100 : null },
    ],
    error: answered ? null : "HTTP 503 transient provider failure",
    cost: 0.001,
  };
}

/** A healthy 30-question engine slice: `selfCount` answers name the brand. */
function healthySlice(engine, selfCount = 6) {
  const rows = Array.from({ length: 30 }, (_, i) =>
    probeRow(i, { engine, names: i < selfCount ? "self" : "rival" })
  );
  return { slice: summarizeEngineSlice(rows, engine, CONTEXT_OPTIONS), rows };
}

/** A slice whose every probe failed, which is `failed` / high_error_rate. */
function failedSlice(engine) {
  const rows = Array.from({ length: 30 }, (_, i) => probeRow(i, { engine, answered: false }));
  return summarizeEngineSlice(rows, engine, CONTEXT_OPTIONS);
}

/** A scan summary (the finalizer's output) plus the slices it was built from. */
function scanOf(slices) {
  const headline = computeHeadline(slices, undefined, CONTEXT_OPTIONS);
  const engines = Object.fromEntries(slices.map((s) => [s.engine, s]));
  return summarizeEngineResults({ results: [], engines, headline });
}

test("R05-17 — a frozen engine that failed is named, and the reweighted headline is not silently comparable", () => {
  const aio = healthySlice("aio", 6).slice;
  const failedPerplexity = failedSlice("perplexity");
  assert.equal(failedPerplexity.data_source_issue, true, "premise: the engine broke");
  assert.equal(failedPerplexity.state, "failed");

  const current = computeHeadline([aio, failedPerplexity], undefined, CONTEXT_OPTIONS);
  assert.equal(current.engines_counted, 1, "the failed engine is not blended");
  assert.deepEqual(current.counted_engines, ["aio"]);
  assert.equal(current.reweighted, true, "the index was renormalized over fewer engines, and says so");
  assert.deepEqual(
    current.excluded_engines.map((e) => [e.engine, e.state, e.state_reason]),
    [["perplexity", "failed", "high_error_rate"]],
    "the missing engine is explicit, with its reason"
  );
  assert.equal(current.headline_pct, 20, "the index is aio's own reading, not a blend");

  // The scan-level flag agrees, so a reader that never opens the headline still
  // sees that an engine went missing.
  const summary = summarizeEngineResults({ results: [], engines: { aio, perplexity: failedPerplexity }, headline: current });
  assert.equal(summary.summary.data_source_issue, true);
  assert.equal(summary.summary.headline_reweighted, true);
  const banner = describeScanDataSourceIssue({ aio, perplexity: failedPerplexity }, { enginesCounted: current.engines_counted });
  assert.equal(banner.severity, "partial");

  // The historical reading came from two healthy engines. Its cohort differs, so
  // the difference between the two is NOT a delta.
  const historical = computeHeadline(
    [healthySlice("aio", 6).slice, healthySlice("perplexity", 15).slice],
    undefined,
    CONTEXT_OPTIONS
  );
  assert.equal(historical.engines_counted, 2);

  const comparison = compareHeadlines(current, historical);
  assert.equal(comparison.comparable, false, "a reweighted index is not a movement in the wider one");
  assert.equal(comparison.delta_pct, null);
  assert.equal(comparison.boundary_reason, COMPARISON_BOUNDARIES.ENGINE_COHORT);
  assert.ok(comparison.detail.length > 0, "the refusal carries its sentence");
  assert.deepEqual(comparison.changed.map((c) => c.dimension), ["engine_cohort"]);
});

test("R05-18 — a panel, surface, market, model-policy or metric-version change suppresses the delta by name", () => {
  const slices = [healthySlice("aio", 6).slice];
  const baseline = computeHeadline(slices, undefined, CONTEXT_OPTIONS);

  // Everything identical: a delta IS computable, so the refusals below are about
  // the dimension that changed and not about refusing in general.
  const sameAgain = computeHeadline(slices, undefined, CONTEXT_OPTIONS);
  assert.equal(compareHeadlines(sameAgain, baseline).comparable, true);

  const withPanel = computeHeadline(slices, undefined, { ...CONTEXT_OPTIONS, panelVersion: "panel-v2" });
  const panelComparison = compareHeadlines(withPanel, baseline);
  assert.equal(panelComparison.boundary_reason, COMPARISON_BOUNDARIES.PANEL);
  assert.equal(panelComparison.delta_pct, null);
  assert.match(panelComparison.detail, /panel/i);

  const withSurface = computeHeadline(slices, undefined, { ...CONTEXT_OPTIONS, surfaceVersion: "consumer-browser-v1" });
  assert.equal(compareHeadlines(withSurface, baseline).boundary_reason, COMPARISON_BOUNDARIES.SURFACE);

  const withMarket = computeHeadline(slices, undefined, { ...CONTEXT_OPTIONS, market: "us" });
  assert.equal(compareHeadlines(withMarket, baseline).boundary_reason, COMPARISON_BOUNDARIES.MARKET);

  const withModelPolicy = computeHeadline(slices, undefined, { ...CONTEXT_OPTIONS, modelPolicyVersion: "model-policy-v2" });
  assert.equal(compareHeadlines(withModelPolicy, baseline).boundary_reason, COMPARISON_BOUNDARIES.MODEL_POLICY);

  // The two dimensions a metric DTO owns directly.
  const metricVersionChange = checkComparability(
    measurementContext({ ...CONTEXT_OPTIONS, engineCohort: ["aio"] }),
    { ...measurementContext({ ...CONTEXT_OPTIONS, engineCohort: ["aio"] }), metric_version: "r05-metric-v2" }
  );
  assert.equal(metricVersionChange.comparable, false);
  assert.equal(metricVersionChange.boundary_reason, COMPARISON_BOUNDARIES.METRIC_VERSION);

  const policyChange = checkComparability(
    measurementContext({ ...CONTEXT_OPTIONS, engineCohort: ["aio"] }),
    { ...measurementContext({ ...CONTEXT_OPTIONS, engineCohort: ["aio"] }), policy_version: "eligibility-policy-v2" }
  );
  assert.equal(policyChange.boundary_reason, COMPARISON_BOUNDARIES.POLICY);

  // A record that does not carry its measurement identity has nothing to compare
  // against, and says THAT rather than quietly comparing anyway.
  const anonymous = computeHeadline(slices);
  const anonymousComparison = compareHeadlines(anonymous, baseline);
  assert.equal(anonymousComparison.comparable, false);
  assert.equal(anonymousComparison.boundary_reason, COMPARISON_BOUNDARIES.CONTEXT_INCOMPLETE);
  assert.ok(anonymousComparison.changed.some((c) => c.dimension === "panel_version"));

  // ...and the same rule for two metric DTOs read straight off a row.
  const left = createMetric({
    metricId: METRIC_IDS.EXPOSURE,
    numerator: 6,
    denominator: 30,
    eligiblePromptIds: Array.from({ length: 30 }, (_, i) => `q${i}`),
    collection: { valid: 30, planned: 30 },
    context: measurementContext({ ...CONTEXT_OPTIONS, engineCohort: ["aio"] }),
  });
  const right = createMetric({
    metricId: METRIC_IDS.EXPOSURE,
    numerator: 6,
    denominator: 30,
    eligiblePromptIds: Array.from({ length: 30 }, (_, i) => `q${i}`),
    collection: { valid: 30, planned: 30 },
    context: measurementContext({ ...CONTEXT_OPTIONS, engineCohort: ["aio"] }),
  });
  assert.equal(compareMetrics(left, right).comparable, true);
  assert.equal(compareMetrics(left, right).delta_pct, 0);
  assert.equal(compareMetrics(right, left).delta_pct, 0);
  assert.match(describeComparisonBoundary(COMPARISON_BOUNDARIES.MARKET), /market/i);
});

test("R05-21 — counts that contradict a stored percentage are flagged, never resolved in favour of the flattering field", () => {
  const contradictions = findMetricContradictions({ numerator: 6, denominator: 30, value_pct: 100 });
  assert.deepEqual(contradictions.map((c) => c.code), ["value_disagrees_with_counts"]);

  const display = reconcileDisplayedMetric({ numerator: 6, denominator: 30, value_pct: 100 });
  assert.equal(display.flagged, true);
  assert.equal(display.displayed_pct, 20, "the counts decide, not the flattering field");
  assert.equal(display.value_source, "counts");

  // An honest pair is untouched and is reported as read, not recomputed.
  const honest = reconcileDisplayedMetric({ numerator: 6, denominator: 30, value_pct: 20 });
  assert.equal(honest.flagged, false);
  assert.equal(honest.displayed_pct, 20);
  assert.equal(honest.value_source, "stored");

  // Impossible counts produce NO value and a recorded contradiction, rather than
  // a percentage above 100.
  const impossible = createMetric({
    metricId: METRIC_IDS.MENTION,
    numerator: 31,
    denominator: 30,
    eligiblePromptIds: Array.from({ length: 30 }, (_, i) => `q${i}`),
    collection: { valid: 30, planned: 30 },
    context: measurementContext(CONTEXT_OPTIONS),
  });
  assert.equal(impossible.value_pct, null);
  assert.equal(impossible.reason, METRIC_REASONS.CONTRADICTORY_COUNTS);
  assert.equal(validateMetric(impossible).valid, false);

  // ...and on the durable row: the stored share stays byte-identical (history and
  // the summary-preference contract are unchanged) but can no longer be read
  // without the contradiction beside it.
  const row = summaryToMetricsRow({
    brand: "acme.io",
    date: "2026-10-16",
    engine: "aio",
    scanId: "scan-1",
    promptSetId: null,
    summary: {
      non_branded_queries: 30,
      non_branded_with_answer: 8,
      cited_non_branded: 2,
      citation_denominator: 8,
      citation_share_pct: 99.9,
    },
    answeredKey: "non_branded_with_answer",
  });
  assert.equal(row.citation_share_pct, 99.9, "the stored value is preserved, not silently rewritten");
  assert.equal(row.metric_conflict, true, "and it is flagged");
  assert.deepEqual(row.metric_conflicts.map((c) => c.code), ["value_disagrees_with_counts"]);

  const clean = summaryToMetricsRow({
    brand: "acme.io",
    date: "2026-10-16",
    engine: "aio",
    scanId: "scan-1",
    promptSetId: null,
    summary: { non_branded_queries: 30, non_branded_with_answer: 8, cited_non_branded: 2, citation_denominator: 8 },
    answeredKey: "non_branded_with_answer",
  });
  assert.equal(clean.metric_conflict, false, "a consistent row is not flagged");
});

test("R05-24 — finalizer, persisted record, API payload and UI/export agree on the same metric", () => {
  const { slice, rows } = healthySlice("aio", 6);
  const headline = computeHeadline([slice], undefined, CONTEXT_OPTIONS);
  const finalizer = summarizeEngineResults({ results: rows, engines: { aio: slice }, headline });

  // Leg 2 — persistence. The row db.js writes, modelled on its own allowlist:
  // `summary_stats` and `engines` both ride inside `raw_results`.
  const persisted = buildScanBaseRecord({
    brand: "acme.io",
    url: "https://acme.io",
    industry: "saas",
    visibility_pct: finalizer.summary.visibility_pct,
    prompts_tracked: finalizer.summary.non_branded_queries,
    prompts_mentioned: finalizer.summary.mentioned_non_branded,
    engines: finalizer.engines,
    visibility_index_pct: headline.visibility_index_pct,
    engines_counted: headline.engines_counted,
    summary_stats: { ...finalizer.summary, terminal_outcome: { version: "r03-v1", outcome: "complete" } },
    raw_results: {
      results: rows,
      competitors: [],
      engines: finalizer.engines,
      visibility_index_pct: headline.visibility_index_pct,
      summary_stats: { ...finalizer.summary, terminal_outcome: { version: "r03-v1", outcome: "complete" } },
    },
    scanned_at: "2026-10-16T10:00:00.000Z",
  });

  // Leg 3 — the API payload: both scan routes hand `raw_results.summary_stats`
  // back verbatim, which is exactly this object.
  const apiPayload = persisted.raw_results.summary_stats;

  // Leg 4 — the UI/export normalizer, over that persisted row.
  const normalized = normalizeResult(persisted, "Acme", "acme.io");

  // Leg 5 — the durable analytics row the daily rollup writes.
  const metricsRows = buildMetricsRows({
    isMultiEngine: true,
    brandKey: "acme.io",
    dateOnly: "2026-10-16",
    scanId: "scan-1",
    promptSetId: "ps-1",
    summary: finalizer.summary,
    engineSummaries: finalizer.engines,
    headline,
    promptResultRows: null,
  });

  const legs = {
    slice: slice.metrics[METRIC_IDS.EXPOSURE],
    finalizer: finalizer.summary.metrics[METRIC_IDS.EXPOSURE],
    api: apiPayload.metrics[METRIC_IDS.EXPOSURE],
    ui: normalized.perEngineSummaries.aio.metrics[METRIC_IDS.EXPOSURE],
    rollup: metricsRows.find((r) => r.engine === "aio").exposure_metric,
  };

  const comparable = (metric) => ({
    metric_id: metric.metric_id,
    unit: metric.unit,
    numerator: metric.numerator,
    denominator: metric.denominator,
    value_pct: metric.value_pct,
    state: metric.state,
    qualified: metric.qualified,
    qualified_pct: metric.qualified_pct,
    qualified_reason: metric.qualified_reason,
    distinct: metric.distinct_eligible_prompts,
    valid_collection_pct: metric.valid_collection_pct,
    panel_version: metric.context.panel_version,
    surface_version: metric.context.surface_version,
    market: metric.context.market,
    model_policy_version: metric.context.model_policy_version,
    metric_version: metric.context.metric_version,
    policy_version: metric.context.policy_version,
  });

  const expected = comparable(legs.slice);
  assert.equal(expected.numerator, 6);
  assert.equal(expected.denominator, 30);
  assert.equal(expected.unit, METRIC_UNITS.PERCENT);
  assert.equal(expected.value_pct, 20);
  assert.equal(expected.qualified, true);
  assert.equal(expected.metric_version, METRIC_CONTRACT_VERSION);
  for (const [leg, metric] of Object.entries(legs)) {
    assert.ok(metric, `the ${leg} leg carries no exposure metric`);
    assert.deepEqual(comparable(metric), expected, `the ${leg} leg disagrees with the producer`);
  }

  // The headline itself agrees too: finalizer, API payload, rollup 'all' row and
  // the normalizer's own index field.
  const headlineLegs = {
    finalizer: finalizer.summary.headline_metric,
    api: apiPayload.headline_metric,
    rollup: metricsRows.find((r) => r.engine === "all").exposure_metric,
  };
  const comparableHeadline = comparable(headlineLegs.finalizer);
  for (const [leg, metric] of Object.entries(headlineLegs)) {
    assert.deepEqual(comparable(metric), comparableHeadline, `the ${leg} headline metric disagrees`);
  }
  assert.equal(comparableHeadline.numerator, 6);
  assert.equal(comparableHeadline.denominator, 30);
  assert.equal(finalizer.summary.headline_pct, 20);
  assert.equal(apiPayload.headline_pct, 20);
  assert.equal(normalized.visibilityIndexPct, headline.visibility_index_pct);
  assert.equal(finalizer.summary.visibility_pct, headline.visibility_index_pct);
});
