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
  ENGINE_READ_REASONS,
  ENGINE_STATE_REASON_DETAIL,
  ENGINE_NOT_MEASURED_LABEL,
  ENGINE_MEASURED_ZERO_LABEL,
  ENGINE_UNSTATED_ZERO_LABEL,
  NO_MEASUREMENT_TEXT,
  describeScanMeasurement,
  summarizeEngineSlice,
  computeHeadline,
  summarizeEngineResults,
} from "../../shared/scoring/enginePipeline.js";
import * as apiClient from "../../shared/api.js";
import * as formatModule from "../../shared/format.js";
import * as aliasesModule from "../../shared/scoring/aliases.js";
import * as brandKeyModule from "../../shared/scoring/brandKey.js";
import * as aioConstantsModule from "../../shared/scoring/aioConstants.js";
import * as enginePipelineModule from "../../shared/scoring/enginePipeline.js";

/**
 * R2.1.1, round 2 — THE READ SIDE OF THE NULL.
 *
 * The first cut of this task made `visibility_pct` / `share_of_ai_pct` null on
 * every slice that measured nothing, and the verifier's rejection named the two
 * surfaces that then read that null and lied about it:
 *
 *   Sidebar.jsx:142       `<b>{scan.visibility_pct}%</b>` — with a null this
 *                         renders a bare "%" with nothing in front of it.
 *   DashboardShell.jsx:978 `(next.visibility_pct - (s.visibility_pct || 0))`
 *                         — `null - 40` is `-40`, NOT NaN. A wrong number that
 *                         renders confidently is worse than a broken one.
 *   DashboardShell.jsx:252 `?? 0` on the previous hero score: the same
 *                         laundering one level up, feeding the ScoreBand trend.
 *
 * WHAT THIS FILE PROVES, and how:
 *   - describeScanMeasurement (the one shared reader) by direct execution,
 *     including that it is fed by REAL summarizeEngineSlice output rather than
 *     hand-written state tokens — so the read side cannot drift from the write
 *     side without a test failing.
 *   - describeHistoryDelta by direct execution, next to a live demonstration of
 *     what the replaced expression computed on the same inputs.
 *   - both COMPONENTS by RENDERING them (react-dom/server) and asserting on the
 *     markup a reader would get. A source-text guard is not enough: a sibling
 *     task's guard passed while its component was broken by one inverted
 *     ternary.
 *
 * WHAT IT DOES NOT PROVE, stated rather than implied:
 *   - It renders to static markup: no browser, no CSS. It proves the dash, the
 *     words and the state attributes reach the DOM, not that they are legible
 *     or that the sidebar row does not overflow.
 *   - The Sidebar's reason is a `title` + `aria-label`, not visible text (the
 *     row is a fixed two-column button). This file asserts the attribute is
 *     there; it cannot assert anyone hovers.
 *   - DashboardShell's effects are run synchronously by the harness below, the
 *     same documented deviation engineSetChangeSurface.test.mjs takes, plus one
 *     more: `fetchScanHistory` returns a SYNCHRONOUS thenable so that history
 *     is populated during the render. In a browser that resolution is a
 *     microtask later; it changes WHEN setHistory runs, not what the component
 *     computes from it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_PATH = path.join(HERE, "DashboardShell.jsx");
const SIDEBAR_PATH = path.join(HERE, "..", "perceev", "Sidebar.jsx");

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

// ---------------------------------------------------------------------------
// 0. THE STATES, PRODUCED BY THE REAL PIPELINE. Every fixture below carries a
//    state token that summarizeEngineSlice actually emitted, so a rename or a
//    changed gate breaks this file instead of silently making it fictional.
// ---------------------------------------------------------------------------

const times = (n, fn) => Array.from({ length: n }, (_, i) => fn(i));

const SELF = "Acme";
const RIVAL = "Rival A";

/**
 * An answered non-branded probe, in the shape summarizeEngineSlice consumes —
 * copied from engineMeasurementState.test.mjs so both halves of R2.1.1 drive
 * the pipeline with the same inputs. `named` = did the answer name the rival
 * (i.e. is this prompt eliciting at all).
 */
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

/** The scan-level summary a slice in each state publishes onto the `scans` row. */
function scanSummaryFor(rows) {
  const aio = summarizeEngineSlice(rows, "aio");
  const { summary } = summarizeEngineResults({
    results: rows,
    engines: { aio },
    headline: computeHeadline([aio]),
  });
  // These fixtures exercise historical rows written before headline qualification.
  // Modern qualification/rendering is covered in r05-finalize-contract and
  // heroVerdictNullScore; do not attach today's policy to legacy-state tests.
  const { metric_contract_version, ...legacySummary } = summary;
  return legacySummary;
}

const NOT_ASSESSED_SUMMARY = scanSummaryFor(times(30, (i) => answered(i, { named: false })));
const MEASURED_ZERO_SUMMARY = scanSummaryFor(times(10, (i) => answered(i, { visible: false })));
const MEASURED_SUMMARY = scanSummaryFor([
  ...times(4, (i) => answered(i, { visible: true })),
  ...times(6, (i) => answered(100 + i)),
]);

test("premise — the pipeline really does emit the three states these fixtures use", () => {
  assert.equal(NOT_ASSESSED_SUMMARY.state, ENGINE_MEASUREMENT_STATE.NOT_ASSESSED);
  assert.equal(NOT_ASSESSED_SUMMARY.state_reason, ENGINE_STATE_REASONS.EMPTY_ELICITING_POOL);
  assert.strictEqual(NOT_ASSESSED_SUMMARY.visibility_pct, null);

  assert.equal(MEASURED_ZERO_SUMMARY.state, ENGINE_MEASUREMENT_STATE.MEASURED_ZERO);
  assert.strictEqual(MEASURED_ZERO_SUMMARY.visibility_pct, 0);

  assert.equal(MEASURED_SUMMARY.state, ENGINE_MEASUREMENT_STATE.MEASURED);
  assert.strictEqual(MEASURED_SUMMARY.visibility_pct, 40);
});

/**
 * A stored `scans` row. `visibility_pct` is the real (nullable) column and
 * `raw_results.summary_stats` is where db.js's allowlist puts the summary — the
 * only place `state` / `state_reason` survive the round trip, since `scans` has
 * no column for them.
 */
function storedRow({ id, scannedAt, summary }) {
  // The stored `results` are the DASHBOARD's row shape (normalizeResult's
  // input), which is not the probe shape summarizeEngineSlice consumes above.
  const results = [
    {
      query: "best crm for hospitals",
      engine: "aio",
      aio_present: true,
      brand_mentioned: true,
      is_branded_query: false,
      aio_text: "Acme is one option.",
      aio_references: [],
    },
    {
      query: "hospital crm comparison",
      engine: "aio",
      aio_present: true,
      brand_mentioned: false,
      is_branded_query: false,
      aio_text: "Several vendors compete.",
      aio_references: [],
    },
  ];
  return {
    id,
    brand: "Acme",
    url: "acme.com",
    scanned_at: scannedAt,
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

/** A row from before R2.1.1: a number, and no state anywhere. */
const LEGACY_ROW = {
  visibility_pct: 33.3,
  raw_results: { summary_stats: { visibility_pct: 33.3 } },
};

// ---------------------------------------------------------------------------
// 1. describeScanMeasurement — the one reader both surfaces use.
// ---------------------------------------------------------------------------

test("a not_assessed row reads as unmeasured, with the reason the slice recorded", () => {
  const row = storedRow({ id: "a", scannedAt: "2026-09-01T10:00:00Z", summary: NOT_ASSESSED_SUMMARY });
  const m = describeScanMeasurement(row);

  assert.equal(m.measured, false);
  assert.strictEqual(m.pct, null);
  assert.equal(m.text, "—");
  assert.ok(!m.text.includes("%"), "no number means no unit either");
  assert.equal(m.state, ENGINE_MEASUREMENT_STATE.NOT_ASSESSED);
  assert.equal(m.reason, ENGINE_STATE_REASONS.EMPTY_ELICITING_POOL);
  assert.equal(m.label, ENGINE_NOT_MEASURED_LABEL);
  assert.equal(m.detail, ENGINE_STATE_REASON_DETAIL[ENGINE_STATE_REASONS.EMPTY_ELICITING_POOL]);
});

test("a MEASURED ZERO is a number and says it was measured — the whole point of four states", () => {
  const row = storedRow({ id: "z", scannedAt: "2026-09-01T10:00:00Z", summary: MEASURED_ZERO_SUMMARY });
  const m = describeScanMeasurement(row);

  assert.equal(m.measured, true, "0 is a measurement; blanking it hides a real finding");
  assert.equal(m.measuredZero, true);
  assert.strictEqual(m.pct, 0);
  assert.equal(m.text, "0%");
  assert.equal(m.label, ENGINE_MEASURED_ZERO_LABEL);
  assert.notEqual(m.label, ENGINE_NOT_MEASURED_LABEL, "a measured zero must not read as an absence");
});

test("a measured reading is a bare number with no chip attached", () => {
  const m = describeScanMeasurement(
    storedRow({ id: "m", scannedAt: "2026-09-01T10:00:00Z", summary: MEASURED_SUMMARY })
  );
  assert.equal(m.measured, true);
  assert.equal(m.text, "40%");
  assert.equal(m.label, null);
  assert.equal(m.detail, null);
});

test("the legacy tolerance holds — a pre-R2.1.1 row with a number and no state is measured", () => {
  // Deliberate: isMeasuredEngineSlice grants exactly this tolerance and the
  // verifier ruled it correct. Blanking these would erase real history.
  const m = describeScanMeasurement(LEGACY_ROW);
  assert.equal(m.measured, true);
  assert.equal(m.text, "33.3%");
  assert.equal(m.state, null);
});

test("a state that is NOT a measured state wins over any number sitting beside it", () => {
  const m = describeScanMeasurement({
    visibility_pct: 0,
    summary_stats: {
      state: ENGINE_MEASUREMENT_STATE.FAILED,
      state_reason: ENGINE_STATE_REASONS.HIGH_ERROR_RATE,
    },
  });
  assert.equal(m.measured, false, "a leftover 0 next to `failed` is not promoted to a fact");
  assert.equal(m.text, "—");
  assert.equal(m.reason, ENGINE_STATE_REASONS.HIGH_ERROR_RATE);
});

test("a row with neither a number nor a state says that it does not know why", () => {
  const m = describeScanMeasurement({ visibility_pct: null });
  assert.equal(m.measured, false);
  assert.equal(m.reason, ENGINE_READ_REASONS.NOT_RECORDED);
  assert.ok(m.detail.length > 0, "an unexplained absence still gets words");
});

test("a state this build does not recognise is NAMED, not swallowed into a generic dash", () => {
  const m = describeScanMeasurement({
    visibility_pct: 70,
    summary_stats: { state: "score_teleported" },
  });
  assert.equal(m.measured, false, "an unknown state must not be trusted with a number");
  assert.equal(m.reason, ENGINE_READ_REASONS.UNRECOGNISED_STATE);
  assert.ok(m.detail.includes("score_teleported"), "the token must be recoverable from the explanation");
});

test("a row claiming a measurement with no number reports the contradiction", () => {
  const m = describeScanMeasurement({
    visibility_pct: null,
    summary_stats: { state: ENGINE_MEASUREMENT_STATE.MEASURED },
  });
  assert.equal(m.measured, false);
  assert.equal(m.reason, ENGINE_READ_REASONS.MEASURED_WITHOUT_NUMBER);
});

test("the number is never reconstructed from another field", () => {
  // summary_stats carries a visibility_pct; the COLUMN is null. A reader that
  // fell back would resurrect the score of a scan whose column says it has none.
  const m = describeScanMeasurement({
    visibility_pct: null,
    summary_stats: { visibility_pct: 88, state: ENGINE_MEASUREMENT_STATE.NOT_ASSESSED },
  });
  assert.equal(m.measured, false);
  assert.strictEqual(m.pct, null);
});

test("garbage in never produces a percentage", () => {
  for (const bad of [null, undefined, 0, "", [], { visibility_pct: "40" }, { visibility_pct: NaN }]) {
    const m = describeScanMeasurement(bad);
    assert.equal(m.measured, false, `${JSON.stringify(bad)} must not read as a measurement`);
    assert.equal(m.text, "—");
    assert.ok(m.label, "an absence always carries words");
  }
});

test("META — every reason token, from either enum, has a sentence to render", () => {
  const tokens = [...Object.values(ENGINE_STATE_REASONS), ...Object.values(ENGINE_READ_REASONS)];
  for (const token of tokens) {
    assert.ok(
      ENGINE_STATE_REASON_DETAIL[token],
      `${token} has no human sentence — a surface would render a bare dash for it`
    );
  }
  // The read-side reasons must stay OUT of the producer's enum: that one is
  // asserted reachable-from-summarizeEngineSlice in engineMeasurementState.test.mjs.
  const produced = new Set(Object.values(ENGINE_STATE_REASONS));
  for (const token of Object.values(ENGINE_READ_REASONS)) {
    assert.ok(!produced.has(token), `${token} must not be mistaken for a state a slice can emit`);
  }
});

// ---------------------------------------------------------------------------
// 2. describeHistoryDelta — the arithmetic that failed silently.
// ---------------------------------------------------------------------------

/** Compile DashboardShell.jsx once and hand back its module exports. */
let shellModulePromise = null;
function loadShellModule() {
  if (!shellModulePromise) {
    shellModulePromise = (async () => {
      const source = await readFile(SHELL_PATH, "utf8");
      const { code } = transform(source, {
        transforms: ["jsx", "imports"],
        jsxPragma: "React.createElement",
        jsxFragmentPragma: "React.Fragment",
        filePath: SHELL_PATH,
      });
      const patchedReact = { ...React, useEffect: makeUseEffectShim(), __esModule: true };
      patchedReact.default = patchedReact;
      const moduleRecord = { exports: {} };
      // eslint-disable-next-line no-new-func
      const factory = new Function("require", "module", "exports", "React", code);
      factory(makeRequireShim(patchedReact), moduleRecord, moduleRecord.exports, patchedReact);
      return moduleRecord.exports;
    })();
  }
  return shellModulePromise;
}

const NOT_ASSESSED_ROW = storedRow({
  id: "r-not-assessed",
  scannedAt: "2026-09-03T10:00:00Z",
  summary: NOT_ASSESSED_SUMMARY,
});
const MEASURED_ROW = storedRow({
  id: "r-measured",
  scannedAt: "2026-09-02T10:00:00Z",
  summary: MEASURED_SUMMARY,
});
const ZERO_ROW = storedRow({
  id: "r-zero",
  scannedAt: "2026-09-01T10:00:00Z",
  summary: MEASURED_ZERO_SUMMARY,
});

test("ACCEPT — a delta with an unmeasured end is suppressed, not computed against 0", async () => {
  const { describeHistoryDelta } = await loadShellModule();

  // What the replaced expression did on exactly these two rows, run here so the
  // failure mode is on the record rather than described: not NaN, a wrong number.
  const old = (NOT_ASSESSED_ROW.visibility_pct - (MEASURED_ROW.visibility_pct || 0)).toFixed(1);
  assert.equal(old, "-40.0", "premise: null minus 40 is -40, and it renders");
  assert.ok(!Number.isNaN(parseFloat(old)), "premise: nothing about it looks broken on screen");

  const trend = describeHistoryDelta(NOT_ASSESSED_ROW, MEASURED_ROW);
  assert.strictEqual(trend.value, null, "no number may be shown for an uncomputable delta");
  assert.strictEqual(trend.delta, null);
  assert.equal(trend.reason, "unmeasured_endpoint");
  assert.ok(trend.detail && trend.detail.length > 0, "a suppressed delta must say it was suppressed");
});

test("the suppression names WHICH end has no score", async () => {
  const { describeHistoryDelta } = await loadShellModule();

  const laterMissing = describeHistoryDelta(NOT_ASSESSED_ROW, MEASURED_ROW);
  const earlierMissing = describeHistoryDelta(MEASURED_ROW, NOT_ASSESSED_ROW);
  assert.notEqual(
    laterMissing.detail,
    earlierMissing.detail,
    "which reading is missing is the fact an operator acts on"
  );
  assert.match(earlierMissing.detail, /this reading/i);
});

test("a real delta still computes, and a measured 0 is a real end of one", async () => {
  const { describeHistoryDelta } = await loadShellModule();

  assert.equal(describeHistoryDelta(MEASURED_ROW, ZERO_ROW).value, "40.0");
  assert.equal(describeHistoryDelta(ZERO_ROW, MEASURED_ROW).value, "-40.0");
  assert.equal(
    describeHistoryDelta(MEASURED_ROW, MEASURED_ROW).value,
    "0.0",
    "two equal readings are FLAT — that is a measured zero change, not a suppression"
  );
  assert.equal(describeHistoryDelta(MEASURED_ROW, MEASURED_ROW).reason, null);
});

test("no later reading is a different fact from a suppressed one", async () => {
  const { describeHistoryDelta } = await loadShellModule();
  const t = describeHistoryDelta(undefined, MEASURED_ROW);
  assert.strictEqual(t.value, null);
  assert.equal(t.reason, "no_later_reading");
  assert.equal(t.detail, null, "the newest card has nothing to explain");
});

// ---------------------------------------------------------------------------
// 3. THE RENDERED SIDEBAR. `<b>{scan.visibility_pct}%</b>` on a null.
// ---------------------------------------------------------------------------

async function renderSidebar(props) {
  const source = await readFile(SIDEBAR_PATH, "utf8");
  const { code } = transform(source, {
    transforms: ["jsx", "imports"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    filePath: SIDEBAR_PATH,
  });

  const reactModule = { ...React, __esModule: true };
  reactModule.default = reactModule;

  const modules = new Map([
    ["react", reactModule],
    ["lucide-react", anyNamedExport],
    // Only navigation transport is substituted; render the link's real DOM
    // shape while keeping the score reader and Sidebar component under test.
    ["next/link", { __esModule: true, default: ({ children, ...attributes }) => React.createElement("a", attributes, children) }],
    ["next/navigation", {
      __esModule: true,
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {} }),
    }],
    ["@/components/landing/SiteNav", { __esModule: true, Wordmark: () => null }],
    // NOT stubbed: the reader under test.
    ["@/shared/scoring/enginePipeline", { ...enginePipelineModule, __esModule: true }],
  ]);

  const requireShim = (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    throw new Error(
      `Sidebar.jsx imports "${specifier}", which this harness does not resolve. Add it deliberately — ` +
        `a catch-all stub would silently replace enginePipeline and make these assertions vacuous.`
    );
  };

  const moduleRecord = { exports: {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function("require", "module", "exports", "React", code);
  factory(requireShim, moduleRecord, moduleRecord.exports, reactModule);

  const Component = moduleRecord.exports.Sidebar;
  assert.equal(typeof Component, "function", "Sidebar.jsx must still export `Sidebar`");
  return renderToStaticMarkup(React.createElement(Component, props));
}

/** The markup of one readings row, isolated by its score element. */
function sidebarScores(html) {
  return html
    .split('data-testid="sidebar-history-score"')
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf("</b>")));
}

/**
 * What the element RENDERS, with its attributes removed. The reason sentences
 * live in `title`/`aria-label` and some of them contain the string "0%" ("this
 * is not a 0% score"), so an assertion about what is on screen has to be made
 * against the content, not against the whole tag.
 */
function contentOf(chunk) {
  return chunk.slice(chunk.indexOf(">") + 1);
}

test("ACCEPT — the sidebar renders an em dash for an unmeasured reading, never a bare percent", async () => {
  const html = await renderSidebar({
    brand: "Acme",
    view: "overview",
    onViewChange() {},
    history: [NOT_ASSESSED_ROW],
  });

  const [score] = sidebarScores(html);
  assert.ok(score !== undefined, "the readings list must render a score element");
  assert.equal(textOf(contentOf(score)), "—", "an unmeasured reading renders an em dash and nothing else");
  assert.ok(
    !contentOf(score).includes("%"),
    `no number means no percent sign on screen; the row rendered: ${contentOf(score)}`
  );
  assert.ok(score.includes('data-measured="false"'));
  assert.ok(
    score.includes(`data-state-reason="${ENGINE_STATE_REASONS.EMPTY_ELICITING_POOL}"`),
    "the row must carry WHY, not merely that it has no number"
  );
  assert.ok(
    score.includes(ENGINE_STATE_REASON_DETAIL[ENGINE_STATE_REASONS.EMPTY_ELICITING_POOL]),
    "the reason's own sentence must be on the element as a title/aria-label"
  );
});

test("the sidebar's bare-percent bug is gone from the whole rendered list", async () => {
  const html = await renderSidebar({
    brand: "Acme",
    view: "overview",
    onViewChange() {},
    history: [NOT_ASSESSED_ROW],
  });
  // The pre-fix markup was literally "<b>%</b>": a unit with no quantity.
  assert.ok(!/<b[^>]*>\s*%\s*<\/b>/.test(html), "a percent sign with nothing in front of it");
  assert.ok(!textOf(html).includes(" %"), "and no orphaned unit anywhere else in the sidebar");
});

test("the sidebar still prints real numbers, including a measured zero", async () => {
  const html = await renderSidebar({
    brand: "Acme",
    view: "overview",
    onViewChange() {},
    history: [MEASURED_ROW, ZERO_ROW, LEGACY_ROW],
  });
  const scores = sidebarScores(html).map(textOf);

  assert.ok(scores[0].includes("40%"), "a measured reading is still a number");
  assert.ok(scores[1].includes("0%"), "a MEASURED zero must still render as 0%, not as a dash");
  assert.ok(scores[2].includes("33.3%"), "a legacy stateless row keeps its number");
  assert.ok(
    sidebarScores(html)[1].includes('data-measured="true"'),
    "the measured zero must not be marked unmeasured"
  );
});

// ---------------------------------------------------------------------------
// 4. THE RENDERED DASHBOARD. The history cards and the hero trend.
// ---------------------------------------------------------------------------

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

/**
 * A thenable that resolves DURING the render rather than a microtask later, so
 * the component's own `fetchScanHistory(...).then(setHistory)` populates the
 * history the "Previous readings" panel needs. Documented at the top of this
 * file as the harness's second deviation.
 */
function syncResolved(value) {
  return {
    then(onFulfilled) {
      onFulfilled(value);
      return syncResolved(value);
    },
  };
}

function makeRequireShim(patchedReact, { history = [] } = {}) {
  const apiStub = {
    ...apiClient,
    __esModule: true,
    fetchScanHistory: () => syncResolved(history),
  };
  const modules = new Map([
    ["react", patchedReact],
    ["lucide-react", anyNamedExport],
    ["next/navigation", {
      __esModule: true,
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {} }),
      usePathname: () => "/dashboard",
      useSearchParams: () => new URLSearchParams(),
    }],
    ["@/shared/api", apiStub],
    ["@/shared/format", formatModule],
    ["@/shared/scoring/aliases", aliasesModule],
    ["@/shared/scoring/brandKey", brandKeyModule],
    ["@/shared/scoring/aioConstants", aioConstantsModule],
    // NOT stubbed: the reader under test.
    ["@/shared/scoring/enginePipeline", { ...enginePipelineModule, __esModule: true }],
  ]);
  return (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    if (specifier.startsWith("@/components/") || specifier.startsWith("@/server/") || specifier.startsWith("@/shared/")) {
      return anyNamedExport;
    }
    throw new Error(
      `DashboardShell imports "${specifier}", which this harness does not resolve. Add it deliberately.`
    );
  };
}

async function renderDashboardShell({ scan, history = [] }) {
  const source = await readFile(SHELL_PATH, "utf8");
  const { code } = transform(source, {
    transforms: ["jsx", "imports"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    filePath: SHELL_PATH,
  });

  const patchedReact = { ...React, useEffect: makeUseEffectShim(), __esModule: true };
  patchedReact.default = patchedReact;

  const moduleRecord = { exports: {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function("require", "module", "exports", "React", code);
  factory(makeRequireShim(patchedReact, { history }), moduleRecord, moduleRecord.exports, patchedReact);

  const Shell = moduleRecord.exports.default;
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

/** One history card's markup, in render order (newest first). */
function historyCards(html) {
  return html
    .split('data-testid="history-card-score"')
    .slice(1)
    .map((chunk) => chunk.slice(0, chunk.indexOf("</button>")));
}

const FULL_HISTORY = [NOT_ASSESSED_ROW, MEASURED_ROW, ZERO_ROW];

test("the harness really renders the Previous readings panel", async () => {
  const html = await renderDashboardShell({ scan: MEASURED_ROW, history: FULL_HISTORY });
  assert.ok(textOf(html).includes("Previous readings"), "the panel under test must be on screen");
  assert.equal(historyCards(html).length, 3, "one card per stored reading");
});

test("ACCEPT — an unmeasured history card renders a dash and says it was not measured", async () => {
  const html = await renderDashboardShell({ scan: MEASURED_ROW, history: FULL_HISTORY });
  const [notAssessed] = historyCards(html);

  assert.ok(notAssessed.includes('data-measured="false"'));
  assert.ok(textOf(notAssessed).includes("—"), "an unmeasured reading renders an em dash");
  assert.ok(
    textOf(notAssessed).includes(ENGINE_NOT_MEASURED_LABEL),
    "the dash must be accompanied by words — a bare dash is an empty state, not an explained one"
  );
  assert.ok(
    notAssessed.includes(ENGINE_STATE_REASON_DETAIL[ENGINE_STATE_REASONS.EMPTY_ELICITING_POOL]),
    "and the reason the slice recorded must be reachable from the card"
  );
  assert.ok(
    !/—\s*<small>%<\/small>/.test(notAssessed),
    "an em dash must not be given a percent unit"
  );
});

test("ACCEPT — the WRONG delta the old expression produced is nowhere on screen", async () => {
  const html = await renderDashboardShell({ scan: MEASURED_ROW, history: FULL_HISTORY });
  const text = textOf(html);

  // MEASURED_ROW (40) followed by NOT_ASSESSED_ROW (null): the replaced code
  // computed `null - 40 = -40` and rendered "-40.0" as a confident decline.
  assert.ok(!text.includes("-40.0"), "the silent wrong delta must not render");
  const [, measuredCard] = historyCards(html);
  assert.ok(
    measuredCard.includes('data-testid="history-card-delta-state"'),
    "a suppressed delta must say it was suppressed, not vanish"
  );
  assert.ok(textOf(measuredCard).includes("No change shown"));
  assert.ok(textOf(measuredCard).includes("40"), "...while the card's own real score still renders");
});

test("a measured zero card keeps its 0% and its real delta", async () => {
  const html = await renderDashboardShell({ scan: MEASURED_ROW, history: FULL_HISTORY });
  const cards = historyCards(html);
  const zero = cards[cards.length - 1];

  assert.ok(zero.includes('data-measured="true"'), "0 is a measurement");
  assert.ok(textOf(zero).includes("0"), "and it prints as a number");
  assert.ok(
    textOf(zero).includes(ENGINE_MEASURED_ZERO_LABEL),
    "a measured zero must be labelled, or it reads exactly like the absence above it"
  );
  assert.ok(textOf(zero).includes("+40.0"), "the delta between two measured readings still computes");
});

test("ACCEPT — the hero trend is suppressed and explained when the previous reading has no score", async () => {
  // The current scan is measured; the reading before it is not_assessed. The
  // `?? 0` at DashboardShell:252 turned that into "you were at 0" and reported
  // a climb of the full score.
  const current = storedRow({
    id: "r-current",
    scannedAt: "2026-09-04T10:00:00Z",
    summary: MEASURED_SUMMARY,
  });
  const html = await renderDashboardShell({
    scan: current,
    history: [current, NOT_ASSESSED_ROW],
  });
  const text = textOf(html);

  assert.ok(
    html.includes('data-testid="trend-unavailable"'),
    "a suppressed trend must say why — ScoreBand draws a null trend as empty space"
  );
  assert.ok(text.includes("The previous reading has no score"));
  // NOT asserted here, deliberately: that the band itself prints no "+40.0".
  // ScoreBand is one of the child components this harness stubs, so it renders
  // nothing at all and such an assertion would pass whatever the trend was. The
  // number itself is proven by describeHeroTrend below, which is the function
  // that computes it.
});

test("ACCEPT — describeHeroTrend refuses to compare against a previous scan with no score", async () => {
  const { describeHeroTrend } = await loadShellModule();

  // The laundered version: `?? 0` made this a climb of the whole score.
  const laundered = (MEASURED_SUMMARY.visibility_pct - (NOT_ASSESSED_ROW.visibility_pct ?? 0)).toFixed(1);
  assert.equal(laundered, "40.0", "premise: the old default reported a full-score climb");

  const suppressed = describeHeroTrend(40, NOT_ASSESSED_ROW);
  assert.strictEqual(suppressed.trend, null, "no comparison is possible, so no number is shown");
  assert.match(suppressed.unavailable, /previous reading has no score/);

  // The other direction, and the ordinary case.
  const noCurrent = describeHeroTrend(null, MEASURED_ROW);
  assert.strictEqual(noCurrent.trend, null);
  assert.match(noCurrent.unavailable, /This reading has no score/);

  assert.deepEqual(describeHeroTrend(40, ZERO_ROW), { trend: "40.0", unavailable: null });
  assert.deepEqual(
    describeHeroTrend(0, MEASURED_ROW),
    { trend: "-40.0", unavailable: null },
    "a measured zero is a real end of a trend, exactly like any other number"
  );
  assert.deepEqual(
    describeHeroTrend(40, LEGACY_ROW),
    { trend: "6.7", unavailable: null },
    "a pre-R2.1.1 row with a number and no state still compares"
  );
  assert.equal(
    describeHeroTrend(40, { raw_results: { visibility_index_pct: 30 } }).trend,
    "10.0",
    "a multi-engine previous scan compares on the blended index, not the aio column"
  );
});

test("a hero trend between two measured readings is unaffected", async () => {
  const current = storedRow({
    id: "r-current",
    scannedAt: "2026-09-04T10:00:00Z",
    summary: MEASURED_SUMMARY,
  });
  const html = await renderDashboardShell({ scan: current, history: [current, ZERO_ROW] });
  assert.ok(
    !html.includes('data-testid="trend-unavailable"'),
    "nothing was suppressed, so nothing must be explained"
  );
});

// ---------------------------------------------------------------------------
// 5. Source guards. Secondary to the rendered assertions above; these exist so
//    a reintroduced default is named at its source rather than found in a
//    screenshot.
// ---------------------------------------------------------------------------

/** Comments stripped: both files EXPLAIN the removed defaults in prose. */
function codeOf(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

test("GUARD — neither surface defaults a missing score back to zero", async () => {
  const shell = codeOf(await readFile(SHELL_PATH, "utf8"));
  const sidebar = codeOf(await readFile(SIDEBAR_PATH, "utf8"));

  assert.ok(
    !/visibility_pct\s*\|\|\s*0/.test(shell),
    "`visibility_pct || 0` is the finding: a missing score is not a zero"
  );
  assert.ok(
    !/visibility_pct\s*\?\?\s*0/.test(shell),
    "`?? 0` on a stored score is the same laundering with a different operator"
  );
  assert.ok(
    !/\{scan\.visibility_pct\}%/.test(sidebar),
    "the sidebar must not print a raw column next to a percent sign"
  );
});

// ---------------------------------------------------------------------------
// 6. R2.1.5 — THE LEGACY ZERO'S CHIP. A 0 WITH NO STATE IS NOT A FINDING.
//
// Found by the R2.1.1 verifier by execution: describeScanMeasurement on a
// pre-R2.1.1 row (visibility_pct 0, no state anywhere) returned label
// "Measured zero" and the detail "Measured: the answers named vendors on every
// count, and never this brand." — BYTE-IDENTICAL to a state-backed
// measured_zero. A stateless row recorded no such measurement fact, and the
// pipeline that wrote those rows produced the very same bare 0 for a dead
// engine, an empty eliciting pool and a failed probe. So the surface took the
// false zero this phase exists to kill and stated it to the user as a finding.
//
// WHAT IS AND IS NOT CHANGED:
//   - the NUMBER is untouched. The legacy tolerance (a stateless finite number
//     is measured) was ruled correct by the previous verifier and blanking
//     historical rows would erase real history. A legacy 0 still renders "0%".
//   - the CHIP and the SENTENCE change, because those are the parts that
//     claimed a measurement. Both come from one reason token, so they cannot
//     drift into disagreeing with each other.
//   - a GENUINELY measured zero must still read as a measured zero. Collapsing
//     real zeroes into "we cannot tell" would be a worse lie than the one being
//     removed, so both rows are driven through every assertion below.
//
// The distinction is a fact ON THE ROW, not a heuristic: summarizeEngineResults
// publishes `state` / `state_reason` into `summary_stats` (enginePipeline.js
// :1600-1601) and db.js round-trips that object, so a post-R2.1.1 measured zero
// carries `state: "measured_zero"` and a pre-R2.1.1 row carries no state key at
// all. PRESENCE of the state pair is the only thing these tests read, which is
// why the two fixtures below are the SAME summary with that pair deleted.
// ---------------------------------------------------------------------------

const MEASURED_ZERO_STATED_ROW = storedRow({
  id: "r-zero-stated",
  scannedAt: "2026-09-02T10:00:00Z",
  summary: MEASURED_ZERO_SUMMARY,
});

/** The same stored zero as above, minus the two fields R2.1.1 added. */
const LEGACY_ZERO_ROW = (() => {
  const { state, state_reason, ...stateless } = MEASURED_ZERO_SUMMARY;
  void state;
  void state_reason;
  return {
    ...MEASURED_ZERO_STATED_ROW,
    id: "r-zero-legacy",
    scanned_at: "2026-09-01T10:00:00Z",
    raw_results: { ...MEASURED_ZERO_STATED_ROW.raw_results, summary_stats: stateless },
  };
})();

test("premise — the two zero fixtures differ ONLY by the state pair R2.1.1 added", () => {
  const stated = MEASURED_ZERO_STATED_ROW.raw_results.summary_stats;
  const legacy = LEGACY_ZERO_ROW.raw_results.summary_stats;

  assert.strictEqual(stated.visibility_pct, 0, "premise: the stated row stores a real 0");
  assert.strictEqual(legacy.visibility_pct, 0, "premise: the legacy row stores the same 0");
  assert.equal(stated.state, ENGINE_MEASUREMENT_STATE.MEASURED_ZERO);
  assert.equal(stated.state_reason, ENGINE_STATE_REASONS.BRAND_NOT_VISIBLE);
  assert.ok(!("state" in legacy), "a pre-R2.1.1 row has no state key at all");
  assert.ok(!("state_reason" in legacy), "...and no state_reason either");
  assert.deepEqual(
    Object.keys(stated).filter((k) => k !== "state" && k !== "state_reason").sort(),
    Object.keys(legacy).sort(),
    "nothing else may differ, or an assertion below could pass for the wrong reason"
  );
});

test("ACCEPT — a stateless legacy zero and a state-backed measured zero share neither chip nor sentence", () => {
  const legacy = describeScanMeasurement(LEGACY_ZERO_ROW);
  const stated = describeScanMeasurement(MEASURED_ZERO_STATED_ROW);

  // The finding, restated as the thing that must now be false.
  assert.notEqual(
    legacy.label,
    stated.label,
    "a row that recorded no measurement must not wear the chip of one that did"
  );
  assert.notEqual(
    legacy.detail,
    stated.detail,
    "the two rows know different things, so they cannot be explained with one sentence"
  );
  assert.notEqual(legacy.reason, stated.reason, "and the tokens behind them must differ too");

  assert.equal(legacy.label, ENGINE_UNSTATED_ZERO_LABEL);
  assert.equal(stated.label, ENGINE_MEASURED_ZERO_LABEL);
  assert.equal(legacy.reason, ENGINE_READ_REASONS.LEGACY_ZERO_UNSTATED);
  assert.equal(stated.reason, ENGINE_STATE_REASONS.BRAND_NOT_VISIBLE);
});

test("ACCEPT — the legacy zero's sentence asserts no measurement that never happened", () => {
  const legacy = describeScanMeasurement(LEGACY_ZERO_ROW);

  assert.ok(legacy.detail && legacy.detail.length > 0, "a chip without words is an unexplained state");
  assert.notEqual(
    legacy.detail,
    ENGINE_STATE_REASON_DETAIL[ENGINE_STATE_REASONS.BRAND_NOT_VISIBLE],
    "this is the exact string the finding named"
  );
  assert.ok(
    !/answers named/i.test(legacy.detail),
    `nothing on this row says what the answers contained: ${legacy.detail}`
  );
  assert.ok(
    !/^Measured\b/.test(legacy.detail),
    `the sentence must not open by claiming a measurement: ${legacy.detail}`
  );
  assert.ok(
    !/never this brand/i.test(legacy.detail),
    "a stateless 0 is not evidence that the brand was absent from anything"
  );
  assert.ok(
    /cannot tell|no measurement state/i.test(legacy.detail),
    `the sentence must say what is unknown, not merely omit the claim: ${legacy.detail}`
  );
  assert.equal(legacy.label, ENGINE_UNSTATED_ZERO_LABEL);
  assert.ok(
    !/^Measured/.test(legacy.label),
    `the chip itself must not claim a measurement: ${legacy.label}`
  );
});

test("a GENUINELY measured zero still reads as a measured zero, words and all", () => {
  // The other half of the accept, and the one a careless fix breaks: if every
  // zero becomes "we cannot tell", a real finding has been deleted.
  const stated = describeScanMeasurement(MEASURED_ZERO_STATED_ROW);

  assert.equal(stated.measured, true);
  assert.equal(stated.measuredZero, true);
  assert.strictEqual(stated.pct, 0);
  assert.equal(stated.text, "0%");
  assert.equal(stated.label, ENGINE_MEASURED_ZERO_LABEL);
  assert.notEqual(stated.label, ENGINE_UNSTATED_ZERO_LABEL, "a stated zero is not an unstated one");
  assert.equal(
    stated.detail,
    ENGINE_STATE_REASON_DETAIL[ENGINE_STATE_REASONS.BRAND_NOT_VISIBLE],
    "the state-backed row DID record what the answers contained; it keeps that sentence"
  );
});

test("the legacy zero keeps its number — the tolerance the previous verifier ruled correct", () => {
  const legacy = describeScanMeasurement(LEGACY_ZERO_ROW);

  assert.equal(legacy.measured, true, "blanking historical rows would erase real history");
  assert.equal(legacy.measuredZero, true);
  assert.strictEqual(legacy.pct, 0);
  assert.equal(legacy.text, "0%");
  assert.notEqual(legacy.text, NO_MEASUREMENT_TEXT, "the fix is the wording, never the number");
  assert.strictEqual(legacy.state, null, "and it still reports that it carries no state");
});

test("the unstated-zero reason is a READ reason with its own sentence, not a producer state", () => {
  const token = ENGINE_READ_REASONS.LEGACY_ZERO_UNSTATED;
  assert.ok(token, "the token must exist to be rendered");
  assert.ok(
    !Object.values(ENGINE_STATE_REASONS).includes(token),
    "no slice can emit this; it is something a READER concluded about a stored row"
  );
  assert.ok(
    ENGINE_STATE_REASON_DETAIL[token],
    "a reason with no sentence renders a chip with an empty tooltip"
  );
});

const ZERO_HISTORY = [MEASURED_ROW, MEASURED_ZERO_STATED_ROW, LEGACY_ZERO_ROW];

/** The one card whose score element carries `reason`, by that reason. */
function cardByReason(html, reason) {
  const card = historyCards(html).find((c) => c.includes(`data-state-reason="${reason}"`));
  assert.ok(card, `no history card carried data-state-reason="${reason}"`);
  return card;
}

/** Every `title` on one card. Two different stories on one card is the bug. */
function titlesOf(chunk) {
  return [...chunk.matchAll(/title="([^"]*)"/g)].map((m) => m[1]);
}

test("ACCEPT (rendered) — the legacy zero card says unstated, and NOTHING beside it says measured", async () => {
  const html = await renderDashboardShell({ scan: MEASURED_ROW, history: ZERO_HISTORY });
  const legacyCard = cardByReason(html, ENGINE_READ_REASONS.LEGACY_ZERO_UNSTATED);
  const text = textOf(legacyCard);

  assert.ok(text.includes("0"), "the recorded 0 still reaches the screen");
  assert.ok(text.includes(ENGINE_UNSTATED_ZERO_LABEL), "and it is labelled for what it is");

  // THE SIBLING-CONTRADICTION SWEEP. R2.1.2 was failed for exactly this: the
  // number was disowned and a chip beside it still stated a confident verdict
  // derived from the same absent value. Every element of this card is read, not
  // just the one that was fixed.
  assert.ok(
    !text.includes(ENGINE_MEASURED_ZERO_LABEL),
    `a second element still calls this a measured zero: ${text}`
  );
  assert.ok(
    !legacyCard.includes(ENGINE_STATE_REASON_DETAIL[ENGINE_STATE_REASONS.BRAND_NOT_VISIBLE]),
    `the measurement sentence survives somewhere on the card (title or text): ${legacyCard}`
  );
  assert.ok(
    !text.includes(ENGINE_NOT_MEASURED_LABEL),
    "nor is it an absence: the row does carry a recorded 0"
  );
  assert.equal(
    legacyCard.split('data-testid="history-card-state"').length - 1,
    1,
    "exactly one state chip per card, or two chips are telling two stories"
  );
  const titles = new Set(titlesOf(legacyCard));
  assert.deepEqual(
    [...titles],
    [ENGINE_STATE_REASON_DETAIL[ENGINE_READ_REASONS.LEGACY_ZERO_UNSTATED]],
    "every explanation on the card must be the same one explanation"
  );
  assert.ok(
    !legacyCard.includes('data-testid="history-card-delta-state"'),
    "nothing was suppressed on this card — the 0 is a real end of a delta — so nothing may say it was"
  );

  // `data-measured="true"` IS still on this card, deliberately, and this
  // assertion exists so that choice is recorded rather than discovered later.
  // The flag means "there is a number in the column to render" — the legacy
  // tolerance, which a previous verifier ruled correct — and it is what stops
  // the surfaces printing an em dash over a real historical reading. It is the
  // CHIP beside it that says how far that number may be trusted. If the flag
  // ever has to mean "a measurement is attested", the change belongs in
  // describeScanMeasurement and both consuming components at once, not here.
  assert.ok(
    legacyCard.includes('data-measured="true"'),
    "the legacy row does carry a recorded number; flipping this flag would blank real history"
  );
});

test("ACCEPT (rendered) — the state-backed zero on the SAME screen still reads as measured", async () => {
  const html = await renderDashboardShell({ scan: MEASURED_ROW, history: ZERO_HISTORY });
  const statedCard = cardByReason(html, ENGINE_STATE_REASONS.BRAND_NOT_VISIBLE);
  const text = textOf(statedCard);

  assert.ok(statedCard.includes('data-measured="true"'), "0 is a measurement");
  assert.ok(text.includes("0"), "and it prints as the number 0, not a dash");
  assert.ok(
    text.includes(ENGINE_MEASURED_ZERO_LABEL),
    "a real measured zero must keep saying so, or this fix deleted a finding"
  );
  assert.ok(
    !text.includes(ENGINE_UNSTATED_ZERO_LABEL),
    `a state-backed zero relabelled as unstated hides a real finding: ${text}`
  );
  assert.ok(
    statedCard.includes(ENGINE_STATE_REASON_DETAIL[ENGINE_STATE_REASONS.BRAND_NOT_VISIBLE]),
    "and its own sentence is still reachable from the card"
  );
});

test("(rendered) the two zero cards are distinguishable ON SCREEN, not merely in the data", async () => {
  const html = await renderDashboardShell({ scan: MEASURED_ROW, history: ZERO_HISTORY });
  const legacy = textOf(cardByReason(html, ENGINE_READ_REASONS.LEGACY_ZERO_UNSTATED));
  const stated = textOf(cardByReason(html, ENGINE_STATE_REASONS.BRAND_NOT_VISIBLE));

  assert.notEqual(
    legacy.replace(/^\S+ \d+,? ?\d*/, ""),
    stated.replace(/^\S+ \d+,? ?\d*/, ""),
    "with the timestamps discounted, two cards reading identically is the finding itself"
  );
  assert.ok(legacy.includes("0") && stated.includes("0"), "both still show the 0 they recorded");
});

test("(rendered) any delta shown beside a zero card is the difference of the two numbers on screen", async () => {
  // The deliberate decision, pinned: this fix disowns the PROVENANCE of a
  // legacy 0, not the 0 itself, so the delta beside it stays computable — and
  // it must equal the arithmetic a reader can do with the two cards in front of
  // them. A delta that cannot be recomputed from the visible numbers is a
  // confident claim from somewhere else, which is what this assertion catches.
  const html = await renderDashboardShell({ scan: MEASURED_ROW, history: ZERO_HISTORY });
  const cards = historyCards(html);
  const scoreOf = (card) => {
    const m = /^[^>]*>(-?\d+(?:\.\d+)?)<small>%<\/small>/.exec(card);
    return m ? parseFloat(m[1]) : null;
  };
  const deltaOf = (card) => {
    const m = /class="(?:up|dn|flat)">([+-]?\d+(?:\.\d+)?)</.exec(card);
    return m ? parseFloat(m[1]) : null;
  };

  assert.deepEqual(cards.map(scoreOf), [40, 0, 0], "premise: three readings, newest first");
  // Card i is compared with card i-1 (the reading AFTER it in time).
  cards.forEach((card, i) => {
    const shown = deltaOf(card);
    if (i === 0) {
      assert.strictEqual(shown, null, "the newest card has nothing later to compare with");
      return;
    }
    assert.strictEqual(
      shown,
      scoreOf(cards[i - 1]) - scoreOf(card),
      `card ${i} shows a delta that does not follow from the two numbers on screen`
    );
  });
});

test("(rendered) the sidebar carries the unstated sentence, and not the measured one", async () => {
  const html = await renderSidebar({
    brand: "Acme",
    view: "overview",
    onViewChange() {},
    history: [MEASURED_ZERO_STATED_ROW, LEGACY_ZERO_ROW],
  });
  const [stated, legacy] = sidebarScores(html);

  assert.ok(legacy.includes(`data-state-reason="${ENGINE_READ_REASONS.LEGACY_ZERO_UNSTATED}"`));
  assert.ok(
    legacy.includes(ENGINE_STATE_REASON_DETAIL[ENGINE_READ_REASONS.LEGACY_ZERO_UNSTATED]),
    "the sidebar's only room for the reason is the title; it must be the right reason"
  );
  assert.ok(
    !legacy.includes(ENGINE_STATE_REASON_DETAIL[ENGINE_STATE_REASONS.BRAND_NOT_VISIBLE]),
    `the sidebar row still claims a measurement: ${legacy}`
  );
  assert.equal(textOf(contentOf(legacy)), "0%", "the recorded 0 is still the number on screen");
  assert.ok(
    stated.includes(ENGINE_STATE_REASON_DETAIL[ENGINE_STATE_REASONS.BRAND_NOT_VISIBLE]),
    "and the state-backed zero in the same list keeps its own sentence"
  );
});

test("GUARD — no surface hard-codes either zero chip's wording", async () => {
  // Both chips come from the shared reader. A component that spelled one out
  // would keep saying it after this module changed its mind.
  const shell = await readFile(SHELL_PATH, "utf8");
  const sidebar = await readFile(SIDEBAR_PATH, "utf8");
  for (const [name, source] of [["DashboardShell.jsx", shell], ["Sidebar.jsx", sidebar]]) {
    assert.ok(
      !source.includes(ENGINE_MEASURED_ZERO_LABEL),
      `${name} spells out "${ENGINE_MEASURED_ZERO_LABEL}" instead of rendering score.label`
    );
    assert.ok(
      !source.includes(ENGINE_UNSTATED_ZERO_LABEL),
      `${name} spells out "${ENGINE_UNSTATED_ZERO_LABEL}" instead of rendering score.label`
    );
  }
});
