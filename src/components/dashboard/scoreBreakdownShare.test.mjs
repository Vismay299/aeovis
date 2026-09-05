import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

import * as chartMathModule from "../perceev/charts/chartMath.js";
import * as shareModule from "../perceev/charts/shareOfVoice.js";

const {
  SHARE_STATE,
  NOT_AVAILABLE_LABEL,
  MEASURED_ZERO_LABEL,
  describeShareMetric,
  resolveShareOfVoice,
} = shareModule;

/**
 * R2.7.6 — THE RENDERED SURFACE.
 *
 * ScoreBreakdown.jsx:10 read `result.shareOfVoicePct ?? 0` and printed
 * `${sov}%`. No stage of the pipeline persists a scan-level `shareOfVoicePct`
 * (R2.7.5), so that branch was not an edge case: every scan that ever reached
 * this panel was told it held 0% of the AI mentions. "Nobody measured your
 * share" and "you were named in none of the answers" are different claims and
 * the second is much worse.
 *
 * These tests RENDER the real component (react-dom/server) and assert against
 * the markup a reader would get, not against the source text. A sibling task's
 * source-text guard passed while its component was broken by one inverted
 * ternary; a percent sign that is not in the markup cannot slip past this.
 *
 * WHAT THIS FILE DOES NOT PROVE, stated rather than implied:
 *   - ScoreBreakdown is currently imported by NOTHING (`git grep ScoreBreakdown
 *     -- src` finds only its own definition; docs/plans/production-plan.md E2.4
 *     lists it among the orphaned dashboard components). So this proves the
 *     component tells the truth when mounted, not that a user sees it today.
 *     The finding's "the two surfaces disagree on the same page" is therefore
 *     one surface early, which is recorded here rather than quietly assumed.
 *   - It renders to static markup: no browser, no CSS. It proves the words and
 *     the states reach the DOM, not that they are legible.
 *   - No effects are involved (this component has none), so unlike the
 *     DashboardShell harness there is no useEffect shim and no deviation from
 *     browser render semantics.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPONENT_PATH = path.join(HERE, "ScoreBreakdown.jsx");

/** lucide-react icons: any named export, rendering nothing. */
const anyNullComponent = new Proxy(
  { __esModule: true },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      return () => null;
    },
  }
);

/**
 * framer-motion's `motion.div` as a plain <div>, with the animation props
 * dropped so React does not serialise them into the markup being asserted on.
 */
const motionProxy = new Proxy(
  {},
  {
    get(_target, tag) {
      return function MotionTag(props) {
        const { initial, animate, exit, transition, variants, whileHover, ...rest } = props || {};
        return React.createElement(String(tag), rest);
      };
    },
  }
);

/**
 * Compile and evaluate the REAL ScoreBreakdown.jsx and render it.
 *
 * Substituted: framer-motion and the icon set — neither produces text.
 * NOT substituted: chartMath (the one place a percent sign is formatted) or
 * shareOfVoice (the resolver + the wording under test).
 *
 * There is deliberately NO `@/components/**` catch-all here. The catch-all in
 * the sibling DashboardShell harness stubs every component it is not told
 * about, which would have silently replaced shareOfVoice.js with a Proxy whose
 * describeShareMetric returns a component — and every assertion below would
 * then be measuring the stub. An unknown specifier throws instead.
 */
async function renderScoreBreakdown(result) {
  const source = await readFile(COMPONENT_PATH, "utf8");
  const { code } = transform(source, {
    transforms: ["jsx", "imports"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    filePath: COMPONENT_PATH,
  });

  const reactModule = { ...React, __esModule: true };
  reactModule.default = reactModule;

  const modules = new Map([
    ["react", reactModule],
    ["framer-motion", { __esModule: true, motion: motionProxy, AnimatePresence: ({ children }) => children }],
    ["lucide-react", anyNullComponent],
    ["@/components/perceev/charts/chartMath", { ...chartMathModule, __esModule: true }],
    ["@/components/perceev/charts/shareOfVoice", { ...shareModule, __esModule: true }],
  ]);

  const requireShim = (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    throw new Error(
      `ScoreBreakdown.jsx imports "${specifier}", which this render harness does not resolve. ` +
        `Add it to the map deliberately — a catch-all stub would make these assertions vacuous.`
    );
  };

  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function("require", "module", "exports", "React", code);
  factory(requireShim, module, module.exports, reactModule);

  const Component = module.exports.ScoreBreakdown;
  assert.equal(
    typeof Component,
    "function",
    "ScoreBreakdown.jsx must still export `ScoreBreakdown` for this harness to render"
  );
  return renderToStaticMarkup(React.createElement(Component, { result }));
}

/** Strip tags so an assertion about wording is not defeated by markup. */
function textOf(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The markup of one metric card. The four cards are siblings, so slicing at
 * each card's opening marker isolates a card's own subtree (the last slice
 * carries the grid's closing tags, which contain no text).
 */
function cardFor(html, metricKey) {
  const chunks = html.split('data-testid="score-breakdown-metric"');
  const hit = chunks.find((c) => c.includes(`data-metric="${metricKey}"`));
  assert.ok(hit, `no metric card rendered for "${metricKey}"`);
  return hit;
}

/** A normalized scan record, with whatever share evidence the caller supplies. */
function scanResult(overrides = {}) {
  return {
    brand: "Zouk",
    visibilityScore: 42,
    mentionRatePct: 38,
    brandCitationSharePct: 12,
    rosterSource: "extracted",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. THE ACCEPT TEST. A result with no shareOfVoicePct must not produce a
//    percentage anywhere on the share card.
// ---------------------------------------------------------------------------

test("ACCEPT — a scan with no shareOfVoicePct renders no share percentage at all", async () => {
  const result = scanResult();
  assert.equal(result.shareOfVoicePct, undefined, "the fixture must not carry the field");

  const html = await renderScoreBreakdown(result);
  const card = cardFor(html, "share_of_voice");

  assert.ok(
    !card.includes("%"),
    `an unmeasured share must print no percentage; card markup was: ${textOf(card).slice(0, 300)}`
  );
  assert.ok(!textOf(card).includes("0%"), "the exact string the finding is about must be gone");
  assert.ok(textOf(card).includes("—"), "an unmeasured share renders an em dash");
  assert.ok(
    card.includes('data-metric-measured="false"'),
    "the card must declare that nothing was measured"
  );
  assert.ok(
    textOf(card).includes(NOT_AVAILABLE_LABEL),
    "the em dash must be accompanied by the state chip the donut uses"
  );
  assert.ok(
    textOf(card).includes("not the same as a 0% share") ||
      textOf(card).includes("never computed"),
    "the card must say WHY there is no number"
  );
});

test("ACCEPT — the same vocabulary the donut uses, not a second set of words", async () => {
  const result = scanResult();
  const html = await renderScoreBreakdown(result);
  const card = cardFor(html, "share_of_voice");
  const resolved = resolveShareOfVoice(result);

  assert.equal(resolved.state, SHARE_STATE.UNAVAILABLE);
  assert.ok(
    card.includes(`data-share-state="${resolved.state}"`),
    "the card must carry the resolver's own state, so the two surfaces cannot drift"
  );
  assert.ok(
    textOf(card).includes(resolved.detail),
    "the sentence on screen must be the resolver's sentence, verbatim — the donut renders the same one"
  );
});

// ---------------------------------------------------------------------------
// 2. A MEASURED ZERO IS A DIFFERENT OBJECT ON SCREEN. Standing rule 1.
// ---------------------------------------------------------------------------

/** One engine that assessed a roster, found four mentions, none of them ours. */
const MEASURED_ZERO = scanResult({
  perEngineSummaries: {
    aio: {
      share_of_voice_pct: 0,
      self_mentions: 0,
      total_brand_mentions: 4,
      top_rivals: [{ name: "Rival A", mentions: 4 }],
    },
  },
});

test("a measured zero renders 0.0% and says it was measured", async () => {
  assert.equal(resolveShareOfVoice(MEASURED_ZERO).state, SHARE_STATE.MEASURED);

  const html = await renderScoreBreakdown(MEASURED_ZERO);
  const card = cardFor(html, "share_of_voice");

  assert.ok(textOf(card).includes("0.0%"), "a real zero is a number and prints as one");
  assert.ok(
    card.includes('data-metric-measured="true"'),
    "a measured zero must not be marked unmeasured"
  );
  assert.ok(
    textOf(card).includes(MEASURED_ZERO_LABEL),
    "a measured zero must say so — otherwise it reads exactly like the absent case"
  );
  assert.ok(
    !textOf(card).includes(NOT_AVAILABLE_LABEL),
    "a measured zero is not 'not available'"
  );
});

test("the measured zero and the never-computed case are distinguishable in the markup", async () => {
  const measured = cardFor(await renderScoreBreakdown(MEASURED_ZERO), "share_of_voice");
  const absent = cardFor(await renderScoreBreakdown(scanResult()), "share_of_voice");

  assert.notEqual(
    textOf(measured),
    textOf(absent),
    "this is the whole finding: the two must not read identically"
  );
  assert.ok(measured.includes('data-track-measured="true"'));
  assert.ok(absent.includes('data-track-measured="false"'), "the bar must not fake an empty track");
});

test("a measured non-zero share prints the resolver's number and no state chip", async () => {
  const result = scanResult({
    perEngineSummaries: {
      aio: {
        share_of_voice_pct: 40,
        self_mentions: 2,
        total_brand_mentions: 5,
        top_rivals: [{ name: "Rival A", mentions: 3 }],
      },
    },
  });
  const html = await renderScoreBreakdown(result);
  const card = cardFor(html, "share_of_voice");

  assert.ok(textOf(card).includes("40.0%"));
  assert.ok(!card.includes('data-testid="score-breakdown-state"'), "a real number needs no state chip");
  assert.ok(card.includes('data-metric-measured="true"'));
});

test("a scan whose rival extractor never ran says 'not assessed', not a share", async () => {
  const result = scanResult({ rosterSource: "unavailable", shareOfVoicePct: 100 });
  const html = await renderScoreBreakdown(result);
  const card = cardFor(html, "share_of_voice");

  assert.ok(!card.includes("%"), "a roster that was never assessed supports no percentage");
  assert.ok(card.includes('data-share-state="not_assessed"'));
  assert.ok(
    textOf(card).includes("Not assessed — rival extraction offline"),
    "the roster state's own words, shared with the donut and the Rivals view"
  );
});

// ---------------------------------------------------------------------------
// 3. THE REST OF THE PANEL. The same `?? 0` was on every metric.
// ---------------------------------------------------------------------------

test("every metric with no value renders an em dash and a state, never 0%", async () => {
  const html = await renderScoreBreakdown({ brand: "Zouk", rosterSource: "extracted" });

  for (const key of ["visibility_score", "mention_rate", "citation_share"]) {
    const card = cardFor(html, key);
    assert.ok(!card.includes("%"), `${key} printed a percentage it never measured`);
    assert.ok(textOf(card).includes("—"), `${key} must render an em dash`);
    assert.ok(
      textOf(card).includes("Not measured in this scan"),
      `${key} must carry a state chip, not a bare dash`
    );
    assert.ok(card.includes('data-metric-measured="false"'));
  }
});

test("a credible interval nobody computed does not print 0%–0%", async () => {
  const html = await renderScoreBreakdown(scanResult());
  const text = textOf(html);
  assert.ok(!text.includes("0%–0%"), "the old range printed a measured certainty of zero");
  assert.ok(text.includes("Likely Visibility Range: —"));
  assert.ok(html.includes('data-ci-measured="false"'));
  assert.ok(html.includes('data-testid="score-breakdown-ci-state"'), "the range needs a state too");
});

test("a real credible interval still renders both ends", async () => {
  const html = await renderScoreBreakdown(scanResult({ scoreCiLow: 31, scoreCiHigh: 55 }));
  const text = textOf(html);
  assert.ok(text.includes("Likely Visibility Range: 31.0%–55.0%"));
  assert.ok(html.includes('data-ci-measured="true"'));
});

test("one measured end of the interval is not a range", async () => {
  const html = await renderScoreBreakdown(scanResult({ scoreCiLow: 31 }));
  assert.ok(html.includes('data-ci-measured="false"'));
  assert.ok(!textOf(html).includes("31.0%–"), "half an interval must not be drawn as a whole one");
});

test("measured metrics still render their numbers", async () => {
  const html = await renderScoreBreakdown(scanResult());
  assert.ok(textOf(cardFor(html, "visibility_score")).includes("42.0%"));
  assert.ok(textOf(cardFor(html, "mention_rate")).includes("38.0%"));
  assert.ok(textOf(cardFor(html, "citation_share")).includes("12.0%"));
});

// ---------------------------------------------------------------------------
// 4. describeShareMetric as a unit — the wording function itself.
// ---------------------------------------------------------------------------

test("describeShareMetric never prints a number the resolver did not measure", () => {
  for (const state of [SHARE_STATE.NOT_ASSESSED, SHARE_STATE.UNAVAILABLE]) {
    // A caller handing over a pct alongside a non-measured state is exactly the
    // shape that would resurrect the bug. The state wins.
    const view = describeShareMetric({ state, pct: 0, label: null, detail: null });
    assert.equal(view.value, "—", `${state} must not print a percentage`);
    assert.equal(view.measured, false);
    assert.equal(view.progress, null);
    assert.ok(view.state, "a non-measured share always carries words");
  }
});

test("describeShareMetric marks a measured zero as measured", () => {
  const view = describeShareMetric({ state: SHARE_STATE.MEASURED, pct: 0 });
  assert.equal(view.measured, true);
  assert.equal(view.measuredZero, true);
  assert.equal(view.value, "0.0%");
  assert.equal(view.state, MEASURED_ZERO_LABEL);
  assert.equal(view.progress, 0);
});

test("describeShareMetric leaves a measured non-zero share unannotated", () => {
  const view = describeShareMetric({ state: SHARE_STATE.MEASURED, pct: 63.2 });
  assert.equal(view.value, "63.2%");
  assert.equal(view.state, null);
  assert.equal(view.measuredZero, false);
});

test("describeShareMetric refuses a non-finite pct even when told it is measured", () => {
  for (const pct of [null, undefined, NaN, Infinity, "40", {}]) {
    const view = describeShareMetric({ state: SHARE_STATE.MEASURED, pct });
    assert.equal(view.measured, false, `pct ${String(pct)} is not a measurement`);
    assert.equal(view.value, "—");
  }
});

test("describeShareMetric names a state it does not recognise instead of swallowing it", () => {
  const view = describeShareMetric({ state: "share_teleported", pct: 12 });
  assert.equal(view.measured, false);
  assert.equal(view.value, "—");
  assert.equal(view.rawState, "share_teleported");
  assert.ok(view.state, "an unknown state still gets human words on screen");
  assert.ok(
    view.detail.includes("share_teleported"),
    "the token must be recoverable from the explanation, not dropped"
  );
  assert.equal(view.reason, "unrecognised_state");
});

test("describeShareMetric survives garbage without inventing a share", () => {
  for (const bad of [null, undefined, 0, "", [], { state: 42 }, { pct: 99 }]) {
    const view = describeShareMetric(bad);
    assert.equal(view.measured, false, `${JSON.stringify(bad)} must not read as measured`);
    assert.equal(view.value, "—");
    assert.ok(view.state);
  }
});

// ---------------------------------------------------------------------------
// 5. The harness's own teeth. If these fail, everything above proves nothing.
// ---------------------------------------------------------------------------

test("the harness renders the real component, with the real share module", async () => {
  const html = await renderScoreBreakdown(scanResult());
  assert.ok(html.length > 500, "the render produced markup");
  assert.ok(textOf(html).includes("Score Decomposition"), "this is the panel under test");
  assert.equal(
    html.split('data-testid="score-breakdown-metric"').length - 1,
    4,
    "all four metric cards rendered"
  );
  // Proof the share module was NOT stubbed: the exports this file imported are
  // the real implementations, and the string on screen came out of them.
  assert.equal(typeof describeShareMetric, "function");
  assert.equal(typeof resolveShareOfVoice, "function");
  assert.ok(NOT_AVAILABLE_LABEL.length > 0 && textOf(html).includes(NOT_AVAILABLE_LABEL));
});

test("a null result still renders nothing rather than throwing", async () => {
  const html = await renderScoreBreakdown(null);
  assert.equal(html, "");
});

test("GUARD — the component no longer defaults a missing metric to zero", async () => {
  const source = await readFile(COMPONENT_PATH, "utf8");
  // Comments are stripped first: the file DESCRIBES the removed default in its
  // header, and a guard that cannot tell prose from code would either fail on
  // the explanation or force the explanation to be deleted.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
  // Secondary to the rendered assertions above, which are what actually prove
  // the behaviour; this exists so a reintroduced `?? 0` is named at its source.
  assert.ok(
    !/\?\?\s*0\b/.test(code),
    "`?? 0` on a metric is the finding — a missing measurement is an em dash"
  );
});
