import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

import * as apiClient from "../../shared/api.js";
import * as formatModule from "../../shared/format.js";
import * as aliasesModule from "../../shared/scoring/aliases.js";
import * as brandKeyModule from "../../shared/scoring/brandKey.js";
import * as aioConstantsModule from "../../shared/scoring/aioConstants.js";
import * as enginePipelineModule from "../../shared/scoring/enginePipeline.js";

/**
 * R2.1.3 — UI chips for did-not-report / not-assessed / small-sample; render engines_counted.
 *
 * Requirements:
 * 1. Each of the three chips renders in its own distinct state:
 *    - did-not-report: rendered when an engine failed to report or was dropped
 *    - not-assessed: rendered when a scan or engine reading was not assessed
 *    - small-sample: rendered when insufficient_sample is flagged
 * 2. engines_counted appears on the dashboard (DashboardShell.jsx):
 *    - renders the integer count when available (e.g. "2 engines counted")
 *    - renders an em dash ("— engines counted") when absent, NEVER coercing null to 0
 * 3. Zero null coercion:
 *    - an unmeasured hero score never paints "Weak" or "0%"
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_PATH = path.join(HERE, "DashboardShell.jsx");
const SCORE_BAND_PATH = path.join(HERE, "ScoreBand.jsx");

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

async function loadJsx(filePath, requireShim, ReactImpl) {
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
  factory(requireShim, moduleRecord, moduleRecord.exports, ReactImpl);
  return moduleRecord.exports;
}

async function loadScoreBand() {
  return loadJsx(
    SCORE_BAND_PATH,
    (specifier) => {
      throw new Error(`ScoreBand.jsx unexpectedly imports "${specifier}"`);
    },
    React
  );
}

async function renderDashboardShell(props) {
  const patchedReact = { ...React, useEffect: makeUseEffectShim(), __esModule: true };
  patchedReact.default = patchedReact;

  const scoreBandModule = { ...(await loadScoreBand()), __esModule: true };

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
    ["@/components/dashboard/ScoreBand", scoreBandModule],
    ["@/shared/api", apiStub],
    ["@/shared/format", formatModule],
    ["@/shared/scoring/aliases", aliasesModule],
    ["@/shared/scoring/brandKey", brandKeyModule],
    ["@/shared/scoring/aioConstants", aioConstantsModule],
    ["@/shared/scoring/enginePipeline", enginePipelineModule],
  ]);

  const requireShim = (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    if (specifier.startsWith("@/components/") || specifier.startsWith("@/server/") || specifier.startsWith("@/shared/")) {
      return anyNamedExport;
    }
    throw new Error(`DashboardShell imports unexpected: "${specifier}"`);
  };

  const shellModule = await loadJsx(SHELL_PATH, requireShim, patchedReact);
  const Shell = shellModule.default;

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

function baseScan(overrides = {}) {
  const results = [
    {
      query: "hospital crm software",
      engine: "aio",
      aio_present: true,
      brand_mentioned: true,
      is_branded_query: false,
      aio_text: "Acme is a leader in hospital CRM.",
      aio_references: [],
    },
  ];
  return {
    id: "scan-r2-1-3",
    brand: "Acme",
    url: "acme.com",
    website: "acme.com",
    scanned_at: "2026-09-01T12:00:00.000Z",
    visibility_pct: 50,
    prompts_tracked: 1,
    prompts_mentioned: 1,
    competitors: [],
    results,
    raw_results: {
      results,
      summary_stats: {
        visibility_pct: 50,
        mention_rate_pct: 50,
        non_branded_queries: 1,
        non_branded_with_aio: 1,
        visible_non_branded: 1,
        aio_coverage_pct: 100,
        error_rate_pct: 0,
        data_source_issue: false,
        insufficient_sample: false,
      },
      engines_counted: 2,
      visibility_index_pct: 50,
      engines: {
        aio: {
          engine: "aio",
          share_of_ai_pct: 50,
          non_branded_queries: 1,
          non_branded_with_answer: 1,
          error_rate_pct: 0,
          degraded: false,
        },
      },
      scoring_version: "v7-multi",
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. engines_counted rendering on DashboardShell
// ---------------------------------------------------------------------------

test("R2.1.3 ACCEPT — engines_counted appears on the dashboard with integer value", async () => {
  const html = await renderDashboardShell({
    scan: baseScan({
      raw_results: {
        ...baseScan().raw_results,
        engines_counted: 3,
      },
    }),
  });
  assert.ok(
    html.includes('data-testid="dashboard-engines-counted"'),
    "dashboard must render data-testid=\"dashboard-engines-counted\""
  );
  assert.ok(html.includes("3 engines counted"), "dashboard must render '3 engines counted'");
});

test("R2.1.3 ACCEPT — engines_counted = 1 renders singular '1 engine counted'", async () => {
  const html = await renderDashboardShell({
    scan: baseScan({
      raw_results: {
        ...baseScan().raw_results,
        engines_counted: 1,
      },
    }),
  });
  assert.ok(html.includes("1 engine counted"), "must render singular '1 engine counted'");
});

test("R2.1.3 ACCEPT — null engines_counted renders em dash, NEVER coercing to 0", async () => {
  const html = await renderDashboardShell({
    scan: baseScan({
      raw_results: {
        ...baseScan().raw_results,
        engines_counted: null,
      },
    }),
  });
  assert.ok(
    html.includes('data-testid="dashboard-engines-counted"'),
    "dashboard must still render the engines_counted slot"
  );
  assert.ok(
    html.includes("— engines counted"),
    "unmeasured engines_counted must render em dash, not 0"
  );
  assert.ok(
    !html.includes('data-testid="dashboard-engines-counted">0 engines counted<'),
    "null engines_counted must NEVER coerce to '0 engines counted'"
  );
});

test("R2.1.3 ACCEPT — measured zero engines_counted (0) renders '0 engines counted'", async () => {
  const html = await renderDashboardShell({
    scan: baseScan({
      raw_results: {
        ...baseScan().raw_results,
        engines_counted: 0,
      },
    }),
  });
  assert.ok(
    html.includes("0 engines counted"),
    "a genuinely measured 0 must render '0 engines counted'"
  );
});

// ---------------------------------------------------------------------------
// 2. The three UI chips: did-not-report, not-assessed, small-sample
// ---------------------------------------------------------------------------

test("R2.1.3 ACCEPT — did-not-report chip renders in its own distinct state", async () => {
  const html = await renderDashboardShell({
    scan: baseScan({
      raw_results: {
        ...baseScan().raw_results,
        engines: {
          aio: {
            engine: "aio",
            share_of_ai_pct: 50,
            non_branded_queries: 1,
            non_branded_with_answer: 1,
            error_rate_pct: 0,
          },
          perplexity: {
            engine: "perplexity",
            share_of_ai_pct: null,
            state: "did-not-report",
            state_reason: "no_results",
            non_branded_queries: 0,
          },
        },
      },
    }),
  });

  // 1. Dashboard topbar chip
  assert.ok(
    html.includes('data-testid="chip-did-not-report"'),
    "topbar must render data-testid=\"chip-did-not-report\""
  );
  assert.ok(html.includes("Did not report"), "must render text 'Did not report'");

  // 2. ScoreBand per-engine chip
  assert.ok(
    html.includes('data-engine-chip-state="did-not-report"'),
    "per-engine chip must carry data-engine-chip-state=\"did-not-report\""
  );
  assert.ok(
    html.includes("· did not report"),
    "per-engine chip must render label '· did not report'"
  );
});

test("R2.1.3 ACCEPT — not-assessed chip renders in its own distinct state", async () => {
  const html = await renderDashboardShell({
    scan: baseScan({
      visibility_pct: null,
      raw_results: {
        ...baseScan().raw_results,
        visibility_index_pct: null,
        summary_stats: {
          ...baseScan().raw_results.summary_stats,
          visibility_pct: null,
          state: "not_assessed",
        },
        engines: {
          aio: {
            engine: "aio",
            share_of_ai_pct: null,
            state: "not-assessed",
            state_reason: "empty_eliciting_pool",
          },
        },
      },
    }),
  });

  // 1. Dashboard topbar chip
  assert.ok(
    html.includes('data-testid="chip-not-assessed"'),
    "topbar must render data-testid=\"chip-not-assessed\""
  );
  assert.ok(html.includes("Not assessed"), "must render text 'Not assessed'");

  // 2. ScoreBand per-engine chip
  assert.ok(
    html.includes('data-engine-chip-state="not-assessed"'),
    "per-engine chip must carry data-engine-chip-state=\"not-assessed\""
  );
  assert.ok(
    html.includes("· not assessed"),
    "per-engine chip must render label '· not assessed'"
  );
});

test("R2.1.3 ACCEPT — small-sample chip renders in its own distinct state", async () => {
  const html = await renderDashboardShell({
    scan: baseScan({
      raw_results: {
        ...baseScan().raw_results,
        summary_stats: {
          ...baseScan().raw_results.summary_stats,
          insufficient_sample: true,
        },
      },
    }),
  });

  assert.ok(
    html.includes('data-testid="chip-small-sample"'),
    "must render data-testid=\"chip-small-sample\""
  );
  assert.ok(html.includes("Small sample"), "must render text 'Small sample'");
});

// ---------------------------------------------------------------------------
// 3. Sabotage & Scoring Honesty: Null scores never render 'Weak' or '0%'
// ---------------------------------------------------------------------------

test("R2.1.3 SABOTAGE — null score on not-assessed scan never renders 'Weak' or '0%'", async () => {
  const html = await renderDashboardShell({
    scan: baseScan({
      visibility_pct: null,
      raw_results: {
        ...baseScan().raw_results,
        visibility_index_pct: null,
        summary_stats: {
          ...baseScan().raw_results.summary_stats,
          visibility_pct: null,
          state: "not_assessed",
        },
        engines: {
          aio: {
            engine: "aio",
            share_of_ai_pct: null,
            state: "not-assessed",
            state_reason: "empty_eliciting_pool",
          },
        },
      },
    }),
  });

  // ScoreBand panel header must NOT contain "Weak" or tier chips
  const scoreBandIdx = html.indexOf('data-testid="score-band"');
  assert.notEqual(scoreBandIdx, -1);
  const bandHeaderEnd = html.indexOf('class="panel__b"', scoreBandIdx);
  const bandHeader = html.slice(scoreBandIdx, bandHeaderEnd);

  assert.ok(!bandHeader.includes("Weak"), "must NOT render 'Weak' badge beside null score");
  assert.ok(!bandHeader.includes("chip--crit"), "must NOT render critical chip beside null score");
  assert.ok(!bandHeader.includes("0%"), "must NOT render '0%' on null score hero");
});
