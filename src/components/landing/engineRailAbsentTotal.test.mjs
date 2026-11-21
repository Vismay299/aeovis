/**
 * R2.7.9 — THE RAIL CANNOT SAY "THE SAME 0 QUESTIONS GO TO EACH".
 *
 * THE BUG, AS REPRODUCED. src/components/landing/EngineRail.jsx opened with
 * `const perEngine = total ?? (engines[0]?.asked ?? 0)`. Rendering the real
 * component through sucrase + react-dom/server with `total` absent and an empty
 * engine list produced, verbatim:
 *
 *   "The same 0 questions go to each. The mark is where you land; the line is
 *    half the set."
 *
 * A figure nobody measured, printed as a confident number on the LANDING page —
 * the surface a prospect reads before they trust us with anything. It was
 * LATENT, not visible: src/app/page.js passes `total={PER_ENGINE_ASKED}` on
 * every render, so the fallback was unreachable in production and waited on one
 * caller dropping the prop. That masking is why a test, not just a fix: the
 * caller is outside this task and can change without anyone noticing this.
 *
 * WHAT THIS FILE PROVES, AND HOW.
 *   1. By running the pure `describeRailTotal` export: what earns a printed
 *      number is a finite, non-negative figure, and nothing else.
 *   2. By RENDERING the real EngineRail and reading its markup: with the figure
 *      absent, no digit reaches the sentence at all — an em dash and a state
 *      chip do. The digit assertion is the load-bearing one, because it fails
 *      for ANY fabricated default, not only for zero.
 *   3. THE THREE-STATE TEST: absent, unreadable and genuinely-zero render as
 *      three DIFFERENT sentences, computed by comparing the renders rather than
 *      asserted string by string. A fix that renders one honest dash for every
 *      non-healthy case cannot pass it.
 *
 * WHAT IT CANNOT PROVE, said rather than implied:
 *   - This is `renderToStaticMarkup`. No browser, no CSS, no layout: it shows
 *     the words and the data attribute reach the DOM, not that the state chip is
 *     legible next to the em dash. There is no visual-regression harness here.
 *   - It does not render src/app/page.js, which is outside this task. That the
 *     page still passes a real `total` is guarded by nothing; if that prop goes
 *     away the rail now degrades honestly, which is the whole point.
 *   - The SOURCE-level ban on the `?? 0` shape returning anywhere on the landing
 *     surface lives in src/server/landingProbeCounter.test.mjs (rule
 *     "zero-fallback"), not here.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RAIL_PATH = path.join(HERE, "EngineRail.jsx");

/** Reveal is a scroll wrapper and Gauge is the per-engine dial; neither is under test. */
const Reveal = ({ children }) => React.createElement("div", null, children);
const Gauge = (props) =>
  React.createElement("div", { "data-gauge": props.name }, `${props.reached}/${props.asked}`);

/** Compile the REAL EngineRail.jsx to CJS and evaluate it against a require shim. */
async function loadRail() {
  const source = await readFile(RAIL_PATH, "utf8");
  const { code } = transform(source, {
    transforms: ["jsx", "imports"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    filePath: RAIL_PATH,
  });
  const modules = new Map([
    ["@/components/landing/Reveal", { __esModule: true, Reveal }],
    ["@/components/perceev/charts/Gauge", { __esModule: true, Gauge }],
  ]);
  const requireShim = (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    throw new Error(
      `EngineRail.jsx imports "${specifier}", which this harness does not resolve. ` +
        "Add it to the map deliberately.",
    );
  };
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function("require", "module", "exports", "React", code);
  factory(requireShim, mod, mod.exports, React);
  return mod.exports;
}

const rail = await loadRail();
const { EngineRail, describeRailTotal } = rail;

const ENGINES = [
  { name: "Google AI Overviews", asked: 30, reached: 11 },
  { name: "Perplexity", asked: 30, reached: 7 },
];

const markup = (props) => renderToStaticMarkup(React.createElement(EngineRail, props));

/** The sentence a reader sees: markup with the tags taken out and spaces collapsed. */
const sentence = (props) =>
  markup(props)
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The prose of the rail's opening paragraph only — up to the fixed second
 * sentence, which describes the graphic and carries no figure. This is what the
 * digit assertions read, so a number inside a gauge label cannot make an absent
 * figure look measured or a measured one look absent.
 */
const claim = (props) => sentence(props).split("The mark is where you land")[0];

test("the harness renders the REAL EngineRail, not a stub", () => {
  assert.equal(typeof EngineRail, "function", "EngineRail.jsx must still export the component");
  assert.equal(
    typeof describeRailTotal,
    "function",
    "EngineRail.jsx must export describeRailTotal, the pure decision this file tests",
  );
  // Anti-vacuity: if the harness rendered nothing, every "must not contain"
  // assertion below would pass for the wrong reason.
  const healthy = sentence({ engines: ENGINES, total: 30 });
  assert.match(healthy, /Reach, engine by engine/);
  assert.match(healthy, /The same 30 questions go to each\./);
  assert.match(healthy, /11\/30/, "the gauges must render, or this is not the whole component");
});

test("ACCEPT — with the figure absent the rail prints an em dash and a state, never a number", () => {
  for (const [label, props] of [
    ["no total, no engine rows", { engines: [] }],
    ["total explicitly null", { engines: [], total: null }],
    ["engine rows carry no question count", { engines: [{ name: "Google", reached: 1 }] }],
  ]) {
    const said = claim(props);

    // The bug, stated as the assertion that would have caught it.
    assert.doesNotMatch(
      said,
      /The same 0 questions/,
      `${label}: the rail claimed a measurement nobody took — ${said}`,
    );
    // Broader than the zero: ANY fabricated default is a digit in this sentence.
    assert.doesNotMatch(
      said,
      /\d/,
      `${label}: an unmeasured figure reached the page as a number — ${said}`,
    );
    assert.match(said, /—/, `${label}: an absent figure must render as an em dash — ${said}`);
    assert.match(
      said,
      /not measured/,
      `${label}: the em dash must carry a state, or it is a shrug — ${said}`,
    );
    // And the state must be a chip in the DOM, not just words in prose.
    assert.match(
      markup(props),
      /data-rail-total-state="not measured"/,
      `${label}: the state must reach the DOM as a chip`,
    );
  }
});

test("ACCEPT — absent, unreadable and genuinely-zero are three different sentences", () => {
  const absent = claim({ engines: [] });
  const unreadable = claim({ engines: ENGINES, total: Number.NaN });
  const measuredZero = claim({ engines: [], total: 0 });
  const measured = claim({ engines: ENGINES, total: 30 });

  const all = [absent, unreadable, measuredZero, measured];
  assert.equal(
    new Set(all).size,
    4,
    `the four states must be distinguishable on the page; got ${JSON.stringify(all)}`,
  );

  // A genuine zero is a READING, so it keeps its number — and still says what it
  // is, because a rail reporting nothing must not look like a healthy one.
  assert.match(measuredZero, /The same 0 questions go to each\./);
  assert.match(measuredZero, /none asked/);
  assert.match(markup({ engines: [], total: 0 }), /data-rail-total-state="none asked"/);

  // A total that is not a number is not silently swapped for one either.
  assert.doesNotMatch(unreadable, /\d/, `an unreadable total printed a figure — ${unreadable}`);
  assert.doesNotMatch(unreadable, /NaN/, `NaN reached the landing page — ${unreadable}`);
  assert.match(unreadable, /unreadable/);
});

test('engines asked different amounts cannot be printed after the words "the same"', () => {
  const uneven = claim({
    engines: [
      { name: "Google", asked: 30, reached: 11 },
      { name: "Perplexity", asked: 12, reached: 7 },
    ],
  });
  assert.doesNotMatch(
    uneven,
    /\d/,
    `the old fallback took engines[0].asked and called it "the same" — ${uneven}`,
  );
  assert.match(uneven, /engines disagree/);

  // Agreement is what makes the derived figure true, and it is still derived.
  assert.match(claim({ engines: ENGINES }), /The same 30 questions go to each\./);
});

test("describeRailTotal — the pure decision, without a renderer in the way", () => {
  // A caller-supplied total is authoritative.
  assert.deepEqual(describeRailTotal({ total: 30, engines: ENGINES }), {
    measured: true,
    value: "30",
    state: null,
    reason: null,
  });
  // Numeric strings are readings; the props arrive from JSX and may be either.
  assert.equal(describeRailTotal({ total: "30" }).value, "30");
  assert.equal(describeRailTotal({ total: "30" }).measured, true);

  // Nothing behind it, in every spelling of nothing.
  for (const props of [
    undefined,
    {},
    { total: null },
    { total: undefined },
    { engines: [] },
    { engines: null },
    { engines: [{ name: "Google" }] },
  ]) {
    const got = describeRailTotal(props);
    assert.equal(got.measured, false, `${JSON.stringify(props)} is not a measurement`);
    assert.equal(got.value, "—", `${JSON.stringify(props)} must render as an em dash`);
    assert.ok(got.state, `${JSON.stringify(props)} must carry a state, not a bare dash`);
    assert.ok(got.reason, `${JSON.stringify(props)} must say WHY it has no figure`);
  }

  // Present but unprintable.
  for (const bad of [Number.NaN, Infinity, -Infinity, -1, "thirty", "", {}, true]) {
    const got = describeRailTotal({ total: bad, engines: ENGINES });
    assert.equal(
      got.measured,
      false,
      `total=${String(bad)} is not a figure this rail can print, but it said it was`,
    );
    assert.equal(got.value, "—");
  }

  // Zero is measured, and marked.
  assert.deepEqual(describeRailTotal({ total: 0 }), {
    measured: true,
    value: "0",
    state: "none asked",
    reason: "the set behind this rail is empty",
  });
});

test("REGRESSION — the source no longer holds the fallback that shipped", async () => {
  // The landing-wide version of this rule lives in landingProbeCounter.test.mjs;
  // this is the local, unmissable one, next to the component it is about.
  const source = await readFile(RAIL_PATH, "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(
    code,
    /(?:\?\?|\|\|)=?\s*-?0(?:\.0+)?(?![\d.])/,
    "EngineRail.jsx defaults a figure to 0 again; render the absent branch instead",
  );
});
