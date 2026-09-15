import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { normalizeResult, countCompetitorsFound } from "./api.js";

/**
 * R2.1.2 (finding S1) — THE NORMALIZE LAYER MAY NOT COALESCE A METRIC TO ZERO.
 *
 * THE BUG. `services/api.js` is the last thing a stored scan passes through
 * before the dashboard reads it, and it ended with a block of
 * `x = x ?? 0` assignments over `visibilityPct`, `mentionRatePct`,
 * `brandedVisibilityPct`, `aioCoveragePct`, `aioErrorRatePct` and
 * `presenceRatePct`. R2.1.1 had already taught the producers to publish `null`
 * for a reading that does not exist — an engine that never ran, an eliciting
 * pool that named no vendor, a read too broken to trust — and this block turned
 * every one of those nulls back into a confident 0 one statement before the
 * returned object. "The answers never named us" and "0% of answers named you"
 * are different facts (standing rules 1 and 5), and after this block they were
 * the same number.
 *
 * WHAT THIS FILE PROVES, AND HOW.
 *
 *   1. BY EXECUTION. `normalizeResult` is run on a record whose summary carries
 *      nulls, and every metric it returns must still be null. The same record
 *      with real zeroes must come back as zeroes — so a fix that blanks
 *      everything fails just as hard as the coalesce did.
 *   2. BY SOURCE GUARD. Every `?? 0` / `|| 0` left in api.js must appear in
 *      ALLOWED_ZERO_COALESCE below WITH A REASON. This is the reintroduction
 *      guard the accept criterion asks for: a new coalesce on a metric fails
 *      the test, and silencing it means writing down, in this file, why the
 *      value is not a measurement. The allowlist is itself checked for dead
 *      entries, so it cannot quietly outgrow the code.
 *
 * WHAT IT DOES NOT PROVE, said rather than implied.
 *
 *   - It does not follow the nulls to the screen. OverviewView.jsx
 *     (`Math.round(aioCoverage ?? 0)`, `Math.round(presenceRate ?? 0)`) and
 *     DashboardShell.jsx (`${result.aioCoveragePct ?? 0}%`) apply their OWN
 *     coalesce, so those surfaces still print a zero. They belong to R2.7.12,
 *     which is in flight in this same tree and is why they are cited by
 *     expression rather than by line. The lie is no longer told by the
 *     normalize layer, which is what this accept criterion is about.
 *   - OverviewView.jsx renders `{tier} · {heroScore ?? result.visibilityScore}%`
 *     with NO zero-coalesce and no finite check, so a null hero now reaches it
 *     as a bare "%". That line is NOT in R2.7.12's spec and is reported as its
 *     own follow-up rather than reached into from here.
 *   - `recomputeFromResults` and the brand-presence block above the deleted
 *     assignments still write `0` from a `denominator > 0 ? ratio : 0` ternary.
 *     That is the same lie in a different construct and a genuinely separate
 *     change with its own blast radius; see the dead-coalesce test at the
 *     bottom, which pins today's behaviour so the follow-up can be seen to
 *     change it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const API_PATH = path.join(HERE, "api.js");

/** Comments blanked (not deleted, so line numbers survive) so the guard reads code. */
function codeOnly(source) {
  const blank = (m) => m.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (m, p) => p + blank(m.slice(p.length)));
}

const ZERO_COALESCE = /\?\?\s*0\b|\|\|\s*0\b/;

function zeroCoalesceLines() {
  return codeOnly(readFileSync(API_PATH, "utf8"))
    .split("\n")
    .map((text, i) => ({ line: i + 1, text: text.trim() }))
    .filter(({ text }) => ZERO_COALESCE.test(text));
}

/**
 * The ONLY zero-coalesces api.js is allowed to contain, and why each one is not
 * the defect. The rule they all satisfy: the value is a COUNT of things (rows,
 * prompts, engines) or a NaN guard — never a measurement of the brand.
 *
 * Adding an entry here is how you argue with this test. Do it in a review, in
 * writing, on the record; do not widen the regex.
 */
const ALLOWED_ZERO_COALESCE = new Map([
  [
    "nonBrandedWithAio = Number(nonBrandedWithAio) || 0;",
    "a denominator: how many non-branded prompts came back with an answer. A count, and `Number(undefined) || 0` is the NaN guard for a record that stored a non-numeric.",
  ],
  [
    "brandPresenceWithAio = Number(brandPresenceWithAio) || 0;",
    "same: a count of brand-presence prompts that were answered.",
  ],
  [
    "visibleNonBranded = Number(visibleNonBranded) || 0;",
    "same: a count of answers the brand appeared in. The RATIO built from it is the metric, and that one is allowed to be null.",
  ],
  [
    "const visibleBranded = Number(visibleBrandPresence) || 0;",
    "same: a count of brand-presence answers the brand appeared in.",
  ],
  [
    ": (data.promptsAnalyzed ?? 0) + brandedPromptsCount);",
    "a count of questions asked, and a NaN guard specifically: `undefined + brandedPromptsCount` is NaN, which would render as 'NaN queries tracked'. (`null + n === n`, so null was never why it is here.)",
  ],
  [
    "enginesCounted: data.engines_counted ?? raw.engines_counted ?? 0,",
    "an inventory of engines, not a reading. Load-bearing: describeScanDataSourceIssue's docstring in enginePipeline.js describes this exact default and warns against reading it as authoritative, and its `Number(options.enginesCounted)` cannot tell null from 0 anyway. Making it honest is a change to enginePipeline, filed separately.",
  ],
]);

test("R2.1.2 GUARD — every zero-coalesce left in api.js is declared, with a reason", () => {
  const found = zeroCoalesceLines();

  // Teeth for the whole test: if the scanner stops matching anything, every
  // assertion below is vacuous and a reintroduced `?? 0` sails through.
  assert.ok(
    found.length > 0,
    "the scanner matched nothing at all in api.js — it has stopped reading the file it guards"
  );

  const undeclared = found.filter(({ text }) => !ALLOWED_ZERO_COALESCE.has(text));
  assert.deepEqual(
    undeclared,
    [],
    "a zero-coalesce in services/api.js that is not in ALLOWED_ZERO_COALESCE. If it is a METRIC, delete it — " +
      "an absent measurement is null, and null renders as an em dash plus a state chip (standing rule 5). " +
      "If it is genuinely a count or a NaN guard, add it to the allowlist with the reason."
  );
});

test("R2.1.2 GUARD — the allowlist has no dead entries", () => {
  const present = new Set(zeroCoalesceLines().map(({ text }) => text));
  const dead = [...ALLOWED_ZERO_COALESCE.keys()].filter((k) => !present.has(k));
  assert.deepEqual(
    dead,
    [],
    "an allowlisted line no longer exists in api.js. A stale permission is how an allowlist grows until it " +
      "permits the thing it was written to forbid — delete the entry along with the line."
  );
});

import { assertCorpusIntact } from "../lib/testCorpus.mjs";

test("GUARD TEETH — assertCorpusIntact enforces length floor, uniqueness, and required targets", () => {
  assert.throws(
    () => assertCorpusIntact([], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /under its floor of 1/
  );
  assert.throws(
    () => assertCorpusIntact(["a", "a"], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /repeats/
  );
  assert.throws(
    () => assertCorpusIntact(["a"], "TEST_CORPUS", { floor: 1, required: ["b"], isTuple: false }),
    /no longer contains/
  );
  assert.throws(
    () => assertCorpusIntact([123], "TEST_CORPUS", { floor: 1, isTuple: false }),
    /is not a string/
  );
});

/**
 * The named metrics, as a second and blunter net. The allowlist above is by
 * exact line text, so a reintroduced coalesce that is reformatted (wrapped over
 * two lines, renamed, spaced differently) could slip past it. These identifiers
 * may never sit next to a zero-coalesce anywhere in the file, however written.
 */
const METRIC_IDENTIFIERS = [
  "visibilityPct",
  "visibilityScore",
  "shareOfAiPct",
  "mentionRatePct",
  "citationSharePct",
  "brandCitationSharePct",
  "brandedVisibilityPct",
  "aioCoveragePct",
  "aioErrorRatePct",
  "presenceRatePct",
  "serpCoveragePct",
  "visibilityIndexPct",
  "share_of_ai_pct",
  "visibility_pct",
  "mention_rate_pct",
  "presence_rate_pct",
  "aio_coverage_pct",
  "aio_error_rate_pct",
  "cost_total",
  "costTotal",
  "shareOfVoicePct",
  "share_of_voice_pct",
];

test("GUARD — METRIC_IDENTIFIERS corpus is intact", () => {
  assertCorpusIntact(METRIC_IDENTIFIERS, "METRIC_IDENTIFIERS", {
    floor: 22,
    required: [
      "visibilityPct",
      "visibilityScore",
      "visibilityIndexPct",
      "aioCoveragePct",
      "costTotal",
      "shareOfVoicePct",
    ],
    isTuple: false,
  });
});

test("R2.1.2 GUARD — no named metric is zero-coalesced, however it is written", () => {
  const code = codeOnly(readFileSync(API_PATH, "utf8"));
  const offences = [];
  for (const [i, text] of code.split("\n").entries()) {
    if (!ZERO_COALESCE.test(text)) continue;
    for (const id of METRIC_IDENTIFIERS) {
      if (new RegExp(`\\b${id}\\b`).test(text)) {
        offences.push(`api.js:${i + 1} — ${id} in \`${text.trim()}\``);
      }
    }
  }
  assert.deepEqual(
    offences,
    [],
    "a measurement coalesced to zero. Null is the honest value; the render layer owns the em dash."
  );
});

// ---------------------------------------------------------------------------
// By execution: what normalizeResult actually returns.
// ---------------------------------------------------------------------------

/**
 * A stored scan the way /api/scans/[brand] hands it back. `summary_stats` is
 * where R2.1.1's nulls live (the `scans` table has no state column), and the
 * absent `visibilityScore` is what sends this down the full normalize path
 * rather than the already-normalized one.
 */
function storedScan(summaryStats, extra = {}) {
  return {
    brand: "Acme",
    website: "https://acme.example",
    results: [],
    summary_stats: summaryStats,
    ...extra,
  };
}

/** Every metric R2.1.2 stopped coalescing, and where it lands on the UI object. */
const NULLABLE_METRICS = [
  "visibilityScore",
  "shareOfAiPct",
  "mentionRatePct",
  "brandCitationSharePct",
  "aioCoveragePct",
  "aioErrorRatePct",
  "presenceRatePct",
  "serpCoveragePct",
  "shareOfVoicePct",
  "share_of_voice_pct",
];

test("GUARD — NULLABLE_METRICS corpus is intact", () => {
  assertCorpusIntact(NULLABLE_METRICS, "NULLABLE_METRICS", {
    floor: 10,
    required: [
      "visibilityScore",
      "shareOfAiPct",
      "brandCitationSharePct",
      "aioCoveragePct",
      "shareOfVoicePct",
    ],
    isTuple: false,
  });
});

test("R2.1.2 ACCEPT — a scan that recorded no readings returns null metrics, never 0", () => {
  const result = normalizeResult(
    storedScan({
      visibility_pct: null,
      mention_rate_pct: null,
      citation_share_pct: null,
      aio_coverage_pct: null,
      error_rate_pct: null,
      presence_rate_pct: null,
      share_of_voice_pct: null,
      state: "not_assessed",
      state_reason: "empty_eliciting_pool",
    })
  );

  const actual = Object.fromEntries(NULLABLE_METRICS.map((k) => [k, result[k]]));
  assert.deepEqual(
    actual,
    Object.fromEntries(NULLABLE_METRICS.map((k) => [k, null])),
    "a reading that does not exist must survive normalization as null"
  );
  for (const key of NULLABLE_METRICS) {
    assert.notEqual(result[key], 0, `${key} came back as a confident zero`);
  }
});

test("R2.1.2 — a genuinely measured zero is still a zero (standing rule 1)", () => {
  const measuredZero = normalizeResult(
    storedScan({
      visibility_pct: 0,
      mention_rate_pct: 0,
      citation_share_pct: 0,
      aio_coverage_pct: 0,
      error_rate_pct: 0,
      presence_rate_pct: 0,
      share_of_voice_pct: 0,
      state: "measured_zero",
      state_reason: "brand_not_visible",
    })
  );

  for (const key of NULLABLE_METRICS) {
    assert.equal(
      measuredZero[key],
      0,
      `${key} — deleting the coalesce must not blank a reading that really is 0`
    );
  }

  // The whole point, stated as itself: the two scans must not be the same scan.
  const neverMeasured = normalizeResult(
    storedScan({ visibility_pct: null, mention_rate_pct: null, presence_rate_pct: null })
  );
  assert.notDeepEqual(
    NULLABLE_METRICS.map((k) => measuredZero[k]),
    NULLABLE_METRICS.map((k) => neverMeasured[k]),
    "'measured, and it was zero' must not normalize to the same tuple as 'we never got a number'"
  );
});

test("R2.1.2 — the prose verdict does not call an absent score 'largely invisible'", () => {
  const unmeasured = normalizeResult(
    storedScan({ visibility_pct: null, aio_coverage_pct: null })
  );
  assert.ok(
    !/largely invisible/i.test(unmeasured.summary),
    "a null score fell through generateSummary's ladder (null >= 50 and null >= 20 are both false) " +
      "and became a confident market verdict about a measurement that does not exist"
  );
  assert.match(
    unmeasured.summary,
    /not a score of 0/i,
    "...and the replacement must say WHY there is no number, not just omit one"
  );

  // A real zero keeps the real verdict. Blanking both would be the mirror bug.
  const measuredZero = normalizeResult(storedScan({ visibility_pct: 0, aio_coverage_pct: 0 }));
  assert.match(
    measuredZero.summary,
    /largely invisible/i,
    "a brand that really was named in nothing still gets told so"
  );
});

test("R2.1.2 — a competitor whose metrics were never computed carries null, not 0", () => {
  const result = normalizeResult(
    storedScan({ visibility_pct: 10 }, { competitors: [{ name: "Rival" }] })
  );
  const rival = result.competitors.find((c) => c.name === "Rival");
  assert.ok(rival, "the rival must survive normalization");
  assert.deepEqual(
    {
      mentions: rival.mentions,
      citations: rival.citations,
      prompts: rival.prompts,
      visibilityScore: rival.visibilityScore,
      citationShare: rival.citationShare,
    },
    {
      mentions: null,
      citations: null,
      prompts: null,
      visibilityScore: null,
      citationShare: null,
    },
    "both producers always emit these five as numbers, so an absent one means the rival's share was never " +
      "computed — which is not the same fact as 'this rival appeared in nothing'"
  );

  // The predicate that reads them is unchanged by the nulls.
  assert.equal(
    countCompetitorsFound(result.competitors),
    0,
    "a rival with no computed signal is still not a rival that was found"
  );
  assert.equal(
    countCompetitorsFound([{ name: "R", visibilityScore: null, mentions: 2, citations: null }]),
    1,
    "...and one with a real mention count still is"
  );
});

test("R2.1.2 — engineScores carries null for a slice that published no share", () => {
  const result = normalizeResult(
    storedScan(
      { visibility_pct: null },
      {
        engines: {
          aio: { share_of_ai_pct: 40, state: "measured" },
          perplexity: { share_of_ai_pct: null, state: "failed", state_reason: "high_error_rate" },
        },
      }
    )
  );
  assert.deepEqual(
    result.engineScores,
    { aio: 40, perplexity: null },
    "the `|| 0` this replaced was the same defect wearing a different operator, on the exact metric " +
      "R2.1.1 made nullable"
  );
});

test("R2.1.2 — spend the record never stored is null, not $0 (standing rule 3)", () => {
  const result = normalizeResult(storedScan({ visibility_pct: 10 }));
  assert.equal(result.tokensUsed, null, "a run that did not record a token count did not use zero tokens");
  assert.equal(result.costTotal, null, "...and it did not cost nothing");

  const priced = normalizeResult(
    storedScan({ visibility_pct: 10 }, { tokens_used: 0, cost_total: 0 })
  );
  assert.equal(priced.tokensUsed, 0, "a recorded zero is still a recorded zero");
  assert.equal(priced.costTotal, 0);
});

/**
 * `brandedVisibilityPct`'s `?? 0` was DEAD when it was deleted, and this pins
 * why, so the deletion is visibly a no-op rather than an unproven claim: the
 * brand-presence block at api.js:482 reassigns the variable unconditionally
 * from a `denominator > 0 ? ratio : 0` ternary, so it can never be nullish by
 * the time the coalesce ran.
 *
 * That trailing `: 0` is the SAME lie in a different construct — an
 * unmeasurable branded visibility reported as a confident zero — and it is
 * deliberately left alone here: it is a behaviour change with its own blast
 * radius, filed as its own task. This assertion is the before-picture.
 */
test("R2.1.2 — brandedVisibilityPct's deleted coalesce was unreachable (follow-up recorded)", () => {
  const result = normalizeResult(
    storedScan({ visibility_pct: null, branded_visibility_pct: null })
  );
  assert.equal(
    result.brandedVisibilityPct,
    0,
    "if this is null, the `: 0` ternary at api.js:482 has been fixed — good; update this test and close " +
      "the follow-up. If it throws or is undefined, the unconditional reassignment is gone and the deleted " +
      "coalesce was NOT dead after all."
  );
});
