/**
 * R6.4.3 — vendor/infra guard.
 *
 * Bright Data, MiMo and Firecrawl are infrastructure vendors — they power the
 * scan but the customer never sees their names. Engine names (ChatGPT,
 * Perplexity, Gemini) are user-facing labels that describe WHERE the brand
 * appears.
 *
 * This guard renders the dashboard with real engine data and checks both
 * directions:
 *   1. Vendor names must be ABSENT from the rendered HTML.
 *   2. Engine names must be PRESENT in the rendered HTML.
 *
 * The guard fails in both directions on a deliberate violation — proven by
 * the two "proof" tests at the end that simulate each failure mode.
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import {
  compileJsx,
  renderToHtml,
  textOf,
  makeUseEffectShim,
  anyNamedExport,
} from "../../server/renderHarness.mjs";

import * as apiClient from "../../shared/api.js";
import * as formatModule from "../../shared/format.js";
import * as aliasesModule from "../../shared/scoring/aliases.js";
import * as brandKeyModule from "../../shared/scoring/brandKey.js";
import * as aioConstantsModule from "../../shared/scoring/aioConstants.js";
import * as enginePipelineModule from "../../shared/scoring/enginePipeline.js";

// ---------------------------------------------------------------------------
// Vendor names that must NEVER appear in user-visible rendered output.
// ---------------------------------------------------------------------------

const FORBIDDEN_VENDORS = [
  "Bright Data",
  "brightdata",
  "BrightData",
  "MiMo",
  "mimo",
  "Firecrawl",
  "firecrawl",
];

// ---------------------------------------------------------------------------
// Engine names that MUST appear when the scan includes those engines.
// ---------------------------------------------------------------------------

const REQUIRED_ENGINES = ["ChatGPT", "Perplexity", "Gemini"];

// ---------------------------------------------------------------------------
// Fixture: a multi-engine scan that includes chatgpt, perplexity and gemini.
// ---------------------------------------------------------------------------

function multiEngineScan() {
  const results = [
    { query: "best crm", engine: "aio", aio_present: true, brand_mentioned: true, is_branded_query: false, aio_text: "Acme.", aio_references: [] },
    { query: "crm comparison", engine: "aio", aio_present: false, brand_mentioned: false, is_branded_query: false, aio_text: "", aio_references: [] },
    { query: "best crm", engine: "chatgpt", brand_mentioned: true, is_branded_query: false, answer_text: "Acme is top.", references: [] },
    { query: "crm comparison", engine: "chatgpt", brand_mentioned: false, is_branded_query: false, answer_text: "Several options.", references: [] },
    { query: "best crm", engine: "perplexity", brand_mentioned: true, is_branded_query: false, answer_text: "Acme.", references: [] },
    { query: "crm comparison", engine: "perplexity", brand_mentioned: false, is_branded_query: false, answer_text: "Others exist.", references: [] },
    { query: "best crm", engine: "gemini", brand_mentioned: true, is_branded_query: false, answer_text: "Acme is good.", references: [] },
    { query: "crm comparison", engine: "gemini", brand_mentioned: false, is_branded_query: false, answer_text: "Options.", references: [] },
  ];
  const summary_stats = {
    visibility_pct: 62.5,
    mention_rate_pct: 50,
    non_branded_queries: 4,
    non_branded_with_aio: 1,
 visible_non_branded: 3,
    aio_coverage_pct: 50,
    error_rate_pct: 0,
    data_source_issue: false,
    insufficient_sample: false,
  };
  return {
    id: "scan-vendor-guard",
    brand: "Acme",
    url: "acme.com",
    scanned_at: "2026-09-01T10:00:00.000Z",
    visibility_pct: 62.5,
    prompts_tracked: 8,
    prompts_mentioned: 4,
    competitors: [],
    results,
    raw_results: {
      results,
      summary_stats,
      engines_counted: 4,
      visibility_index_pct: 62.5,
      engines: {
        aio: { engine: "aio", share_of_ai_pct: 25, non_branded_queries: 2, non_branded_with_answer: 1, error_rate_pct: 0, degraded: false },
        chatgpt: { engine: "chatgpt", share_of_ai_pct: 25, non_branded_queries: 2, non_branded_with_answer: 2, error_rate_pct: 0, degraded: false },
        perplexity: { engine: "perplexity", share_of_ai_pct: 25, non_branded_queries: 2, non_branded_with_answer: 2, error_rate_pct: 0, degraded: false },
        gemini: { engine: "gemini", share_of_ai_pct: 25, non_branded_queries: 2, non_branded_with_answer: 2, error_rate_pct: 0, degraded: false },
      },
      scoring_version: "v7-multi",
      prompt_set_id: "acme.com:v1",
    },
  };
}

// ---------------------------------------------------------------------------
// Compile DashboardShell and render it once for all tests.
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_PATH = path.join(HERE, "DashboardShell.jsx");

function nullComponent() {
  return null;
}

const shellModule = await compileJsx(SHELL_PATH, {
  modules: new Map([
    ["react", { ...React, useEffect: makeUseEffectShim(), __esModule: true, default: { ...React, useEffect: makeUseEffectShim() } }],
    ["lucide-react", anyNamedExport],
    ["next/navigation", {
      __esModule: true,
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {} }),
      usePathname: () => "/dashboard",
      useSearchParams: () => new URLSearchParams(),
    }],
    ["@/shared/api", { ...apiClient, __esModule: true, fetchScanHistory: () => new Promise(() => {}) }],
    ["@/shared/format", formatModule],
    ["@/shared/scoring/aliases", aliasesModule],
    ["@/shared/scoring/brandKey", brandKeyModule],
    ["@/shared/scoring/aioConstants", aioConstantsModule],
    ["@/shared/scoring/enginePipeline", enginePipelineModule],
  ]),
  autoStub: ["@/components/", "@/server/", "@/shared/"],
  shimUseEffect: true,
});

const Shell = shellModule.default;
assert.equal(typeof Shell, "function", "DashboardShell must export a component");

const realFetch = globalThis.fetch;
const realSetInterval = globalThis.setInterval;
globalThis.fetch = () => new Promise(() => {});
globalThis.setInterval = () => 0;

let renderedHtml;
try {
  renderedHtml = renderToHtml(Shell, { scan: multiEngineScan() });
} finally {
  globalThis.fetch = realFetch;
  globalThis.setInterval = realSetInterval;
}

const renderedText = textOf(renderedHtml);

// ---------------------------------------------------------------------------
// 1. Vendor names must be ABSENT.
// ---------------------------------------------------------------------------

test("R6.4.3 — no vendor name appears in rendered dashboard output", () => {
  for (const vendor of FORBIDDEN_VENDORS) {
    assert.ok(
      !renderedText.includes(vendor),
      `vendor name "${vendor}" must not appear in user-visible output; got: ${renderedText.slice(0, 500)}`
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Engine names must be PRESENT when the scan includes those engines.
// ---------------------------------------------------------------------------

test("R6.4.3 — engine names appear in rendered dashboard output", () => {
  for (const engine of REQUIRED_ENGINES) {
    assert.ok(
      renderedText.includes(engine),
      `engine name "${engine}" must appear in user-visible output when the scan includes it; got: ${renderedText.slice(0, 500)}`
    );
  }
});

// ---------------------------------------------------------------------------
// 3. Both directions proven: the guard itself catches a deliberate violation.
//
//    These two tests prove the guard mechanism works by simulating the failure
//    mode and showing the assertion would fire.  They do NOT modify the
//    component — they test the guard logic against crafted input.
// ---------------------------------------------------------------------------

test("R6.4.3 PROOF — the guard catches a vendor name leak (direction 1)", () => {
  // Simulate a vendor name appearing in rendered HTML.
  const contaminated = renderedHtml + '<span>Bright Data</span>';
  const contaminatedText = textOf(contaminated);

  let caught = false;
  try {
    for (const vendor of FORBIDDEN_VENDORS) {
      assert.ok(
        !contaminatedText.includes(vendor),
        `vendor name "${vendor}" leaked into rendered output`
      );
    }
  } catch {
    caught = true;
  }
  assert.ok(caught, "the guard must catch a Bright Data leak — if it does not fire, the guard is toothless");
});

test("R6.4.3 PROOF — the guard catches a missing engine name (direction 2)", () => {
  // Simulate an engine name disappearing from rendered HTML.
  const stripped = renderedText.replace(/ChatGPT/g, "");

  let caught = false;
  try {
    for (const engine of REQUIRED_ENGINES) {
      assert.ok(
        stripped.includes(engine),
        `engine name "${engine}" must appear in user-visible output`
      );
    }
  } catch {
    caught = true;
  }
  assert.ok(caught, "the guard must catch a missing ChatGPT — if it does not fire, the guard is toothless");
});
