/**
 * R05 — denominator invariance and sample eligibility (findings A02–A04).
 *
 * WHAT THIS FILE PROVES, AND HOW. Every case below drives the REAL producers —
 * `summarizeEngineSlice` from src/lib/scoring/enginePipeline.js and the metric
 * DTOs from src/lib/scoring/metricContract.js — over plain persisted-shape probe
 * rows. Nothing here re-implements a ratio: if the contract's rule changes, these
 * numbers move with it, which is the only way the cases can fail honestly.
 *
 * THE THREE DEFECTS, RESTATED AS THE ASSERTIONS BELOW.
 *
 *   A02 — thirty answers of which ONE named a vendor published a 100% headline
 *         while `insufficient_sample` was true, because the ratio divided by the
 *         one eliciting answer and the eligibility test counted the thirty
 *         answered ones. R05-05 holds the raw conditional 1/1 visible as an
 *         exploratory reading AND requires it to be unqualified with a named
 *         reason, and requires the headlined value to be the rate over the
 *         declared panel rather than the conditional one.
 *   A03 — a brand cited in an answer it was never named in was dropped by a
 *         filter that only knew about text, so a real appearance vanished.
 *         R05-04 requires the citation numerator to be 1, the mention numerator
 *         to be 0, and the declared combined visibility to count the citation.
 *   A04 — the same answers scored 20% or 100% depending only on whether a
 *         never-mentioned rival sat in the tracked roster. R05-02/R05-03 hold
 *         the self metrics and the qualified headline byte-identical across both
 *         rosters.
 *
 * THE LEGACY CONDITIONAL INDEX IS NOT THE SELF RATE, and this file says so in
 * its assertions rather than in prose alone: `share_of_ai_pct` /
 * `visible_non_branded` / `eliciting_queries` are the CONDITIONAL reading ("among
 * answers that named a vendor, how often was it us"), pinned by two other
 * repairs' tests, and they keep their meaning. The self metrics in `slice.metrics`
 * and the headline in `computeHeadline(...).headline_pct` are the unconditional
 * ones, and they are the values that must not move with a roster.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { computeHeadline, summarizeEngineSlice } from "../scoring/enginePipeline.js";
import {
  ELIGIBILITY_POLICY_V1,
  METRIC_IDS,
  METRIC_REASONS,
  METRIC_STATES,
  METRIC_UNITS,
  createMetric,
  measurementContext,
  qualifyMetric,
} from "../scoring/metricContract.js";

const SELF = "Acme";
const RIVAL = "RivalAlpha";

const ANSWER_NAMING = {
  self: "Acme is a solid choice for this.",
  rival: "RivalAlpha is a solid choice for this.",
  nobody: "Follow the step-by-step documentation in the user manual.",
};

/**
 * An answered non-branded AIO row. `names` is who the answer named — the exact
 * thing `judgeBrandsSymmetric` writes per brand.
 */
function probeRow(i, { names = "nobody", cited = false, prompt = null, replicate = 1, answered = true, relationship = null } = {}) {
  const mentionsSelf = names === "self";
  const mentionsRival = names === "rival";
  const self = {
    name: SELF,
    is_self: true,
    mentioned: mentionsSelf,
    position: mentionsSelf ? 1 : null,
    sentiment: mentionsSelf ? 100 : null,
  };
  if (relationship !== null) self.relationship = relationship;
  return {
    engine: "aio",
    prompt: prompt ?? `buyer question ${i}`,
    is_branded_query: false,
    answer_present: answered,
    aio_present: answered,
    text: answered ? ANSWER_NAMING[names] : "",
    citations: cited ? [`https://acme.io/guide-${i}`] : [],
    references: cited ? [{ href: `https://acme.io/guide-${i}`, domain: "acme.io" }] : [],
    brand_mentioned_in_text: mentionsSelf,
    brand_cited: cited,
    visible: mentionsSelf || cited,
    brands: [
      self,
      { name: RIVAL, is_self: false, mentioned: mentionsRival, position: mentionsRival ? 2 : null, sentiment: mentionsRival ? 100 : null },
    ],
    error: answered ? null : "HTTP 503 transient provider failure",
    cost: 0.001,
    ...(replicate > 1 ? { replicate } : {}),
  };
}

/** A panel whose answers name `selfCount` self and `rivalCount` rivals. */
function panel({ selfCount = 0, rivalCount = 0, total = 30 }) {
  return Array.from({ length: total }, (_, i) =>
    probeRow(i, { names: i < selfCount ? "self" : i < selfCount + rivalCount ? "rival" : "nobody" })
  );
}

/**
 * Repeated observations of ONE question: a second, third … scheduled
 * measurement of the same prompt is a DIFFERENT logical observation (its
 * replicate index differs), which is exactly why it is not a duplicate — and
 * exactly why it still cannot make one question into a sample of twenty.
 */
function repeatOnePrompt(prompt, times, { selfCount = 0, rivalCount = 0 } = {}) {
  return Array.from({ length: times }, (_, i) =>
    probeRow(i, {
      prompt,
      replicate: i + 1,
      names: i < selfCount ? "self" : i < selfCount + rivalCount ? "rival" : "nobody",
    })
  );
}

function exposure(slice) {
  return slice.metrics[METRIC_IDS.EXPOSURE];
}

// ---------------------------------------------------------------------------

test("R05-01 — six self mentions among 30 valid answers is 20%, and all 30 stay in the declared panel", () => {
  const slice = summarizeEngineSlice(panel({ selfCount: 6, rivalCount: 24 }), "aio");

  assert.equal(slice.non_branded_with_answer, 30, "all thirty answers are valid observations");
  assert.equal(exposure(slice).numerator, 6);
  assert.equal(exposure(slice).denominator, 30, "the declared panel is the denominator, not a filtered pool");
  assert.equal(exposure(slice).value_pct, 20, "6 of 30 is 20%");
  assert.equal(exposure(slice).eligible_prompt_ids.length, 30, "all thirty questions are in the denominator");
  assert.equal(exposure(slice).distinct_eligible_prompts, 30);

  // The same six answers, read as a text-mention rate, agree — the two self
  // metrics differ in WHAT they count, not in who is allowed into the panel.
  const mention = slice.metrics[METRIC_IDS.MENTION];
  assert.equal(mention.numerator, 6);
  assert.equal(mention.denominator, 30);

  // 30 distinct questions and 30/30 collection clear both v1 gates.
  assert.equal(exposure(slice).qualified, true);
  assert.equal(exposure(slice).qualified_pct, 20);
  assert.equal(exposure(slice).valid_collection_pct, 100);
});

test("R05-02 — adding an unmentioned rival leaves self values and denominators unchanged", () => {
  const withoutRival = panel({ selfCount: 6, total: 30 }).map((row) => ({
    ...row,
    brands: row.brands.filter((b) => b.is_self),
  }));
  const withRival = withoutRival.map((row) => ({
    ...row,
    brands: [...row.brands, { name: RIVAL, is_self: false, mentioned: false, position: null, sentiment: null }],
  }));

  const before = summarizeEngineSlice(withoutRival, "aio");
  const after = summarizeEngineSlice(withRival, "aio");

  for (const metricId of [METRIC_IDS.EXPOSURE, METRIC_IDS.MENTION, METRIC_IDS.CITATION]) {
    assert.deepEqual(
      {
        numerator: after.metrics[metricId].numerator,
        denominator: after.metrics[metricId].denominator,
        value_pct: after.metrics[metricId].value_pct,
        promptIds: after.metrics[metricId].eligible_prompt_ids,
      },
      {
        numerator: before.metrics[metricId].numerator,
        denominator: before.metrics[metricId].denominator,
        value_pct: before.metrics[metricId].value_pct,
        promptIds: before.metrics[metricId].eligible_prompt_ids,
      },
      `${metricId} moved when a never-mentioned rival was added to the roster`
    );
  }
  assert.equal(after.metrics[METRIC_IDS.EXPOSURE].value_pct, 20, "still 6 of 30");

  // The published headline is the same reading on both sides. This is the
  // sentence that closes A04: a score that moves on roster metadata alone is a
  // score that was not measuring the brand.
  const headlineBefore = computeHeadline([before]);
  const headlineAfter = computeHeadline([after]);
  assert.equal(headlineAfter.headline_pct, headlineBefore.headline_pct);
  assert.equal(headlineAfter.headline_pct, 20);
  assert.equal(headlineAfter.qualified, true);

  // ...and the value that DOES move is the conditional diagnostic, which is
  // labelled as such and is never the headline.
  assert.equal(after.metrics[METRIC_IDS.CONDITIONAL_VENDOR_SHARE].conditional, true);
  assert.equal(after.metrics[METRIC_IDS.SHARE_OF_VOICE].conditional, true);
  assert.equal(before.metrics[METRIC_IDS.CONDITIONAL_VENDOR_SHARE].conditional, true);
});

test("R05-03 — removing a tracked rival causes no jump in the self values or the headline", () => {
  const withRival = panel({ selfCount: 6, total: 30 });
  const withoutRival = withRival.map((row) => ({
    ...row,
    brands: row.brands.filter((b) => b.is_self),
  }));

  const tracked = summarizeEngineSlice(withRival, "aio");
  const removed = summarizeEngineSlice(withoutRival, "aio");

  assert.equal(removed.metrics[METRIC_IDS.EXPOSURE].value_pct, tracked.metrics[METRIC_IDS.EXPOSURE].value_pct);
  assert.equal(removed.metrics[METRIC_IDS.EXPOSURE].denominator, tracked.metrics[METRIC_IDS.EXPOSURE].denominator);
  assert.equal(computeHeadline([removed]).headline_pct, computeHeadline([tracked]).headline_pct);
  assert.equal(computeHeadline([removed]).headline_pct, 20);

  // Removing the rival DOES remove the ability to say how much of the vendor
  // conversation is ours — that is a property of the question, not of the score.
  assert.equal(removed.metrics[METRIC_IDS.SHARE_OF_VOICE].value_pct, null);
  assert.equal(removed.metrics[METRIC_IDS.SHARE_OF_VOICE].reason, METRIC_REASONS.SELF_ONLY_ROSTER);
});

test("R05-04 — one owned citation and no text mention: citation 1, mention 0, combined visibility counts the citation", () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    i === 0 ? probeRow(0, { names: "nobody", cited: true, prompt: "informational question" }) : probeRow(i, { names: "rival" })
  );
  const slice = summarizeEngineSlice(rows, "aio");

  const citation = slice.metrics[METRIC_IDS.CITATION];
  assert.equal(citation.numerator, 1, "the owned domain was in the citation list of exactly one answer");
  assert.equal(citation.denominator, 30, "every answered row's citation list was observed on a single-leg engine");
  assert.equal(citation.value_pct, 3.3);
  assert.equal(citation.state, METRIC_STATES.MEASURED);

  const mention = slice.metrics[METRIC_IDS.MENTION];
  assert.equal(mention.numerator, 0, "the brand was never NAMED — that is a different measurement");
  assert.equal(mention.denominator, 30);
  assert.equal(mention.value_pct, 0, "a measured zero over a real panel, not an absence");

  assert.equal(exposure(slice).numerator, 1, "the declared combined visibility counts the citation-only appearance");
  assert.equal(exposure(slice).denominator, 30);
  assert.equal(exposure(slice).value_pct, 3.3);

  // The legacy citation numerator, which the eliciting filter never touched.
  assert.equal(slice.cited_non_branded, 1);
});

test("R05-05 — a one-observation metric keeps its raw 1/1 as exploratory and is refused as a headline", () => {
  // (a) THE A02 INPUT: thirty answers, one of which named a vendor.
  const a02Rows = panel({ selfCount: 1, total: 30 });
  const a02 = summarizeEngineSlice(a02Rows, "aio");
  const conditional = a02.metrics[METRIC_IDS.CONDITIONAL_VENDOR_SHARE];

  assert.equal(conditional.numerator, 1, "raw counts stay visible");
  assert.equal(conditional.denominator, 1, "and so does the denominator they were counted over");
  assert.equal(conditional.value_pct, 100, "the raw conditional reading is 1/1 and IS shown, as exploratory");
  assert.equal(conditional.qualified, false);
  assert.equal(conditional.qualified_pct, null);
  assert.equal(conditional.qualified_reason, METRIC_REASONS.INSUFFICIENT_DISTINCT_PROMPTS);
  assert.equal(conditional.distinct_eligible_prompts, 1);
  assert.equal(a02.share_of_voice_pct, 100, "the same conditional reading, on the same one-answer denominator");
  assert.equal(a02.insufficient_sample, true, "the adequacy signal is true, and it now has a consequence");

  // The headline is NOT that 100. It is the self rate over the declared panel,
  // which is the number the measurement can actually support.
  const headline = computeHeadline([a02]);
  assert.equal(headline.visibility_index_pct, 100, "the raw index is preserved as an exploratory value");
  assert.notEqual(headline.headline_pct, 100, "no 100% headline may be published off one answer in thirty");
  assert.equal(headline.headline_pct, 3.3, "1 of 30 is the supported reading");
  assert.equal(headline.qualified, true);
  assert.equal(headline.distinct_eligible_prompts, 30);

  // (b) ONE ELIGIBLE RECOMMENDATION: the recommendation metric's own denominator
  // is 1 because only one answer carried a recommendation judgment at all. The
  // gate reads THAT denominator, not the thirty answers it sits among.
  const rows = Array.from({ length: 30 }, (_, i) =>
    i === 0
      ? probeRow(0, { names: "self", prompt: "which is the best option" })
      : { ...probeRow(i, { names: "rival" }), brands: [{ name: RIVAL, is_self: false, mentioned: true, position: 1, sentiment: 100 }] }
  );
  const recommendation = summarizeEngineSlice(rows, "aio").metrics[METRIC_IDS.RECOMMENDATION];
  assert.equal(recommendation.numerator, 1);
  assert.equal(recommendation.denominator, 1, "the metric's ACTUAL denominator");
  assert.equal(recommendation.value_pct, 100, "raw 1/1, shown as exploratory");
  assert.equal(recommendation.qualified, false);
  assert.equal(recommendation.qualified_pct, null);
  assert.equal(recommendation.qualified_reason, METRIC_REASONS.INSUFFICIENT_DISTINCT_PROMPTS);
  assert.equal(recommendation.collection.valid, 30, "the larger answered pool is NOT the denominator the gate uses");

  // (c) The same thirty answers, now with a roster the other twenty-nine
  // answers actually named. The CONDITIONAL index moves (that is what "among
  // answers that named a vendor" means); the self rate and the published
  // headline agree with each other and neither becomes a 100.
  const namedPanel = summarizeEngineSlice(panel({ selfCount: 1, rivalCount: 29, total: 30 }), "aio");
  assert.equal(namedPanel.share_of_ai_pct, 3.3, "1 self appearance among 30 answers that named a vendor");
  assert.equal(exposure(namedPanel).value_pct, 3.3, "and the self rate over the declared panel says the same thing");
  assert.equal(computeHeadline([namedPanel]).headline_pct, 3.3, "the headline is the supported reading");
  assert.notEqual(computeHeadline([namedPanel]).headline_pct, 100);
});

test("R05-06 — the 19-then-20 distinct-prompt boundary is exact", () => {
  const at19 = summarizeEngineSlice(panel({ rivalCount: 19, total: 19 }), "aio");
  const at20 = summarizeEngineSlice(panel({ rivalCount: 20, total: 20 }), "aio");

  assert.equal(exposure(at19).distinct_eligible_prompts, 19);
  assert.equal(exposure(at19).value_pct, 0, "a real measured zero over nineteen answers");
  assert.equal(exposure(at19).qualified, false, "nineteen distinct questions is under the v1 minimum");
  assert.equal(exposure(at19).qualified_reason, METRIC_REASONS.INSUFFICIENT_DISTINCT_PROMPTS);
  assert.equal(exposure(at19).qualified_pct, null);

  assert.equal(exposure(at20).distinct_eligible_prompts, 20);
  assert.equal(exposure(at20).value_pct, 0);
  assert.equal(exposure(at20).qualified, true, "twenty is the minimum, and it is met exactly");
  assert.equal(exposure(at20).qualified_pct, 0, "a qualified zero is a real finding, and stays 0");
  assert.equal(exposure(at20).policy.min_distinct_eligible_prompts, ELIGIBILITY_POLICY_V1.minDistinctEligiblePrompts);

  // Re-qualifying a stored DTO under the same policy reaches the same verdict, so
  // a reader that only has the DTO cannot disagree with the producer.
  assert.equal(qualifyMetric(exposure(at19)).qualified, false);
  assert.equal(qualifyMetric(exposure(at20)).qualified, true);
});

test("R05-07 — one prompt repeated thirty times cannot unlock a headline", () => {
  const rows = repeatOnePrompt("best tiles in india", 30, { selfCount: 6, rivalCount: 24 });
  const slice = summarizeEngineSlice(rows, "aio");
  const metric = exposure(slice);

  assert.equal(metric.denominator, 30, "thirty scheduled deliveries were counted");
  assert.equal(metric.value_pct, 20, "and the raw rate they imply stays visible");
  assert.equal(metric.replicate_observations, 29, "twenty-nine of them are replicates, and it says so");
  assert.equal(metric.distinct_eligible_prompts, 1, "but they are all the same question");
  assert.equal(metric.qualified, false);
  assert.equal(metric.qualified_reason, METRIC_REASONS.INSUFFICIENT_DISTINCT_PROMPTS);

  const headline = computeHeadline([slice]);
  assert.equal(headline.headline_pct, null, "replicates never satisfy the distinct-prompt minimum");
  assert.equal(headline.headline_reason, METRIC_REASONS.INSUFFICIENT_DISTINCT_PROMPTS);
  assert.equal(headline.distinct_eligible_prompts, 1);
});

test("R05-08 — 29 of 30 clears the 95% collection gate, 28 of 30 fails, both keep their raw counts", () => {
  const planned = 30;
  const build = (answeredCount, selfCount) =>
    Array.from({ length: planned }, (_, i) =>
      probeRow(i, {
        answered: i < answeredCount,
        names: i >= answeredCount ? "nobody" : i < selfCount ? "self" : "rival",
      })
    );

  const clears = summarizeEngineSlice(build(29, 6), "aio");
  assert.equal(clears.metrics[METRIC_IDS.EXPOSURE].collection.valid, 29);
  assert.equal(clears.metrics[METRIC_IDS.EXPOSURE].collection.planned, 30);
  assert.equal(clears.metrics[METRIC_IDS.EXPOSURE].valid_collection_pct, 96.7);
  assert.equal(clears.metrics[METRIC_IDS.EXPOSURE].qualified, true, "29/30 is above the 95% floor");
  assert.equal(clears.metrics[METRIC_IDS.EXPOSURE].qualified_pct, 20.7);

  const fails = summarizeEngineSlice(build(28, 6), "aio");
  const failing = fails.metrics[METRIC_IDS.EXPOSURE];
  assert.equal(failing.collection.valid, 28);
  assert.equal(failing.collection.planned, 30);
  assert.equal(failing.valid_collection_pct, 93.3);
  assert.equal(failing.value_pct, 21.4, "the raw measured ratio is still published");
  assert.equal(failing.numerator, 6);
  assert.equal(failing.denominator, 28, "and so is the denominator it was counted over");
  assert.equal(failing.qualified, false);
  assert.equal(failing.qualified_pct, null);
  assert.equal(failing.qualified_reason, METRIC_REASONS.INSUFFICIENT_COLLECTION);
  assert.equal(failing.policy.min_valid_collection, 0.95);
});

test("R05-09 — zero eligible observations is null with a reason, never a 0/0 coercion", () => {
  const empty = summarizeEngineSlice([], "aio");
  assert.equal(exposure(empty).numerator, 0);
  assert.equal(exposure(empty).denominator, 0);
  assert.equal(exposure(empty).value_pct, null, "nothing was divided, so there is no value");
  assert.notEqual(exposure(empty).value_pct, 0);
  assert.equal(exposure(empty).state, METRIC_STATES.NOT_ASSESSED);
  assert.equal(exposure(empty).reason, METRIC_REASONS.NO_ELIGIBLE_OBSERVATIONS);
  assert.equal(exposure(empty).unknown_reason, METRIC_REASONS.NO_ELIGIBLE_OBSERVATIONS);
  assert.equal(exposure(empty).qualified, false);
  assert.equal(exposure(empty).qualified_pct, null);

  const allErrored = summarizeEngineSlice(
    Array.from({ length: 30 }, (_, i) => probeRow(i, { answered: false })),
    "aio"
  );
  assert.equal(allErrored.metrics[METRIC_IDS.EXPOSURE].value_pct, null);
  assert.equal(allErrored.metrics[METRIC_IDS.EXPOSURE].reason, METRIC_REASONS.NO_ELIGIBLE_OBSERVATIONS);

  // The contract refuses 0/0 directly, with the same reason, so no caller can
  // manufacture the zero this case is about.
  const coerced = createMetric({
    metricId: METRIC_IDS.MENTION,
    numerator: 0,
    denominator: 0,
    context: measurementContext({ market: "in" }),
  });
  assert.equal(coerced.value_pct, null);
  assert.equal(coerced.reason, METRIC_REASONS.NO_ELIGIBLE_OBSERVATIONS);
  assert.equal(coerced.collection, null);
});

test("R05-10 — twenty valid eligible answers with zero mentions is a measured zero, headlinable only if every gate passes", () => {
  const qualifying = summarizeEngineSlice(panel({ rivalCount: 20, total: 20 }), "aio");
  const metric = exposure(qualifying);
  assert.equal(metric.value_pct, 0, "a measured zero is a number, not an absence");
  assert.equal(metric.state, METRIC_STATES.MEASURED_ZERO);
  assert.equal(metric.reason, METRIC_REASONS.BRAND_NOT_VISIBLE);
  assert.equal(metric.distinct_eligible_prompts, 20);
  assert.equal(metric.valid_collection_pct, 100);
  assert.equal(metric.qualified, true, "every gate passed, so the zero may be headlined");
  assert.equal(metric.qualified_pct, 0);

  // One gate failing leaves the raw zero standing and withholds only the
  // headline. The panel keeps its twenty distinct questions; two of the
  // twenty-two PLANNED observations never came back, which is the gate that fails.
  const withheld = summarizeEngineSlice(
    Array.from({ length: 22 }, (_, i) => probeRow(i, { answered: i < 20, names: i < 20 ? "rival" : "nobody" })),
    "aio"
  );
  const gated = withheld.metrics[METRIC_IDS.EXPOSURE];
  assert.equal(gated.distinct_eligible_prompts, 20, "the sample-size gate is satisfied");
  assert.equal(gated.value_pct, 0);
  assert.equal(gated.valid_collection_pct, 90.9);
  assert.equal(gated.qualified, false);
  assert.equal(gated.qualified_pct, null);
  assert.equal(gated.qualified_reason, METRIC_REASONS.INSUFFICIENT_COLLECTION);
});

test("R05-11 — thirty brand-free answers keep a zero mention rate and stay in the panel", () => {
  const rows = Array.from({ length: 30 }, (_, i) => probeRow(i, { names: "nobody" }));
  const slice = summarizeEngineSlice(rows, "aio");

  const mention = slice.metrics[METRIC_IDS.MENTION];
  assert.equal(mention.numerator, 0);
  assert.equal(mention.denominator, 30, "the answers are not removed after observation");
  assert.equal(mention.value_pct, 0);
  assert.equal(mention.state, METRIC_STATES.MEASURED_ZERO);
  assert.equal(mention.reason, METRIC_REASONS.BRAND_NOT_VISIBLE);
  assert.equal(exposure(slice).denominator, 30);

  // The CONDITIONAL index has no denominator here — nobody named any vendor — and
  // says so instead of publishing a zero. That contrast is the point of the case:
  // "they never named us" and "they named nobody at all" are different statements.
  assert.equal(slice.eliciting_queries, 0);
  assert.equal(slice.share_of_ai_pct, null);
  assert.equal(slice.metrics[METRIC_IDS.CONDITIONAL_VENDOR_SHARE].value_pct, null);
  assert.equal(slice.metrics[METRIC_IDS.CONDITIONAL_VENDOR_SHARE].reason, METRIC_REASONS.ELICITING_POOL_EMPTY);
});

test("R05-12 — no citation telemetry is an UNKNOWN citation measurement, not a verified uncited zero", () => {
  const deadLegs = Array.from({ length: 20 }, (_, i) => ({
    ...probeRow(i, { names: "self" }),
    engine: "perplexity",
    citations: [],
    references: [],
    citations_state: "unverified",
    citations_state_reason: "search_leg_failed",
  }));
  const unobserved = summarizeEngineSlice(deadLegs, "perplexity").metrics[METRIC_IDS.CITATION];
  assert.equal(unobserved.value_pct, null, "nobody could look, so 'uncited' is not sayable");
  assert.notEqual(unobserved.value_pct, 0);
  assert.equal(unobserved.state, METRIC_STATES.NOT_ASSESSED);
  assert.equal(unobserved.reason, METRIC_REASONS.CITATION_TELEMETRY_ABSENT);
  assert.equal(unobserved.qualified, false);
  assert.equal(unobserved.denominator, 0);
  assert.equal(unobserved.exclusions[0].reason, METRIC_REASONS.CITATION_LIST_UNOBSERVED);
  assert.equal(unobserved.exclusions[0].count, 20);

  // The other direction: lists that WERE read and named nobody are a real zero.
  const observed = Array.from({ length: 20 }, (_, i) => ({
    ...probeRow(i, { names: "self" }),
    engine: "perplexity",
    citations: [],
    references: [{ href: "https://elsewhere.example/roundup", domain: "elsewhere.example" }],
    citations_state: "verified",
  }));
  const uncited = summarizeEngineSlice(observed, "perplexity").metrics[METRIC_IDS.CITATION];
  assert.equal(uncited.denominator, 20);
  assert.equal(uncited.value_pct, 0, "twenty lists read, the brand in none of them");
  assert.equal(uncited.state, METRIC_STATES.MEASURED_ZERO);
  assert.equal(uncited.reason, METRIC_REASONS.BRAND_NOT_CITED);
});

test("R05-13 — a negative mention raises the mention rate and the positive-recommendation numerator does not", () => {
  const positive = probeRow(0, { names: "self", prompt: "which is best" });
  const rivalOnly = probeRow(1, { names: "rival", prompt: "alternatives to consider" });
  const negative = {
    ...probeRow(2, { names: "self", prompt: "is acme reliable", relationship: "discouraged" }),
    text: "Acme is unreliable and slow.",
    brands: [
      { name: SELF, is_self: true, mentioned: true, position: 2, sentiment: 0, relationship: "discouraged" },
      { name: RIVAL, is_self: false, mentioned: true, position: 1, sentiment: 100 },
    ],
  };

  const before = summarizeEngineSlice([positive, rivalOnly], "aio");
  const after = summarizeEngineSlice([positive, rivalOnly, negative], "aio");

  assert.equal(before.metrics[METRIC_IDS.MENTION].numerator, 1);
  assert.equal(after.metrics[METRIC_IDS.MENTION].numerator, 2, "a negative mention is still a mention");
  assert.equal(before.metrics[METRIC_IDS.RECOMMENDATION].numerator, 1, "the positive answer recommended the brand");
  assert.equal(
    after.metrics[METRIC_IDS.RECOMMENDATION].numerator,
    1,
    "adding a DISCOURAGED mention must not raise the positive-recommendation numerator"
  );
  assert.equal(after.metrics[METRIC_IDS.RECOMMENDATION].denominator, 3, "the negative answer is still eligible for the rate");

  // A neutral sentiment is not a positive recommendation either, and an explicit
  // relationship label outranks the numeric sentiment when both are present.
  const neutral = { ...probeRow(3, { names: "self" }), brands: [{ name: SELF, is_self: true, mentioned: true, position: 1, sentiment: 50 }] };
  const labelled = {
    ...probeRow(4, { names: "self" }),
    brands: [{ name: SELF, is_self: true, mentioned: true, position: 1, sentiment: 0, relationship: "recommended" }],
  };
  const mixed = summarizeEngineSlice([neutral, labelled], "aio").metrics[METRIC_IDS.RECOMMENDATION];
  assert.equal(mixed.numerator, 1, "only the explicitly recommended answer counts as positive");
  assert.equal(mixed.denominator, 2);
});

test("R05-15 — property checks: bounds, numerator ≤ denominator, stable rounding, null only for declared reasons", () => {
  /** Deterministic PRNG: a failing case must be reproducible from the seed alone. */
  function seeded(seed) {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  }
  const nextInt = (random, max) => Math.floor(random() * (max + 1));
  const KNOWN_REASONS = new Set(Object.values(METRIC_REASONS));
  const KNOWN_STATES = new Set(Object.values(METRIC_STATES));
  const random = seeded(20261016);

  for (let i = 0; i < 400; i++) {
    const denominator = nextInt(random, 40);
    const numerator = nextInt(random, 40);
    const distinct = nextInt(random, denominator);
    const planned = nextInt(random, 40);
    const valid = nextInt(random, planned);
    const metric = createMetric({
      metricId: METRIC_IDS.EXPOSURE,
      numerator,
      denominator,
      eligiblePromptIds: Array.from({ length: distinct }, (_, p) => `p${p}`),
      collection: { valid, planned },
      context: measurementContext({ market: "in" }),
      unit: METRIC_UNITS.PERCENT,
    });
    const label = `case ${i}: ${numerator}/${denominator}, ${distinct} prompts, ${valid}/${planned}`;

    assert.ok(KNOWN_STATES.has(metric.state), `${label} — unknown state ${metric.state}`);
    assert.ok(
      metric.value_pct === null || (metric.value_pct >= 0 && metric.value_pct <= 100),
      `${label} — value_pct ${metric.value_pct} is outside 0-100`
    );
    assert.ok(metric.qualified_pct === null || metric.qualified_pct === metric.value_pct, `${label} — qualified value diverged`);
    assert.ok(
      metric.value_pct === null || metric.reason === null || KNOWN_REASONS.has(metric.reason),
      `${label} — undeclared reason ${metric.reason}`
    );
    if (metric.value_pct === null) {
      assert.ok(KNOWN_REASONS.has(metric.reason), `${label} — a null value must carry a declared reason`);
    }

    if (denominator === 0) {
      assert.equal(metric.value_pct, null, `${label} — an empty denominator has no percentage`);
    } else if (numerator > denominator) {
      assert.equal(metric.value_pct, null, `${label} — impossible counts produce no ratio`);
      assert.equal(metric.reason, METRIC_REASONS.CONTRADICTORY_COUNTS);
      assert.ok(metric.contradictions.length > 0, `${label} — the contradiction must be recorded`);
    } else {
      assert.equal(
        metric.value_pct,
        Math.round((numerator / denominator) * 1000) / 10,
        `${label} — rounding must be stable to one decimal`
      );
      assert.ok(metric.numerator <= metric.denominator, `${label} — numerator exceeded denominator`);
    }

    if (metric.qualified) {
      assert.ok(metric.value_pct !== null, `${label} — a qualified headline needs a value`);
      assert.ok(metric.distinct_eligible_prompts >= ELIGIBILITY_POLICY_V1.minDistinctEligiblePrompts, `${label}`);
      assert.ok(metric.valid_collection_pct >= ELIGIBILITY_POLICY_V1.minValidCollection, `${label}`);
    }
  }
});
