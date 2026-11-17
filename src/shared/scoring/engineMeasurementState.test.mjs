import test from "node:test";
import assert from "node:assert/strict";
import {
  computeHeadline,
  describeScanDataSourceIssue,
  ENGINE_MEASUREMENT_STATE,
  ENGINE_STATE_REASONS,
  isMeasuredEngineSlice,
  summarizeEngineResults,
  summarizeEngineSlice,
} from "./enginePipeline.js";

/**
 * R2.1.1 (findings A1/S1) — a per-engine summary says which of four states it
 * is in, and stops reporting a number in the two states where there isn't one.
 *
 * THE BUG. `share_of_ai_pct` was `visibilityPct`, and `visibilityPct` is 0
 * whenever the eliciting pool is empty — because the guard above it returns 0
 * for a 0-length denominator rather than dividing. So all of these rendered an
 * identical "0%" bar on the dashboard:
 *
 *   - the engine that was never probed at all (no rows),
 *   - the engine whose thirty answers named no vendor whatsoever (a prompt-set
 *     failure that has nothing to do with the brand),
 *   - the engine that errored on every request,
 *   - the engine that WAS measured over a real pool and genuinely never got
 *     named — the only one of the four that is a fact about the brand.
 *
 * Standing rule 1 in its purest form: a measured zero must look different from
 * never-ran. These tests are the four states, the reason each carries, and the
 * two places the null must not be laundered back into a 0.
 *
 * Every row builder here produces the shape summarizeEngineSlice actually
 * consumes (a probe result with `brands` from judgeBrandsSymmetric), so these
 * exercise the real function, not a restatement of it.
 */

const SELF = "Italica";
const RIVAL = "Kajaria";

/** An answered non-branded probe. `named` = did the answer name the RIVAL. */
function answered(i, { visible = false, named = true } = {}) {
  return {
    query: `unbranded prompt ${i}`,
    is_branded_query: false,
    answer_present: true,
    error: null,
    text: "some answer",
    visible,
    brand_mentioned_in_text: visible,
    brand_cited: false,
    // The rival ENTRY is always present (that is the roster), so the
    // self-only-roster fallback never fires and the eliciting filter is live.
    // `mentioned` is what makes the prompt eliciting.
    brands: [
      { name: SELF, is_self: true, mentioned: visible },
      { name: RIVAL, is_self: false, mentioned: named },
    ],
  };
}

/** What R2.2.1 writes for an empty/whitespace/null answer body. */
function emptyAnswer(i) {
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

function times(n, fn) {
  return Array.from({ length: n }, (_, i) => fn(i));
}

// --- the vocabulary ------------------------------------------------------

test("the state enum is the four states R2 scores against, and it is frozen", () => {
  assert.deepEqual(Object.values(ENGINE_MEASUREMENT_STATE).sort(), [
    "failed",
    "measured",
    "measured_zero",
    "not_assessed",
  ]);
  assert.ok(Object.isFrozen(ENGINE_MEASUREMENT_STATE), "the enum must not be mutable at runtime");
  assert.ok(Object.isFrozen(ENGINE_STATE_REASONS));
});

// --- state 1 of 4: measured ---------------------------------------------

test("measured — a real pool with real mentions reports a number and no reason", () => {
  const rows = [...times(2, (i) => answered(i, { visible: true })), ...times(8, (i) => answered(100 + i))];
  const s = summarizeEngineSlice(rows, "aio");

  assert.equal(s.eliciting_queries, 10, "premise: every answer named a vendor");
  assert.equal(s.state, ENGINE_MEASUREMENT_STATE.MEASURED);
  assert.strictEqual(s.state_reason, null, "nothing to explain when there is a number");
  assert.equal(s.share_of_ai_pct, 20);
  assert.equal(s.visibility_pct, 20, "the alias must not disagree with share_of_ai_pct");
  assert.equal(isMeasuredEngineSlice(s), true);
});

// --- state 2 of 4: measured_zero ----------------------------------------

test("measured_zero — a real pool that never named us is 0, NOT null", () => {
  // The one state where 0 is the honest answer: ten answers, all naming a
  // vendor, none naming us. Blanking this would hide a real finding.
  const s = summarizeEngineSlice(times(10, (i) => answered(i, { visible: false })), "aio");

  assert.equal(s.eliciting_queries, 10);
  assert.equal(s.state, ENGINE_MEASUREMENT_STATE.MEASURED_ZERO);
  assert.equal(s.state_reason, ENGINE_STATE_REASONS.BRAND_NOT_VISIBLE);
  assert.strictEqual(s.share_of_ai_pct, 0, "a measured zero is a number, not a null");
  assert.strictEqual(s.visibility_pct, 0);
  assert.equal(isMeasuredEngineSlice(s), true, "0 is a measurement and must still be blended");
});

// --- state 3 of 4: not_assessed -----------------------------------------

test("not_assessed — an empty eliciting pool reports null plus a reason (the accept case)", () => {
  // Thirty answers, every one of them a how-to that named nobody. The engine
  // worked, the brand was not the problem, and there is no denominator.
  const s = summarizeEngineSlice(times(30, (i) => answered(i, { named: false })), "aio");

  assert.equal(s.non_branded_with_answer, 30, "premise: the engine answered everything");
  assert.equal(s.eliciting_queries, 0, "...and not one answer named a vendor");
  assert.equal(s.data_source_issue, false, "premise: this is NOT a degraded read");

  assert.equal(s.state, ENGINE_MEASUREMENT_STATE.NOT_ASSESSED);
  assert.equal(s.state_reason, ENGINE_STATE_REASONS.EMPTY_ELICITING_POOL);
  assert.strictEqual(s.share_of_ai_pct, null, "never 0 — the brand was never given a chance");
  assert.strictEqual(s.visibility_pct, null);
  assert.equal(isMeasuredEngineSlice(s), false);
});

test("not_assessed — a slice with no rows at all says so", () => {
  const s = summarizeEngineSlice([], "perplexity");
  assert.equal(s.state, ENGINE_MEASUREMENT_STATE.NOT_ASSESSED);
  assert.equal(s.state_reason, ENGINE_STATE_REASONS.NO_RESULTS);
  assert.strictEqual(s.share_of_ai_pct, null);
  // The pre-existing contract for an empty slice is untouched.
  assert.equal(s.data_source_issue, false, "never-ran is not a degraded read");
  assert.equal(s.insufficient_sample, true);
});

test("not_assessed — a branded-only slice probed nothing scoreable", () => {
  const s = summarizeEngineSlice(
    [{ query: "italica tiles", is_branded_query: true, answer_present: true, error: null, visible: true, brands: [] }],
    "perplexity"
  );
  assert.equal(s.state, ENGINE_MEASUREMENT_STATE.NOT_ASSESSED);
  assert.equal(s.state_reason, ENGINE_STATE_REASONS.NO_NON_BRANDED_PROMPTS);
  assert.strictEqual(s.share_of_ai_pct, null);
});

// --- state 4 of 4: failed ------------------------------------------------

test("failed — an engine that errored past its gate reports null, not a survivors' ratio", () => {
  const s = summarizeEngineSlice(times(10, (i) => emptyAnswer(i)), "aio");
  assert.equal(s.error_rate_pct, 100);
  assert.equal(s.data_source_issue, true);
  assert.equal(s.state, ENGINE_MEASUREMENT_STATE.FAILED);
  assert.equal(s.state_reason, ENGINE_STATE_REASONS.HIGH_ERROR_RATE);
  assert.strictEqual(s.share_of_ai_pct, null);
});

test("failed — a degraded text slice reports null even though the survivors say 100%", () => {
  // Six of ten answered and all six name us: a flattering 100 read off a
  // broken collection. computeHeadline already refused to blend it; the SLICE
  // itself used to keep publishing the number to every other surface.
  const rows = [...times(6, (i) => answered(200 + i, { visible: true })), ...times(4, (i) => emptyAnswer(300 + i))];
  const s = summarizeEngineSlice(rows, "perplexity");

  assert.equal(s.coverage_pct, 60, "premise: below the 90% a text engine needs");
  assert.ok(s.error_rate_pct <= 50, "premise: the error-rate arm is NOT what fired");
  assert.equal(s.data_source_issue, true);
  assert.equal(s.state, ENGINE_MEASUREMENT_STATE.FAILED);
  assert.equal(s.state_reason, ENGINE_STATE_REASONS.LOW_COVERAGE, "the reason names the arm that fired");
  assert.strictEqual(s.share_of_ai_pct, null, "a 100% off a broken slice is the worst number to publish");
});

test("failed — the error-rate arm wins when BOTH arms fire, because that is the fixable one", () => {
  // An all-errored slice has coverage 0 too. Reporting it as low_coverage
  // would send the operator to rewrite a prompt set that was never the problem.
  const s = summarizeEngineSlice(times(10, (i) => emptyAnswer(i)), "aio");
  assert.equal(s.coverage_pct, 0, "premise: the coverage arm would also fire");
  assert.equal(s.state_reason, ENGINE_STATE_REASONS.HIGH_ERROR_RATE);
});

test("a slice that answered NOTHING is failed/low_coverage — there is no 'no_answers' state", () => {
  // Teeth for a reason deliberately NOT declared: zero coverage is below every
  // engine class's floor, so this case can only ever be `failed`. If a gate
  // ever moves to 0 this test fails and the enum needs the missing reason.
  const unanswered = times(10, (i) => ({
    query: `unbranded prompt ${i}`,
    is_branded_query: false,
    answer_present: false,
    error: null,
    visible: false,
    brands: [],
  }));
  const s = summarizeEngineSlice(unanswered, "aio");
  assert.equal(s.errored_queries, 0, "premise: nothing errored, they just did not answer");
  assert.equal(s.state, ENGINE_MEASUREMENT_STATE.FAILED);
  assert.equal(s.state_reason, ENGINE_STATE_REASONS.LOW_COVERAGE);
  assert.strictEqual(s.share_of_ai_pct, null);
});

// --- no declared reason is unreachable -----------------------------------

test("every declared state_reason is produced by a real slice — no dead vocabulary", () => {
  const produced = new Set(
    [
      summarizeEngineSlice([], "aio"),
      summarizeEngineSlice(
        [{ query: "italica tiles", is_branded_query: true, answer_present: true, error: null, visible: true, brands: [] }],
        "aio"
      ),
      summarizeEngineSlice(times(30, (i) => answered(i, { named: false })), "aio"),
      summarizeEngineSlice(times(10, (i) => emptyAnswer(i)), "aio"),
      summarizeEngineSlice(
        [...times(6, (i) => answered(200 + i, { visible: true })), ...times(4, (i) => emptyAnswer(300 + i))],
        "perplexity"
      ),
      summarizeEngineSlice(times(10, (i) => answered(i)), "aio"),
    ]
      .map((s) => s.state_reason)
      .filter(Boolean)
  );

  for (const [key, value] of Object.entries(ENGINE_STATE_REASONS)) {
    assert.ok(
      produced.has(value),
      `ENGINE_STATE_REASONS.${key} ("${value}") is declared but no slice in this file reaches it — ` +
        `either it is dead vocabulary or this file is missing the case that produces it`
    );
  }
});

// --- the null must not be laundered back into a 0 ------------------------

test("the headline does not blend a not_assessed slice as a 0", () => {
  // THE REGRESSION THIS GUARDS: `null * weight` is 0 in JS. Without the
  // measured-slice check in computeHeadline, an engine that measured nothing
  // would pull a healthy 40% index down to 20% and the scan would look half as
  // visible for a reason nothing on screen could name.
  const measured = summarizeEngineSlice(
    [...times(4, (i) => answered(i, { visible: true })), ...times(6, (i) => answered(100 + i))],
    "aio"
  );
  const notAssessed = summarizeEngineSlice(times(30, (i) => answered(400 + i, { named: false })), "perplexity");

  assert.equal(measured.share_of_ai_pct, 40, "premise");
  assert.strictEqual(notAssessed.share_of_ai_pct, null, "premise");
  assert.equal(notAssessed.data_source_issue, false, "premise: the OLD filter would have kept it");
  assert.ok(
    notAssessed.non_branded_with_answer >= 5,
    "premise: it clears the answer-count bar too, so only the state check can drop it"
  );

  const headline = computeHeadline([measured, notAssessed]);
  assert.equal(headline.visibility_index_pct, 40, "the index is the measured engine's alone");
  assert.equal(headline.engines_counted, 1, "...and it says it counted one engine, not two");
});

test("a measured_zero engine IS blended — suppressing it would flatter the score", () => {
  const measured = summarizeEngineSlice(
    [...times(4, (i) => answered(i, { visible: true })), ...times(6, (i) => answered(100 + i))],
    "aio"
  );
  const zero = summarizeEngineSlice(times(10, (i) => answered(500 + i)), "perplexity");

  assert.equal(zero.state, ENGINE_MEASUREMENT_STATE.MEASURED_ZERO, "premise");
  const headline = computeHeadline([measured, zero]);
  assert.equal(headline.engines_counted, 2, "a real 0 is evidence and must stay in the blend");
  assert.equal(headline.visibility_index_pct, 20, "(40 + 0) / 2");
});

test("the banner's engine count stays in lockstep with the headline's", () => {
  // describeScanDataSourceIssue promises to reproduce computeHeadline's own
  // eligibility test, so the "N of M engines" in the banner explains the index
  // beside it. A not_assessed slice next to a degraded one is where the two
  // could drift: the old filter would have counted it and claimed a score the
  // headline never blended.
  const engines = {
    aio: summarizeEngineSlice(times(30, (i) => answered(i, { named: false })), "aio"),
    perplexity: summarizeEngineSlice(
      [...times(6, (i) => answered(200 + i, { visible: true })), ...times(4, (i) => emptyAnswer(300 + i))],
      "perplexity"
    ),
  };
  assert.equal(engines.aio.state, ENGINE_MEASUREMENT_STATE.NOT_ASSESSED, "premise");
  assert.equal(engines.perplexity.state, ENGINE_MEASUREMENT_STATE.FAILED, "premise");

  const headline = computeHeadline(Object.values(engines));
  const d = describeScanDataSourceIssue(engines, { enginesCounted: headline.engines_counted });

  assert.equal(headline.engines_counted, 0);
  assert.strictEqual(headline.visibility_index_pct, null);
  assert.equal(d.enginesCounted, 0, "the banner must not claim an engine the index did not blend");
  assert.equal(d.severity, "critical", "nothing measurable is left to score");
});

// --- the SCAN-LEVEL mirror must not launder the null either ---------------
//
// summarizeEngineResults is not a dead legacy shim. src/server/workers/scanWorker.js
// binds it as `summarizeMulti` (scanWorker.js:1652) and writes its
// summary.visibility_pct / share_of_ai_pct straight onto the persisted `scans`
// row (scanWorker.js:1962-1963). The first cut of R2.1.1 left `|| 0` here and
// claimed in a comment that behaviour was unchanged. It was not: a degraded aio
// slice used to publish its survivors' 100 to that row, and with the slice now
// emitting null the `|| 0` turned it into a 0. That is the same false zero the
// task exists to remove, one level up and persisted.

test("scan-level mirror — a FAILED aio slice publishes null, not 0 and not the survivors' 100", () => {
  // Six answered, all naming us; seven empty. Error rate 53.8% clears aio's 50%
  // gate, so the slice is `failed` while its surviving rows imply a flattering
  // 100% — the exact number the old code shipped to scans.visibility_pct.
  const rows = [...times(6, (i) => answered(i, { visible: true })), ...times(7, (i) => emptyAnswer(100 + i))];
  const aio = summarizeEngineSlice(rows, "aio");

  assert.equal(aio.state, ENGINE_MEASUREMENT_STATE.FAILED, "premise");
  assert.equal(aio.state_reason, ENGINE_STATE_REASONS.HIGH_ERROR_RATE, "premise");
  assert.equal(aio.eliciting_queries, 6, "premise: the survivors are a real pool...");
  assert.equal(aio.visible_non_branded, 6, "...and every one of them named us, so the raw ratio is 100");

  const headline = computeHeadline([aio]);
  const { summary } = summarizeEngineResults({ results: [], engines: { aio }, headline });

  assert.strictEqual(summary.visibility_pct, null, "a broken read has no visibility number to publish");
  assert.notStrictEqual(summary.visibility_pct, 0, "0 is the laundered lie this task removes");
  assert.notStrictEqual(summary.visibility_pct, 100, "and 100 is the pre-R2.1.1 lie it replaced");
  assert.strictEqual(summary.share_of_ai_pct, null);
  // ...and the row can say WHY there is no number.
  assert.equal(summary.state, ENGINE_MEASUREMENT_STATE.FAILED);
  assert.equal(summary.state_reason, ENGINE_STATE_REASONS.HIGH_ERROR_RATE);
});

test("scan-level mirror — a NOT_ASSESSED aio slice publishes null, not 0", () => {
  // Thirty answers naming nobody: the engine was fine, the prompt set elicited
  // no vendor, and there is no denominator. This one always read 0 downstream,
  // which is why it was invisible.
  const aio = summarizeEngineSlice(times(30, (i) => answered(i, { named: false })), "aio");

  assert.equal(aio.state, ENGINE_MEASUREMENT_STATE.NOT_ASSESSED, "premise");
  assert.equal(aio.state_reason, ENGINE_STATE_REASONS.EMPTY_ELICITING_POOL, "premise");

  const headline = computeHeadline([aio]);
  const { summary } = summarizeEngineResults({ results: [], engines: { aio }, headline });

  assert.strictEqual(summary.visibility_pct, null, "never 0 — the brand was never given a chance");
  assert.strictEqual(summary.share_of_ai_pct, null);
  assert.equal(summary.state, ENGINE_MEASUREMENT_STATE.NOT_ASSESSED);
  assert.equal(summary.state_reason, ENGINE_STATE_REASONS.EMPTY_ELICITING_POOL);
});

test("scan-level mirror — a real measurement still publishes its number", () => {
  // The other half of the contract: `?? null` must not blank a measured 0 or a
  // measured 40. Without this, "emit null" is satisfiable by emitting null
  // always, and every score on the product goes to an em dash.
  const measured = summarizeEngineSlice(
    [...times(4, (i) => answered(i, { visible: true })), ...times(6, (i) => answered(100 + i))],
    "aio"
  );
  const zero = summarizeEngineSlice(times(10, (i) => answered(500 + i)), "aio");

  const m = summarizeEngineResults({
    results: [],
    engines: { aio: measured },
    headline: computeHeadline([measured]),
  }).summary;
  assert.strictEqual(m.visibility_pct, 40);
  assert.strictEqual(m.share_of_ai_pct, 40);
  assert.equal(m.state, ENGINE_MEASUREMENT_STATE.MEASURED);
  assert.strictEqual(m.state_reason, null);

  const z = summarizeEngineResults({
    results: [],
    engines: { aio: zero },
    headline: computeHeadline([zero]),
  }).summary;
  assert.strictEqual(z.visibility_pct, 0, "a measured zero is a number and must survive the mirror");
  assert.strictEqual(z.share_of_ai_pct, 0);
  assert.equal(z.state, ENGINE_MEASUREMENT_STATE.MEASURED_ZERO);
});

test("scan-level mirror — a pre-R2.1.1 slice with no state carries a null state, never an invented one", () => {
  // The legacy tolerance isMeasuredEngineSlice grants (a finite number with no
  // state reads as measured) must not become a manufactured `state: "measured"`
  // on the scan row. A stored scan that never knew its state must still say so.
  const { summary } = summarizeEngineResults({
    results: [],
    engines: { aio: { engine: "aio", visibility_pct: 12.5, share_of_ai_pct: 12.5, non_branded_with_answer: 10 } },
    headline: null,
  });
  assert.strictEqual(summary.visibility_pct, 12.5, "a legacy number is still published");
  assert.strictEqual(summary.state, null);
  assert.strictEqual(summary.state_reason, null);
});

test("isMeasuredEngineSlice — a pre-R2.1.1 summary with no state is read as measured", () => {
  // Slices persisted before this task carry a number and no state. Treating
  // them as unmeasured would blank scores that were real.
  assert.equal(isMeasuredEngineSlice({ share_of_ai_pct: 12.5 }), true);
  assert.equal(isMeasuredEngineSlice({ share_of_ai_pct: 0 }), true, "a legacy 0 is still counted, as it always was");
  assert.equal(isMeasuredEngineSlice({ share_of_ai_pct: null }), false);
  assert.equal(isMeasuredEngineSlice(null), false);
  assert.equal(
    isMeasuredEngineSlice({ state: ENGINE_MEASUREMENT_STATE.FAILED, share_of_ai_pct: 100 }),
    false,
    "a state present on the slice outranks the number next to it"
  );
});
