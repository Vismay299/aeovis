import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

import {
  ENGINE_MEASUREMENT_STATE,
  ENGINE_STATE_REASONS,
  summarizeEngineSlice,
  summarizeEngineResults,
  computeHeadline,
} from "../../lib/scoring/enginePipeline.js";
import * as apiClient from "../../services/api.js";
import * as formatModule from "../../utils/format.js";
import { scoreTier, tierLabel, tierClasses } from "../../utils/format.js";
import * as aliasesModule from "../../lib/scoring/aliases.js";
import * as brandKeyModule from "../../lib/scoring/brandKey.js";
import * as aioConstantsModule from "../../lib/scoring/aioConstants.js";
import * as enginePipelineModule from "../../lib/scoring/enginePipeline.js";
import * as rosterContinuityModule from "../../lib/scoring/rosterContinuity.js";
import * as interlockingModule from "./interlocking.js";

/**
 * R2.1.2, round 2 — NO SCORE, NO VERDICT.
 *
 * R2.1.2's first cut deleted the `?? 0` laundering in the normalize layer, which
 * was right, and thereby made DashboardShell's `heroScore` genuinely null for a
 * `not_assessed` scan. The verifier rejected it for what happened next: the hero
 * still computed `scoreTier(heroScore)`, and scoreTier's final `return "weak"`
 * was a FALLTHROUGH — `null >= 50` and `null >= 25` are both false — so the band
 * rendered a red "Weak" chip directly beside the em dash standing in for the
 * percentage. A verdict produced by a measurement that does not exist, which is
 * the same defect this task's diff already fixed once for Sidebar (see the
 * comment at src/lib/scoring/enginePipeline.js:462-465).
 *
 * WHAT THIS FILE PROVES, and how:
 *   - scoreTier by direct execution, including a live re-run of the OLD
 *     fallthrough on the same input so the failure mode is on the record rather
 *     than described.
 *   - the HERO, by RENDERING it: the real DashboardShell (so the props under
 *     test are the ones the shipped component computes, not ones a test author
 *     chose) feeding the real ScoreBand and the real OverviewView. A
 *     source-text guard would not have caught this and did not.
 *   - the POSITIVE cases, so a fix cannot pass by deleting the verdict badge for
 *     everyone: a measured 40 still bands "Moderate", and a MEASURED ZERO still
 *     bands "Weak" with its 0 (standing rule 1 — a measured zero must stay
 *     visibly different from "we never got a number").
 *
 * WHAT IT DOES NOT PROVE, stated rather than implied:
 *   - Static markup only: no browser, no CSS. It proves the dash reaches the DOM
 *     without a tier chip beside it, not that the panel is legible.
 *   - Three of DashboardShell's children are stubbed (Sidebar, the non-overview
 *     views, StudioView) and so is OverviewAnalytics. ScoreBand, OverviewView,
 *     FlowDiagram and Gauge are COMPILED FROM SOURCE, because they are where a
 *     tier turns into a coloured chip.
 *   - It does NOT assert that the em dash comes without a percent sign. It does
 *     not, today: ScoreBand renders `{isNumeric ? Math.round(score) : '—'}` and
 *     then an UNCONDITIONAL `<span>%</span>`, so the null-score hero reads "—%" —
 *     the same unearned unit R2.7.8 removed from the engine chips, still on the
 *     headline figure. ScoreBand.jsx is outside this round's working set, so the
 *     gap is named here and left for its own task rather than asserted either way.
 *   - `useEffect` is run synchronously by the shim below and `fetchScanHistory`
 *     returns a synchronous thenable — the same two documented deviations
 *     historyScoreSurface.test.mjs takes. They change WHEN state is set, not
 *     what the component computes from it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_PATH = path.join(HERE, "DashboardShell.jsx");
const SCORE_BAND_PATH = path.join(HERE, "ScoreBand.jsx");
const OVERVIEW_PATH = path.join(HERE, "OverviewView.jsx");
const FLOW_PATH = path.join(HERE, "..", "charts", "FlowDiagram.jsx");
const GAUGE_PATH = path.join(HERE, "..", "charts", "Gauge.jsx");

/** Every tier word a chip could print, and the classes each one paints. */
const TIER_WORDS = ["Strong", "Moderate", "Weak", "strong", "moderate", "weak"];
const TIER_CLASSES = ["chip--good", "chip--warn", "chip--crit"];

// ---------------------------------------------------------------------------
// 0. THE HARNESS. A component is compiled from source or stubbed — never both,
//    and never by a catch-all that could silently replace the thing under test.
// ---------------------------------------------------------------------------

function nullComponent() {
  return null;
}

const anyNamedExport = new Proxy(
  { __esModule: true },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      return nullComponent;
    },
  }
);

function makeUseEffectShim() {
  return function useEffectShim(fn, deps) {
    const ref = React.useRef(undefined);
    const prev = ref.current;
    const changed =
      prev === undefined ||
      deps === undefined ||
      prev.deps === undefined ||
      prev.deps.length !== deps.length ||
      deps.some((d, i) => !Object.is(d, prev.deps[i]));
    if (!changed || (prev !== undefined && deps === undefined)) return;
    ref.current = { deps };
    fn();
  };
}

/** A promise that settles DURING the render, so history is populated in-pass. */
function syncResolved(value) {
  return {
    then(onFulfilled) {
      onFulfilled(value);
      return syncResolved(value);
    },
  };
}

/**
 * Compile one .jsx file and return its CommonJS exports. `resolve` must answer
 * every specifier the file imports; an unanswered one throws by name rather than
 * being quietly stubbed, because a stub in the wrong place is how a rendering
 * test becomes vacuous while still passing.
 */
async function compileComponent(filePath, resolve, reactModule) {
  const source = await readFile(filePath, "utf8");
  const { code } = transform(source, {
    transforms: ["jsx", "imports"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    filePath,
  });
  const moduleRecord = { exports: {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function("require", "module", "exports", "React", code);
  factory(resolve(filePath), moduleRecord, moduleRecord.exports, reactModule);
  return moduleRecord.exports;
}

const LUCIDE = ["lucide-react", anyNamedExport];

/**
 * Render the real DashboardShell over a stored scan row.
 *
 * NOT stubbed, deliberately: @/utils/format (the module under test),
 * @/services/api (so `result` comes from the real normalizeResult), and the two
 * components that turn a tier into a chip.
 */
async function renderShell(scan) {
  const patchedReact = { ...React, useEffect: makeUseEffectShim(), __esModule: true };
  patchedReact.default = patchedReact;

  const flow = await compileComponent(
    FLOW_PATH,
    () => (spec) => {
      throw new Error(`FlowDiagram.jsx imports "${spec}", which this harness does not resolve.`);
    },
    patchedReact
  );
  const gauge = await compileComponent(
    GAUGE_PATH,
    () => (spec) => {
      throw new Error(`Gauge.jsx imports "${spec}", which this harness does not resolve.`);
    },
    patchedReact
  );

  const overviewModules = new Map([
    ["react", patchedReact],
    LUCIDE,
    ["@/components/charts/FlowDiagram", { ...flow, __esModule: true }],
    ["@/components/charts/Gauge", { ...gauge, __esModule: true }],
    ["@/lib/scoring/rosterContinuity", { ...rosterContinuityModule, __esModule: true }],
    ["./interlocking", { ...interlockingModule, __esModule: true }],
    // Stubbed on purpose: a chain of four analytics panels, none of which
    // renders a tier chip. Named here so the omission is a decision.
    ["./OverviewAnalytics", { __esModule: true, OverviewAnalytics: nullComponent }],
  ]);
  const overview = await compileComponent(
    OVERVIEW_PATH,
    () => (spec) => {
      if (overviewModules.has(spec)) return overviewModules.get(spec);
      throw new Error(
        `OverviewView.jsx imports "${spec}", which this harness does not resolve. Add it deliberately.`
      );
    },
    patchedReact
  );

  const scoreBand = await compileComponent(
    SCORE_BAND_PATH,
    () => (spec) => {
      if (spec === "react") return patchedReact;
      throw new Error(`ScoreBand.jsx imports "${spec}", which this harness does not resolve.`);
    },
    patchedReact
  );

  const shellModules = new Map([
    ["react", patchedReact],
    LUCIDE,
    [
      "next/navigation",
      {
        __esModule: true,
        useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {} }),
        usePathname: () => "/dashboard",
        useSearchParams: () => new URLSearchParams(),
      },
    ],
    ["@/services/api", { ...apiClient, __esModule: true, fetchScanHistory: () => syncResolved([]) }],
    ["@/utils/format", formatModule],
    ["@/lib/scoring/aliases", aliasesModule],
    ["@/lib/scoring/brandKey", brandKeyModule],
    ["@/lib/scoring/aioConstants", aioConstantsModule],
    ["@/lib/scoring/enginePipeline", { ...enginePipelineModule, __esModule: true }],
    ["@/components/dashboard/ScoreBand", { ...scoreBand, __esModule: true }],
    ["@/components/dashboard/OverviewView", { ...overview, __esModule: true }],
  ]);

  const shell = await compileComponent(
    SHELL_PATH,
    () => (spec) => {
      if (shellModules.has(spec)) return shellModules.get(spec);
      // Sidebar, ThemeToggle, the five non-overview views, StudioView. None of
      // them receives `tier`; DashboardShell.jsx is grepped below to keep that
      // true, so this fallback cannot start hiding a surface under test.
      if (spec.startsWith("@/components/") || spec.startsWith("@/lib/")) return anyNamedExport;
      throw new Error(
        `DashboardShell imports "${spec}", which this harness does not resolve. Add it deliberately.`
      );
    },
    patchedReact
  );

  const Shell = shell.default;
  assert.equal(typeof Shell, "function", "DashboardShell.jsx must still default-export a component");

  const realFetch = globalThis.fetch;
  const realSetInterval = globalThis.setInterval;
  globalThis.fetch = () => new Promise(() => {});
  globalThis.setInterval = () => 0;
  try {
    return renderToStaticMarkup(React.createElement(Shell, { scan }));
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setInterval = realSetInterval;
  }
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

/** The markup of one panel, from its data-testid to the end of its header. */
function panelHeader(html, testid) {
  const at = html.indexOf(`data-testid="${testid}"`);
  assert.notEqual(at, -1, `the ${testid} panel must be on screen for this assertion to mean anything`);
  const body = html.indexOf('class="panel__b"', at);
  assert.notEqual(body, -1, `${testid} has no panel__b to bound its header`);
  return html.slice(at, body);
}

/** The whole panel, header and body, bounded by the next panel's testid. */
function wholePanel(html, testid) {
  const at = html.indexOf(`data-testid="${testid}"`);
  assert.notEqual(at, -1, `the ${testid} panel must be on screen`);
  const next = html.indexOf('data-testid="', at + 20);
  return html.slice(at, next === -1 ? html.length : next);
}

// ---------------------------------------------------------------------------
// 1. THE FIXTURES, PRODUCED BY THE REAL PIPELINE, so a renamed state token or a
//    moved gate breaks this file instead of quietly making it fictional.
// ---------------------------------------------------------------------------

const times = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));
const SELF = "Acme";
const RIVAL = "Rival A";

/** An answered non-branded probe in the shape summarizeEngineSlice consumes. */
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
    brands: [
      { name: SELF, is_self: true, mentioned: visible },
      { name: RIVAL, is_self: false, mentioned: named },
    ],
  };
}

function scanSummaryFor(rows) {
  const aio = summarizeEngineSlice(rows, "aio");
  const { summary } = summarizeEngineResults({
    results: rows,
    engines: { aio },
    headline: computeHeadline([aio]),
  });
  return summary;
}

/* No answer named ANY vendor, so there was no share to take: not_assessed with
   a null score. This is the shape that reaches customers, not a hand-written
   `{ visibility_pct: null }`. */
const NOT_ASSESSED_SUMMARY = scanSummaryFor(times(30, (i) => answered(i, { named: false })));
/* Every answer named a rival and none named us: a real, measured 0. */
const MEASURED_ZERO_SUMMARY = scanSummaryFor(times(30, (i) => answered(i, { visible: false })));
/* 12 of 30 answers name us: 40%, with an adequate eligible panel. */
const MEASURED_SUMMARY = scanSummaryFor([
  ...times(12, (i) => answered(i, { visible: true })),
  ...times(18, (i) => answered(100 + i)),
]);

/**
 * A stored `scans` row. `raw_results.summary_stats` is the only place `state`
 * survives the round trip (the table has no column for it), and the dashboard's
 * `results` rows are a different shape from the probe rows above — so both are
 * supplied, exactly as db.js writes them.
 */
function storedRow(summary) {
  const results = times(10, (i) => ({
    query: `unbranded prompt ${i}`,
    engine: "aio",
    aio_present: true,
    brand_mentioned: false,
    is_branded_query: false,
    aio_text: "Several vendors compete.",
    aio_references: [],
  }));
  return {
    id: "row-under-test",
    brand: SELF,
    url: "acme.com",
    website: "acme.com",
    scanned_at: "2026-09-01T10:00:00Z",
    visibility_pct: summary.visibility_pct,
    mention_rate_pct: summary.mention_rate_pct,
    prompts_tracked: summary.non_branded_queries,
    prompts_mentioned: summary.visible_non_branded,
    competitors: [],
    results,
    raw_results: {
      results,
      summary_stats: summary,
      scoring_version: "v8.1-aio-unbranded-plus-presence",
      prompt_set_id: "acme.com:v1",
    },
    scoring_version: "v8.1-aio-unbranded-plus-presence",
    prompt_set_id: "acme.com:v1",
  };
}

test("premise — the pipeline really emits a NULL score for the not_assessed fixture", () => {
  assert.equal(NOT_ASSESSED_SUMMARY.state, ENGINE_MEASUREMENT_STATE.NOT_ASSESSED);
  assert.equal(NOT_ASSESSED_SUMMARY.state_reason, ENGINE_STATE_REASONS.EMPTY_ELICITING_POOL);
  assert.strictEqual(NOT_ASSESSED_SUMMARY.visibility_pct, null);
  assert.strictEqual(MEASURED_ZERO_SUMMARY.visibility_pct, 0);
  assert.strictEqual(MEASURED_SUMMARY.visibility_pct, 40);
});

test("premise — normalizeResult carries the null through to the hero's inputs", () => {
  const r = apiClient.normalizeResult(storedRow(NOT_ASSESSED_SUMMARY), SELF, "acme.com");
  assert.strictEqual(r.shareOfAiPct, null, "the hero's first choice must be null");
  assert.strictEqual(r.visibilityScore, null, "...and so must its fallback, or heroScore is not null");
  const heroScore = r.isMultiEngine
    ? (r.visibilityIndexPct ?? r.shareOfAiPct ?? r.visibilityScore)
    : (r.shareOfAiPct ?? r.visibilityScore);
  assert.strictEqual(heroScore, null, "DashboardShell's own heroScore expression, on this row");
});

// ---------------------------------------------------------------------------
// 2. scoreTier — the root cause, by direct execution.
// ---------------------------------------------------------------------------

/** What shipped before this fix, run here so the failure mode is on the record. */
function scoreTierBeforeTheFix(score, scoringVersion = "v2-composite") {
  const isBinary = scoringVersion === "v1-binary";
  if (score >= (isBinary ? 70 : 50)) return "strong";
  if (score >= (isBinary ? 40 : 25)) return "moderate";
  return "weak";
}

test("ACCEPT — an absent score has NO tier, where it used to fall through to weak", () => {
  assert.equal(
    scoreTierBeforeTheFix(null),
    "weak",
    "premise: the old fallthrough banded a measurement that does not exist"
  );
  assert.equal(tierLabel(scoreTierBeforeTheFix(null)), "Weak", "premise: and it reached the screen as a word");

  for (const absent of [null, undefined, NaN, Infinity, -Infinity, "", "40", [], {}, false]) {
    assert.strictEqual(
      scoreTier(absent, "v8.1-aio-unbranded-plus-presence"),
      null,
      `scoreTier(${JSON.stringify(absent)}) must refuse to band a non-number`
    );
  }
});

test("a MEASURED ZERO is a score and still gets its verdict — standing rule 1", () => {
  assert.equal(scoreTier(0), "weak", "0 is a measurement; refusing to band it would hide a real finding");
  assert.equal(scoreTier(24.9), "weak");
  assert.equal(scoreTier(25), "moderate");
  assert.equal(scoreTier(40), "moderate");
  assert.equal(scoreTier(50), "strong");
  assert.equal(scoreTier(39, "v1-binary"), "weak", "the v1 thresholds are untouched");
  assert.equal(scoreTier(40, "v1-binary"), "moderate");
  assert.equal(scoreTier(70, "v1-binary"), "strong");
});

test("a caller that forwards the null instead of testing it still cannot paint a verdict", () => {
  // The second line of defence: tierLabel/tierClasses are the only two things
  // that turn a tier into words and colour.
  assert.equal(tierLabel(null), "—");
  assert.equal(tierLabel(undefined), "—");
  const neutral = tierClasses(null);
  for (const word of TIER_WORDS) {
    assert.ok(!tierLabel(null).includes(word), "an absent tier has no verdict word");
  }
  assert.ok(!/good|warn|crit/.test(neutral), `an absent tier must paint neutral, got "${neutral}"`);
});

// ---------------------------------------------------------------------------
// 3. THE RENDERED HERO. The surface the verifier rejected on.
// ---------------------------------------------------------------------------

test("the harness really renders the real ScoreBand and the real OverviewView", async () => {
  const html = await renderShell(storedRow(MEASURED_SUMMARY));
  assert.ok(html.includes('data-testid="score-band"'), "ScoreBand must be compiled, not stubbed");
  assert.ok(html.includes('data-testid="insight-panel"'), "OverviewView must be compiled, not stubbed");
  assert.ok(
    html.includes('data-testid="insight-interpretation"'),
    "the panel whose words are asserted below must exist"
  );
});

test("ACCEPT — a null-score hero renders the em dash and NO verdict chip beside it", async () => {
  const html = await renderShell(storedRow(NOT_ASSESSED_SUMMARY));
  const header = panelHeader(html, "score-band");
  const band = wholePanel(html, "score-band");

  assert.ok(textOf(band).includes("—"), "an unmeasured hero renders an em dash");

  // The exact markup the verifier reported: <span class="chip chip--crit">Weak</span>
  assert.ok(
    !/<span class="chip chip--crit">\s*Weak\s*<\/span>/.test(header),
    "the rejected markup is back: a red Weak chip beside a dash"
  );
  for (const word of TIER_WORDS) {
    assert.ok(
      !textOf(header).includes(word),
      `the band header says "${word}" — a verdict from a measurement that does not exist`
    );
  }
  for (const cls of TIER_CLASSES) {
    assert.ok(
      !header.includes(cls),
      `the band header paints ${cls} — a colour-coded verdict with no score behind it`
    );
  }
});

test("ACCEPT — the insight panel's chip goes too, instead of reading 'weak · %'", async () => {
  const html = await renderShell(storedRow(NOT_ASSESSED_SUMMARY));
  const header = panelHeader(html, "insight-panel");

  // This chip was `{tier} · {heroScore ?? result.visibilityScore}%`, with no
  // finite check anywhere: on a null score it rendered "weak · %" — a unit with
  // no quantity, next to a verdict with no measurement.
  assert.ok(!textOf(header).includes("·"), "no reading, no chip: the separator means a number follows");
  assert.ok(!/%/.test(textOf(header)), "a bare percent sign with nothing in front of it is not a reading");
  for (const word of TIER_WORDS) {
    assert.ok(!textOf(header).includes(word), `the insight chip says "${word}" with no score behind it`);
  }
});

test("ACCEPT — the missing verdict is EXPLAINED, not left as a blank paragraph", async () => {
  const html = await renderShell(storedRow(NOT_ASSESSED_SUMMARY));
  const panel = wholePanel(html, "insight-interpretation");
  const words = textOf(panel);

  assert.ok(words.length > 20, "an empty state under a 'What the reading means' heading says nothing at all");
  assert.match(words, /no visibility score|nothing was measured/i);
  assert.ok(
    !words.includes("largely absent from Google AI Overviews"),
    "the weak verdict's sentence is a market claim, and there is no measurement to make it from"
  );
  assert.match(words, /not a zero/i, "an absence must not read like a measured zero");
});

test("POSITIVE — a measured 40 still renders its Moderate chip and its number", async () => {
  const html = await renderShell(storedRow(MEASURED_SUMMARY));
  const header = panelHeader(html, "score-band");
  const band = wholePanel(html, "score-band");

  assert.match(header, /<span class="chip chip--warn">Moderate<\/span>/, "the verdict badge must survive the fix");
  assert.ok(textOf(band).includes("40"), "...and so must the score it is a verdict on");
  assert.match(
    textOf(wholePanel(html, "insight-interpretation")),
    /appear in some Google AI Overviews/,
    "a measured reading keeps its interpretation"
  );
});

test("R05 qualification — a six-prompt reading has no headline tier and labels the raw score exploratory", async () => {
  const summary = scanSummaryFor(times(6, (i) => answered(i, { visible: true })));
  const html = await renderShell(storedRow(summary));
  const header = panelHeader(html, "score-band");
  for (const word of ["Strong", "Moderate", "Weak"]) assert.ok(!textOf(header).includes(word));
  assert.match(textOf(wholePanel(html, "headline-qualification")), /Exploratory reading: 100%/);
  assert.match(textOf(wholePanel(html, "headline-qualification")), /6 of 6 eligible observations/);
  assert.match(textOf(wholePanel(html, "insight-interpretation")), /observations are exploratory/);
  assert.doesNotMatch(textOf(wholePanel(html, "insight-interpretation")), /nothing was measured/);
});

test("POSITIVE — a MEASURED ZERO still renders Weak and a 0, not a dash", async () => {
  const html = await renderShell(storedRow(MEASURED_ZERO_SUMMARY));
  const header = panelHeader(html, "score-band");
  const band = wholePanel(html, "score-band");

  assert.match(
    header,
    /<span class="chip chip--crit">Weak<\/span>/,
    "a measured zero is a finding and has a verdict — gating on finiteness must not swallow it"
  );
  assert.ok(/>\s*0\s*<span/.test(band), "the 0 itself must print as a number, not an em dash");
  assert.match(
    textOf(wholePanel(html, "insight-interpretation")),
    /largely absent from Google AI Overviews/,
    "and a measured zero keeps the verdict's words, which is the whole point of the four states"
  );
});

// ---------------------------------------------------------------------------
// 4. VACUITY GUARDS. What makes the assertions above non-trivially true.
// ---------------------------------------------------------------------------

test("META — the tier reaches exactly the two components this file compiles", async () => {
  const source = await readFile(SHELL_PATH, "utf8");
  // Every JSX attribute that forwards the tier, so a THIRD consumer added later
  // cannot inherit the bug behind a stub in the harness above.
  const consumers = [...source.matchAll(/tier=\{([^}]*)\}/g)].map((m) => m[1].trim());
  assert.deepEqual(
    consumers.sort(),
    ["tier", "tierLabelMap[tier]"],
    "a new `tier={...}` prop appeared — point the harness at its component before trusting this file"
  );
  assert.equal(
    (source.match(/scoreTier\(/g) || []).length,
    1,
    "DashboardShell must call scoreTier exactly once; a second call is a second gate to get wrong"
  );
  assert.match(
    source,
    /dataSourceIssue \|\| !Number\.isFinite\(heroScore\)/,
    "the local gate is the thing under test and must be in the source"
  );
});

test("META — the assertions are made against a header that really can hold a chip", async () => {
  // If panelHeader() returned an empty slice, every "does not contain" above
  // would pass vacuously. Prove the same slice DOES carry the chip when a real
  // score is present.
  const measured = panelHeader(await renderShell(storedRow(MEASURED_SUMMARY)), "score-band");
  const absent = panelHeader(await renderShell(storedRow(NOT_ASSESSED_SUMMARY)), "score-band");
  assert.ok(measured.includes("chip--warn"), "premise: the sliced header is where the tier chip lives");
  assert.ok(absent.length > 0, "premise: the null-score header is not an empty string");
  assert.ok(
    absent.includes("Share of AI") || absent.includes("AI Visibility Index"),
    "premise: the null-score header still rendered its own title, so the slice is real"
  );
});
