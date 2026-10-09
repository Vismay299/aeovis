import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

import * as apiClient from "../../services/api.js";
import * as formatModule from "../../utils/format.js";
import * as aliasesModule from "../../lib/scoring/aliases.js";
import * as brandKeyModule from "../../lib/scoring/brandKey.js";
import * as aioConstantsModule from "../../lib/scoring/aioConstants.js";
import * as enginePipelineModule from "../../lib/scoring/enginePipeline.js";
import * as rosterContinuityModule from "../../lib/scoring/rosterContinuity.js";
import * as interlockingModule from "./interlocking.js";

/**
 * R2.7.13 — Stop Degraded Banner Null-to-0/100% Metric Coercion
 *
 * PROVES:
 * 1. For a zero-answer critical scan, the degraded-engine banner renders an
 *    em-dash (—) for coverage and error rate rather than fabricated percentages
 *    (such as 100% or 0%).
 * 2. Positive case: genuinely measured coverage and error rate metrics continue
 *    to print their percentages inside the degraded banner.
 * 3. Both per-engine slices and legacy single-engine fallback banner rows are
 *    tested under null and positive states.
 * 4. ScoreBand stats array renders "—" rather than "0/0", "0%", or "0" when
 *    metrics are unmeasured/nullish.
 * 5. ScoreBand hero score renders "—" without an unearned "%" unit when score
 *    is not numeric.
 * 6. HomeDashboard safely renders unmeasured scores with em-dash and neutral chip.
 * 7. OverviewView unmeasured KPIs render em-dash without percent sign.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_PATH = path.join(HERE, "DashboardShell.jsx");
const HOME_PATH = path.join(HERE, "..", "home", "HomeDashboard.jsx");
const SCORE_BAND_PATH = path.join(HERE, "ScoreBand.jsx");
const OVERVIEW_PATH = path.join(HERE, "OverviewView.jsx");

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

async function renderDashboardShell(props) {
  const source = await readFile(SHELL_PATH, "utf8");
  const { code } = transform(source, {
    transforms: ["jsx", "imports"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    filePath: SHELL_PATH,
  });

  const patchedReact = { ...React, useEffect: makeUseEffectShim(), __esModule: true };
  patchedReact.default = patchedReact;

  const apiStub = {
    ...apiClient,
    __esModule: true,
    fetchScanHistory: () => new Promise(() => {}),
  };

  const modules = new Map([
    ["react", patchedReact],
    ["lucide-react", anyNamedExport],
    [
      "next/navigation",
      {
        __esModule: true,
        useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {} }),
        usePathname: () => "/dashboard",
        useSearchParams: () => new URLSearchParams(),
      },
    ],
    ["@/services/api", apiStub],
    ["@/utils/format", formatModule],
    ["@/lib/scoring/aliases", aliasesModule],
    ["@/lib/scoring/brandKey", brandKeyModule],
    ["@/lib/scoring/aioConstants", aioConstantsModule],
    ["@/lib/scoring/enginePipeline", enginePipelineModule],
  ]);

  const scoreBandSource = await readFile(SCORE_BAND_PATH, "utf8");
  const { code: scoreBandCode } = transform(scoreBandSource, {
    transforms: ["jsx", "imports"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    filePath: SCORE_BAND_PATH,
  });
  const scoreBandModule = { exports: {} };
  // eslint-disable-next-line no-new-func
  const scoreBandFactory = new Function("require", "module", "exports", "React", scoreBandCode);
  scoreBandFactory((spec) => (spec === "react" ? patchedReact : anyNamedExport), scoreBandModule, scoreBandModule.exports, patchedReact);
  modules.set("@/components/dashboard/ScoreBand", { ...scoreBandModule.exports, __esModule: true });

  const requireShim = (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    if (specifier.startsWith("@/components/") || specifier.startsWith("@/lib/")) {
      return anyNamedExport;
    }
    throw new Error(
      `DashboardShell imports "${specifier}", which this render harness does not resolve.`
    );
  };

  const moduleRecord = { exports: {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function("require", "module", "exports", "React", code);
  factory(requireShim, moduleRecord, moduleRecord.exports, patchedReact);

  const Shell = moduleRecord.exports.default;
  assert.equal(typeof Shell, "function", "DashboardShell.jsx must default-export a component");

  const realFetch = globalThis.fetch;
  const realSetInterval = globalThis.setInterval;
  globalThis.fetch = () => new Promise(() => {});
  globalThis.setInterval = () => 0;
  try {
    return renderToStaticMarkup(React.createElement(Shell, props));
  } finally {
    globalThis.fetch = realFetch;
    globalThis.setInterval = realSetInterval;
  }
}

function textOf(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function blockOf(html, testId) {
  const marker = `data-testid="${testId}"`;
  const at = html.indexOf(marker);
  assert.notEqual(at, -1, `no element carries ${marker}`);
  const start = html.lastIndexOf("<div", at);
  let depth = 0;
  let i = start;
  const tag = /<\/?div\b[^>]*>/g;
  tag.lastIndex = start;
  let m;
  while ((m = tag.exec(html)) !== null) {
    depth += m[0].startsWith("</") ? -1 : 1;
    i = m.index + m[0].length;
    if (depth === 0) break;
  }
  assert.equal(depth, 0, `unbalanced markup around ${marker}`);
  return html.slice(start, i);
}

// ---------------------------------------------------------------------------
// 1. Degraded banner on a zero-answer critical scan: NO fake percentages
// ---------------------------------------------------------------------------

test("R2.7.13 ACCEPT — a zero-answer critical scan (legacy fallback) renders em-dashes and no percentages in the banner", async () => {
  // A legacy scan with data_source_issue true and no per-engine slices.
  // Coverage and error rate were never measured (null).
  const scan = {
    id: "zero-answer-legacy-scan",
    brand: "Acme",
    url: "acme.com",
    scanned_at: "2026-09-12T00:00:00.000Z",
    results: [],
    raw_results: {
      results: [],
      summary_stats: {
        data_source_issue: true,
        aio_coverage_pct: null,
        error_rate_pct: null,
        non_branded_queries: 0,
        non_branded_with_aio: 0,
        visible_non_branded: 0,
      },
    },
  };

  const html = await renderDashboardShell({ scan });
  assert.ok(
    html.includes('data-testid="data-source-issue-banner"'),
    "critical degradation must render data-source-issue-banner"
  );

  const bannerHtml = blockOf(html, "data-source-issue-banner");
  const bannerText = textOf(bannerHtml);

  // Assert it contains the em-dash for unmeasured metrics
  assert.ok(bannerText.includes("—"), "banner must render an em dash for unmeasured metrics");

  // The banner rows should NOT contain "100%" or "0%" for coverage/error
  const rowMatches = bannerHtml.match(/<span class="row__v">([^<]*)<\/span>/g) || [];
  assert.ok(rowMatches.length >= 2, "must render coverage and error rate rows");
  for (const row of rowMatches) {
    const val = textOf(row);
    assert.equal(val, "—", `expected unmeasured row value to be "—", got "${val}"`);
    assert.ok(!val.includes("%"), `row value must not claim a percentage, got "${val}"`);
  }
});

test("R2.7.13 ACCEPT — a zero-answer critical scan (per-engine) renders em-dashes and no percentages in the banner", async () => {
  const scan = {
    id: "zero-answer-per-engine-scan",
    brand: "Acme",
    url: "acme.com",
    scanned_at: "2026-09-12T00:00:00.000Z",
    results: [],
    raw_results: {
      results: [],
      summary_stats: {
        data_source_issue: true,
      },
      engines: {
        aio: {
          engine: "aio",
          data_source_issue: true,
          coverage_pct: null,
          error_rate_pct: null,
          non_branded_queries: 10,
          non_branded_with_answer: 0,
        },
      },
    },
  };

  const html = await renderDashboardShell({ scan });
  assert.ok(
    html.includes('data-testid="data-source-issue-banner"'),
    "critical degradation must render data-source-issue-banner"
  );

  const bannerHtml = blockOf(html, "data-source-issue-banner");
  const rowMatches = bannerHtml.match(/<span class="row__v">([^<]*)<\/span>/g) || [];
  assert.ok(rowMatches.length >= 2, "must render per-engine coverage and error rate rows");
  for (const row of rowMatches) {
    const val = textOf(row);
    assert.equal(val, "—", `expected per-engine row value to be "—", got "${val}"`);
    assert.ok(!val.includes("%"), `row value must not claim a percentage, got "${val}"`);
  }
});

// ---------------------------------------------------------------------------
// 2. Positive cases: genuinely measured metrics DO print their percentages
// ---------------------------------------------------------------------------

test("R2.7.13 POSITIVE — genuinely measured legacy metrics still print their percentages in the banner", async () => {
  const scan = {
    id: "measured-legacy-critical-scan",
    brand: "Acme",
    url: "acme.com",
    scanned_at: "2026-09-12T00:00:00.000Z",
    results: [],
    raw_results: {
      results: [],
      summary_stats: {
        data_source_issue: true,
        aio_coverage_pct: 12.5,
        error_rate_pct: 55,
      },
    },
  };

  const html = await renderDashboardShell({ scan });
  const bannerHtml = blockOf(html, "data-source-issue-banner");
  const rowMatches = (bannerHtml.match(/<span class="row__v">([^<]*)<\/span>/g) || []).map(textOf);

  assert.ok(rowMatches.includes("12.5%"), "measured coverage of 12.5% must be printed");
  assert.ok(rowMatches.includes("55%"), "measured error rate of 55% must be printed");
});

test("R2.7.13 POSITIVE — genuinely measured per-engine metrics still print their percentages in the banner", async () => {
  const scan = {
    id: "measured-per-engine-critical-scan",
    brand: "Acme",
    url: "acme.com",
    scanned_at: "2026-09-12T00:00:00.000Z",
    results: [],
    raw_results: {
      results: [],
      summary_stats: {
        data_source_issue: true,
      },
      engines: {
        aio: {
          engine: "aio",
          data_source_issue: true,
          coverage_pct: 10.5,
          error_rate_pct: 62,
          non_branded_queries: 20,
          non_branded_with_answer: 2,
        },
      },
    },
  };

  const html = await renderDashboardShell({ scan });
  const bannerHtml = blockOf(html, "data-source-issue-banner");
  const rowMatches = (bannerHtml.match(/<span class="row__v">([^<]*)<\/span>/g) || []).map(textOf);

  assert.ok(rowMatches.includes("10.5%"), "measured per-engine coverage of 10.5% must be printed");
  assert.ok(rowMatches.includes("62%"), "measured per-engine error rate of 62% must be printed");
});

// ---------------------------------------------------------------------------
// 3. ScoreBand stats array: no null-to-0 coercion
// ---------------------------------------------------------------------------

test("R2.7.13 ACCEPT — ScoreBand stats array renders em-dash rather than 0, 0% or 0/0 when unmeasured", async () => {
  const results = Array.from({ length: 10 }, (_, i) => ({
    query: `crm prompt ${i}`,
    engine: "aio",
    aio_present: true,
    brand_mentioned: false,
    is_branded_query: false,
    aio_text: "Several vendors compete.",
    aio_references: [],
  }));

  const scan = {
    id: "unmeasured-stats-scan",
    brand: "Acme",
    url: "acme.com",
    website: "acme.com",
    scanned_at: "2026-09-12T00:00:00.000Z",
    visibility_pct: 50,
    results,
    raw_results: {
      results,
      summary_stats: {
        data_source_issue: false,
        visibility_pct: 50,
        visible_non_branded: null,
        non_branded_with_aio: 0,
        aio_coverage_pct: null,
        prompts_tracked: null,
      },
      engines: {
        aio: {
          engine: "aio",
          data_source_issue: false,
          share_of_ai_pct: 50,
          non_branded_queries: 10,
          non_branded_with_answer: 10,
          error_rate_pct: 0,
        },
      },
    },
  };

  const html = await renderDashboardShell({ scan });
  assert.ok(html.includes('data-testid="score-band"'), "ScoreBand should render");

  // In the stats array, neither 0/0 nor 0% should be printed
  assert.ok(!html.includes("0/0"), 'stats array must not print "0/0"');
  assert.ok(!html.includes(">0%<"), 'stats array must not print "0%" for unmeasured coverage');
});

// ---------------------------------------------------------------------------
// 4. ScoreBand hero score: no unearned percent sign on unmeasured score
// ---------------------------------------------------------------------------

test("R2.7.13 ACCEPT — ScoreBand hero score renders em-dash without percent unit when unmeasured", async () => {
  const source = await readFile(SCORE_BAND_PATH, "utf8");
  const { code } = transform(source, {
    transforms: ["jsx", "imports"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    filePath: SCORE_BAND_PATH,
  });

  const moduleRecord = { exports: {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function("require", "module", "exports", "React", code);
  factory(() => anyNamedExport, moduleRecord, moduleRecord.exports, React);

  const ScoreBand = moduleRecord.exports.ScoreBand;
  const nullScoreHtml = renderToStaticMarkup(
    React.createElement(ScoreBand, {
      score: null,
      tier: null,
    })
  );

  const numElementMatch = nullScoreHtml.match(/<div class="num"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(numElementMatch, "must render .num element");
  const numContent = textOf(numElementMatch[1]);
  assert.equal(numContent, "—", `expected hero score to be "—" without "%", got "${numContent}"`);
  assert.ok(!numElementMatch[1].includes("%"), "unmeasured hero score must not include %");

  // Positive case: measured score renders with %
  const measuredScoreHtml = renderToStaticMarkup(
    React.createElement(ScoreBand, {
      score: 42,
      tier: "Moderate",
    })
  );
  const measuredNumMatch = measuredScoreHtml.match(/<div class="num"[^>]*>([\s\S]*?)<\/div>/);
  assert.ok(textOf(measuredNumMatch[1]).includes("42"), "measured score must include 42");
  assert.ok(measuredNumMatch[1].includes("%"), "measured score must include %");
});

// ---------------------------------------------------------------------------
// 5. HomeDashboard: scoreChip and score value for null/NaN scores
// ---------------------------------------------------------------------------

test("R2.7.13 ACCEPT — HomeDashboard safely renders unmeasured scores with em-dash and neutral chip", async () => {
  const source = await readFile(HOME_PATH, "utf8");
  const { code } = transform(source, {
    transforms: ["jsx", "imports"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    filePath: HOME_PATH,
  });

  const modules = new Map([
    ["react", React],
    ["lucide-react", anyNamedExport],
    [
      "next/navigation",
      {
        __esModule: true,
        useRouter: () => ({ push() {}, replace() {} }),
      },
    ],
    ["@/services/api", { __esModule: true, fetchScanHistory: () => Promise.resolve({ data: [] }), saveScan: () => {} }],
    ["@/utils/format", formatModule],
    ["@/lib/historyStoreState", { historyLoadState: () => ({ status: "ready", scans: [] }) }],
    ["@/lib/scoring/enginePipeline", {
      __esModule: true,
      describeScanMeasurement: (row) => {
        const pct = row?.score != null ? Number(row.score) : null;
        if (pct === null || !Number.isFinite(pct)) {
          return { measured: false, measuredZero: false, pct: null, text: '—', state: null, reason: null, label: 'not measured', detail: '' };
        }
        return { measured: true, measuredZero: pct === 0, pct, text: `${pct}%`, state: 'measured', reason: null, label: 'measured', detail: '' };
      },
    }],
  ]);

  const moduleRecord = { exports: {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function("require", "module", "exports", "React", code);
  factory((spec) => modules.get(spec) || anyNamedExport, moduleRecord, moduleRecord.exports, React);

  const HomeDashboard = moduleRecord.exports.HomeDashboard || moduleRecord.exports.default;

  // Render HomeDashboard with initialData
  const html = renderToStaticMarkup(
    React.createElement(HomeDashboard, {
      initialData: {
        scans: [
          { brand: "NullScoreBrand", score: null, scanned_at: "2026-09-12T00:00:00Z" },
          { brand: "NanScoreBrand", score: NaN, scanned_at: "2026-09-12T00:00:00Z" },
          { brand: "ZeroScoreBrand", score: 0, scanned_at: "2026-09-12T00:00:00Z" },
        ],
        runs: [],
        activeJobs: [],
      },
    })
  );

  assert.ok(html.includes("NullScoreBrand"));
  assert.ok(!html.includes("NaN%"), "must never render NaN%");

  // NullScoreBrand should have class="chip" (neutral) and "—"
  const nullCardMatch = html.match(/NullScoreBrand<\/b><span class="([^"]*)">([^<]*)<\/span>/);
  assert.ok(nullCardMatch, "must find score chip for NullScoreBrand");
  assert.equal(nullCardMatch[1], "chip", "unmeasured score chip must be neutral class 'chip'");
  assert.equal(nullCardMatch[2], "—", "unmeasured score must render '—'");

  // NanScoreBrand should also be neutral "chip" and "—"
  const nanCardMatch = html.match(/NanScoreBrand<\/b><span class="([^"]*)">([^<]*)<\/span>/);
  assert.ok(nanCardMatch, "must find score chip for NanScoreBrand");
  assert.equal(nanCardMatch[1], "chip", "NaN score chip must be neutral class 'chip'");
  assert.equal(nanCardMatch[2], "—", "NaN score must render '—'");

  // Measured zero brand SHOULD have chip--crit and "0%" (standing rule 1)
  const zeroCardMatch = html.match(/ZeroScoreBrand<\/b><span class="([^"]*)">([^<]*)<\/span>/);
  assert.ok(zeroCardMatch, "must find score chip for ZeroScoreBrand");
  assert.equal(zeroCardMatch[1], "chip chip--crit", "measured zero must be chip--crit");
  assert.equal(zeroCardMatch[2], "0%", "measured zero must render 0%");
});

// ---------------------------------------------------------------------------
// 6. OverviewView: unmeasured KPIs render em-dash without unearned percent sign
// ---------------------------------------------------------------------------

test("R2.7.13 ACCEPT — OverviewView unmeasured KPIs render em-dash without percent sign", async () => {
  const source = await readFile(OVERVIEW_PATH, "utf8");
  const { code } = transform(source, {
    transforms: ["jsx", "imports"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    filePath: OVERVIEW_PATH,
  });

  const modules = new Map([
    ["react", React],
    ["lucide-react", anyNamedExport],
    ["./interlocking", interlockingModule],
    ["@/lib/scoring/rosterContinuity", rosterContinuityModule],
    ["./OverviewAnalytics", { __esModule: true, OverviewAnalytics: nullComponent }],
  ]);

  const moduleRecord = { exports: {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function("require", "module", "exports", "React", code);
  factory((spec) => modules.get(spec) || anyNamedExport, moduleRecord, moduleRecord.exports, React);

  const OverviewView = moduleRecord.exports.OverviewView || moduleRecord.exports.default;

  const html = renderToStaticMarkup(
    React.createElement(OverviewView, {
      result: { brand: "Acme", website: "acme.com", rawResults: [] },
      dataSourceIssue: false,
      aioCoverage: null,
      presenceRate: null,
      promptsTracked: null,
      promptsAnalyzed: null,
      nonBrandedWithAio: null,
      visibleCount: null,
      competitorsFound: null,
      heroScore: null,
      tier: null,
    })
  );

  const coverageKpi = blockOf(html, "kpi-aio-coverage");
  const coverageVal = coverageKpi.match(/<span class="stat__v"[^>]*>([\s\S]*?)<\/span>/);
  assert.ok(coverageVal, "kpi-aio-coverage must have stat__v");
  assert.equal(textOf(coverageVal[1]), "—", "unmeasured coverage KPI must be '—'");
  assert.ok(!coverageVal[1].includes("%"), "unmeasured coverage KPI must not include %");

  const presenceKpi = blockOf(html, "kpi-presence");
  const presenceVal = presenceKpi.match(/<span class="stat__v[^"]*"[^>]*>([\s\S]*?)<\/span>/);
  assert.ok(presenceVal, "kpi-presence must have stat__v");
  assert.equal(textOf(presenceVal[1]), "—", "unmeasured presence KPI must be '—'");
  assert.ok(!presenceVal[1].includes("%"), "unmeasured presence KPI must not include %");

  const promptsKpi = blockOf(html, "kpi-prompts");
  const promptsVal = promptsKpi.match(/<span class="stat__v"[^>]*>([\s\S]*?)<\/span>/);
  assert.ok(promptsVal, "kpi-prompts must have stat__v");
  assert.equal(textOf(promptsVal[1]), "—", "unmeasured prompts KPI must be '—'");
});
