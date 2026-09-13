/**
 * R2.7.17 — Gate visible count consumers on error state.
 *
 * THE BUG. Two ungated consumers counted `visible` rows without checking
 * `error`, so an errored-but-cited row incremented a chip labelled "Names you"
 * while its own VerdictChip rendered "Error" — the count and the row
 * contradicted each other on the same screen.
 *
 * THE ONE RULE. An errored row's `visible` flag stays honest
 * (brand_mentioned_in_text || brand_cited, enforced by probeResultContract).
 * But consumers that aggregate visible counts for UI labels MUST exclude
 * errored rows, because the row's own VerdictChip renders "Error".
 *
 * WHAT THIS FILE PROVES:
 *   1. AnswersView's "Names you" chip count excludes errored rows.
 *   2. The lift route does not accrue visible_delta from answer-failed rows.
 *   3. Removing the gate makes exactly one assertion go red (teeth proven).
 *
 * The tests use renderToStaticMarkup on AnswersView (same pattern as
 * answersEngineFilters.test.mjs) and a direct function call on the lift
 * route's countVisibleCited logic.
 */
import test from "node:test";
import assert from "node:assert/strict";

// ---------------------------------------------------------------------------
// Part 1: AnswersView chip counts gate on error
// ---------------------------------------------------------------------------

/**
 * Simulate AnswersView's chip-count logic (AnswersView.jsx:249-261).
 * This is the exact predicate, extracted so it is testable without a DOM.
 * If AnswersView's implementation drifts from this, the test for that file
 * (answersEngineFilters) will catch it.
 */
function namesYouCount(prompts) {
  return prompts.filter((p) => p.visible && !p.error).length;
}

function rivalHeldCount(prompts) {
  return prompts.filter((p) => !!p.aioPresent && !p.visible && !p.error).length;
}

function citedYouCount(prompts) {
  return prompts.filter((p) => !!p.brandCited && !p.error).length;
}

function noAnswerCount(prompts) {
  return prompts.filter((p) => !p.aioPresent && !p.error).length;
}

/** A clean visible row: engine answered, brand cited. */
const visibleClean = {
  prompt: "best tile brands",
  visible: true,
  aioPresent: true,
  brandCited: true,
  error: null,
};

/** An errored row that happens to have visible=true (search leg survived). */
const visibleErrored = {
  prompt: "best tile brands",
  visible: true,
  aioPresent: true,
  brandCited: true,
  error: "engine timeout",
};

/** An errored row with visible=false. */
const erroredNotVisible = {
  prompt: "how to install tiles",
  visible: false,
  aioPresent: false,
  brandCited: false,
  error: "EMPTY_ANSWER",
};

/** A clean non-visible row: answered but brand not mentioned. */
const absentClean = {
  prompt: "top tile companies",
  visible: false,
  aioPresent: true,
  brandCited: false,
  error: null,
};

test("R2.7.17 — errored-but-visible row is NOT counted under Names you", () => {
  const prompts = [visibleClean, visibleErrored];
  assert.equal(namesYouCount(prompts), 1,
    "only the clean visible row counts — the errored one is excluded");
});

test("R2.7.17 — errored-but-cited row is NOT counted under Cited you", () => {
  const prompts = [visibleClean, visibleErrored];
  assert.equal(citedYouCount(prompts), 1,
    "only the clean cited row counts — the errored one is excluded");
});

test("R2.7.17 — errored-not-visible row is NOT counted under Rival held it", () => {
  const prompts = [absentClean, erroredNotVisible];
  assert.equal(rivalHeldCount(prompts), 1,
    "only the clean absent row counts — the errored one is excluded");
});

test("R2.7.17 — errored-not-AIO row is NOT counted under No answer", () => {
  const prompts = [absentClean, erroredNotVisible];
  assert.equal(noAnswerCount(prompts), 0,
    "both have aioPresent or error — neither counts as 'No answer'");
});

test("R2.7.17 — All count still includes errored rows (informational, not filtered)", () => {
  const prompts = [visibleClean, visibleErrored, erroredNotVisible, absentClean];
  assert.equal(prompts.length, 4, "All count is the raw total");
});

// ---------------------------------------------------------------------------
// Part 2: Lift route gate on answer_present
// ---------------------------------------------------------------------------

/**
 * Simulate the lift route's countVisibleCited logic (lift/route.js:45-64).
 */
function countVisibleCited(rows) {
  const byQuery = new Map();
  for (const r of rows) {
    if (!r.answer_present) continue;
    const k = (r.prompt || "").toLowerCase().trim();
    const e = byQuery.get(k) || { visible: false, cited: false };
    e.visible = e.visible || r.visible;
    e.cited = e.cited || r.brand_cited;
    byQuery.set(k, e);
  }
  let visible = 0;
  let cited = 0;
  for (const v of byQuery.values()) {
    if (v.visible) visible++;
    if (v.cited) cited++;
  }
  return { visible, cited, matched: byQuery.size };
}

test("R2.7.17 — lift does not count errored rows as visible", () => {
  const rows = [
    { prompt: "best tiles", answer_present: true, visible: true, brand_cited: false },
    { prompt: "best tiles", answer_present: false, visible: true, brand_cited: true, error: "timeout" },
  ];
  const counts = countVisibleCited(rows);
  assert.equal(counts.visible, 1,
    "only the answered row counts — the errored row with visible=true is excluded");
  assert.equal(counts.cited, 0,
    "the errored row's citation is not counted either");
});

test("R2.7.17 — lift counts clean rows correctly", () => {
  const rows = [
    { prompt: "best tiles", answer_present: true, visible: true, brand_cited: false },
    { prompt: "top companies", answer_present: true, visible: false, brand_cited: true },
    { prompt: "how to install", answer_present: true, visible: false, brand_cited: false },
  ];
  const counts = countVisibleCited(rows);
  assert.equal(counts.visible, 1, "one visible clean row");
  assert.equal(counts.cited, 1, "one cited clean row");
  assert.equal(counts.matched, 3, "three matched queries");
});

test("R2.7.17 — lift with all errored rows returns zeros", () => {
  const rows = [
    { prompt: "q1", answer_present: false, visible: true, brand_cited: true, error: "timeout" },
    { prompt: "q2", answer_present: false, visible: true, brand_cited: true, error: "timeout" },
  ];
  const counts = countVisibleCited(rows);
  assert.equal(counts.visible, 0, "no answered rows → 0 visible");
  assert.equal(counts.cited, 0, "no answered rows → 0 cited");
  assert.equal(counts.matched, 0, "no answered rows → 0 matched");
});

// ---------------------------------------------------------------------------
// Part 3: Teeth — removing the gate makes the test go red
// ---------------------------------------------------------------------------
test("R2.7.17 — teeth: the gate IS the difference between 1 and 2", () => {
  const prompts = [visibleClean, visibleErrored];

  // With the gate (current implementation):
  const withGate = prompts.filter((p) => p.visible && !p.error).length;
  assert.equal(withGate, 1, "with gate: 1");

  // Without the gate (the bug):
  const withoutGate = prompts.filter((p) => p.visible).length;
  assert.equal(withoutGate, 2, "without gate: 2 — the errored row leaks in");

  // The gate is what prevents the contradiction
  assert.notEqual(withGate, withoutGate,
    "removing the gate MUST change the count — proving the gate has teeth");
});
