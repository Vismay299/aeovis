import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

import {
  describeEngineSetChange,
  ENGINE_SET_STATES,
} from "../../shared/scoring/enginePipeline.js";
import * as apiClient from "../../shared/api.js";
import * as formatModule from "../../shared/format.js";
import * as aliasesModule from "../../shared/scoring/aliases.js";
import * as brandKeyModule from "../../shared/scoring/brandKey.js";
import * as aioConstantsModule from "../../shared/scoring/aioConstants.js";
import * as enginePipelineModule from "../../shared/scoring/enginePipeline.js";

/**
 * R3.2.5 (finding B3) — THE RENDERED SURFACE.
 *
 * The worker half of this finding is proven by execution in
 * src/server/workers/engineSetChange.test.mjs: a frozen engine driven out of the
 * registry between two probing chunks finalizes with a lower engines_counted
 * and a `summary_stats.engine_set_change` record naming what happened. That
 * file stops at the record insertScan is handed.
 *
 * It shipped once with exactly that much and the second half of the accept
 * criterion — "the dashboard can tell a user why engines_counted fell" — was
 * still false, because src/shared/api.js read `summary_stats` into a LOCAL
 * and never put it on the normalized record, and nothing in src/components
 * mentioned `engine_set_change` at all. The number moved and the screen was
 * silent: computed correctly, read by nobody, one hop later.
 *
 * So this file walks the hops after the row, by execution:
 *
 *   the REAL describeEngineSetChange (the producer of the wording)
 *     -> a stored `scans` row's raw_results.summary_stats
 *     -> the REAL normalizeResult            (services/api.js)
 *     -> the REAL DashboardShell, RENDERED   (react-dom/server)
 *     -> the HTML string a user would read
 *
 * and asserts against the rendered HTML, not against the source text. A
 * sibling task's source-text guard was shown to pass while its component was
 * broken by one inverted ternary; a string that is not in the markup cannot
 * pass here.
 *
 * WHAT THIS FILE DOES NOT PROVE, stated rather than implied:
 *   - It does not run the worker. The hop from a live scan to the stored row
 *     is engineSetChange.test.mjs's, and the record fed in below is built by
 *     the REAL describeEngineSetChange rather than hand-written, so the copy
 *     asserted here is the copy the worker persists.
 *   - It does not run enrichScanForClient (the /api/scans route shaper); that
 *     module imports @/server/db, which constructs a Supabase client at import
 *     time. It is covered separately. To keep this file honest about that gap,
 *     the row handed to normalizeResult below is the UNENRICHED stored row —
 *     if the shaper were the only thing carrying the field, this would fail.
 *   - It renders to static markup. No browser, no layout, no CSS: it proves
 *     the words and the state reach the DOM, not that they are visible on a
 *     small screen.
 *   - Effects are run synchronously by the harness below (react-dom/server
 *     never runs them), which is a real deviation from the browser, documented
 *     at `patchedReact`.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_PATH = path.join(HERE, "DashboardShell.jsx");

/**
 * A component that renders nothing, standing in for the child views and the
 * icon set. Nothing asserted below comes from one of these: the banner under
 * test is rendered by DashboardShell itself.
 */
function nullComponent() {
  return null;
}

/**
 * `import { Whatever } from "lucide-react"` compiles to a property read, so a
 * Proxy answers for any name without this file having to track the icon set.
 */
const anyNamedExport = new Proxy(
  { __esModule: true },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      return nullComponent;
    },
  }
);

/**
 * useEffect, run synchronously during render, deps-aware.
 *
 * DashboardShell puts `result` in state and fills it from an effect, and
 * react-dom/server never runs effects — rendered as-is it would only ever
 * produce the loading skeleton, which would make this test vacuous. Calling
 * the effect during render turns its setState into a render-phase update,
 * which React re-runs the component for; the deps check is what stops that
 * being an infinite loop.
 *
 * This IS a deviation from browser behaviour and it is the harness's only one.
 * It changes WHEN the component's own code runs, never WHAT it computes:
 * normalizeResult, the banner, and every string below are the shipped code.
 * Cleanup functions are not invoked (nothing is unmounted here).
 */
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
    // No deps array means "every render" in React; here it would spin, so it
    // runs once and this comment is the record of that difference.
    if (!changed || (prev !== undefined && deps === undefined)) return;
    ref.current = { deps };
    fn();
  };
}

/**
 * Compile and evaluate the REAL DashboardShell.jsx, then render it.
 *
 * Substituted: the icon set, the child views, the sidebar, `next/navigation`,
 * and `fetchScanHistory` (a network call the render must not make). NOT
 * substituted: normalizeResult, describeScanDataSourceIssue, the formatters,
 * or one line of DashboardShell itself.
 */
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
    // The component fetches history on mount. A promise that never settles
    // keeps the render free of both a network call and a post-render setState,
    // and leaves `history` empty — which is what a first view of a scan shows.
    fetchScanHistory: () => new Promise(() => {}),
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
    ["@/shared/scoring/enginePipeline", enginePipelineModule],
  ]);

  const requireShim = (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    if (specifier.startsWith("@/components/") || specifier.startsWith("@/server/") || specifier.startsWith("@/shared/")) {
      return anyNamedExport;
    }
    // Loud, not silent: an import this harness has not been told about would
    // otherwise resolve to an empty object and quietly render less than the
    // component does.
    throw new Error(
      `DashboardShell imports "${specifier}", which this render harness does not resolve. ` +
        `Add it to the map (real module) or the stub list, deliberately.`
    );
  };

  const moduleRecord = { exports: {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function("require", "module", "exports", "React", code);
  factory(requireShim, moduleRecord, moduleRecord.exports, patchedReact);

  const Shell = moduleRecord.exports.default;
  assert.equal(
    typeof Shell,
    "function",
    "DashboardShell.jsx must still default-export a component for this harness to render"
  );

  const realFetch = globalThis.fetch;
  const realSetInterval = globalThis.setInterval;
  // The studio-badge effect polls and installs an interval. Neither may run in
  // a test process: the fetch never settles (so it never setStates), and the
  // interval would hold the event loop open forever.
  globalThis.fetch = () => new Promise(() => {});
  globalThis.setInterval = () => 0;
  try {
    return renderToStaticMarkup(React.createElement(Shell, props));
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

/**
 * A stored `scans` row of a two-engine scan, with whatever engine_set_change
 * the caller passes on `raw_results.summary_stats` — exactly where the worker
 * puts it (db.js's raw_results payload is an allowlist and summary_stats is on
 * it; a top-level key would have been dropped in silence).
 */
function storedScanRow(engineSetChange, { enginesCounted = 1 } = {}) {
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
  const summary_stats = {
    visibility_pct: 50,
    mention_rate_pct: 50,
    non_branded_queries: 2,
    non_branded_with_aio: 2,
    visible_non_branded: 1,
    aio_coverage_pct: 100,
    error_rate_pct: 0,
    data_source_issue: false,
    insufficient_sample: false,
    ...(engineSetChange ? { engine_set_change: engineSetChange } : {}),
  };
  return {
    id: "scan-engine-set-change",
    brand: "Acme",
    url: "acme.com",
    scanned_at: "2026-09-01T10:00:00.000Z",
    visibility_pct: 50,
    prompts_tracked: 2,
    prompts_mentioned: 1,
    competitors: [],
    results,
    raw_results: {
      results,
      summary_stats,
      engines_counted: enginesCounted,
      visibility_index_pct: 50,
      engines: {
        aio: {
          engine: "aio",
          share_of_ai_pct: 50,
          non_branded_queries: 2,
          non_branded_with_answer: 2,
          error_rate_pct: 0,
          degraded: false,
        },
      },
      scoring_version: "v7-aio-only",
      prompt_set_id: "acme.com:v1",
    },
  };
}

/** The record the worker persists for a frozen [aio, perplexity] scan that lost perplexity. */
const SHRANK = describeEngineSetChange({
  frozen: ["aio", "perplexity"],
  registered: ["aio"],
  probed: ["aio"],
});

/** ...and for one where no frozen engine resolved and chatgpt answered instead. */
const REFROZEN = describeEngineSetChange({
  frozen: ["aio", "perplexity"],
  registered: ["chatgpt"],
  probed: ["chatgpt"],
});

test("the producer really does emit the two states this surface renders", () => {
  assert.equal(SHRANK?.state, ENGINE_SET_STATES.SHRANK);
  assert.equal(REFROZEN?.state, ENGINE_SET_STATES.REFROZEN);
  assert.ok(SHRANK.title && SHRANK.detail, "shrank record must carry its own wording");
  assert.ok(REFROZEN.title && REFROZEN.detail, "refrozen record must carry its own wording");
});

// ---------------------------------------------------------------------------
// 1. The data layer: normalizeResult must EXPOSE the record. This is the hop
//    that was missing — `summary` was computed and thrown away.
// ---------------------------------------------------------------------------

test("normalizeResult exposes engine_set_change off the stored row as engineSetChange", () => {
  const normalized = apiClient.normalizeResult(storedScanRow(SHRANK), "Acme", "acme.com");
  assert.deepEqual(
    normalized.engineSetChange,
    SHRANK,
    "the dashboard reads result.engineSetChange and nothing else; a local variable is not a surface"
  );
  assert.equal(normalized.enginesCounted, 1, "the number the banner has to explain");
});

test("normalizeResult exposes it from the enriched (route-shaped) record too", () => {
  const row = storedScanRow(REFROZEN, { enginesCounted: 0 });
  // What enrichScanForClient hands the client: summary_stats hoisted to the top
  // level alongside the raw payload.
  const enrichedShape = { ...row, summary_stats: row.raw_results.summary_stats };
  const normalized = apiClient.normalizeResult(enrichedShape, "Acme", "acme.com");
  assert.equal(normalized.engineSetChange?.state, ENGINE_SET_STATES.REFROZEN);
});

test("a scan whose frozen engine set held carries null, not a fabricated all-clear", () => {
  const normalized = apiClient.normalizeResult(storedScanRow(null), "Acme", "acme.com");
  assert.equal(
    normalized.engineSetChange,
    null,
    "absence of the key means the frozen set held; it must not become an object the banner would render"
  );
});

test("double normalization (history re-entry) does not drop the record", () => {
  const once = apiClient.normalizeResult(storedScanRow(SHRANK), "Acme", "acme.com");
  const twice = apiClient.normalizeResult(once, "Acme", "acme.com");
  assert.deepEqual(twice.engineSetChange, SHRANK);
});

// ---------------------------------------------------------------------------
// 2. The rendered surface. THE ACCEPT TEST: a shrank or refrozen scan must not
//    reach a rendered dashboard with no reason on it.
// ---------------------------------------------------------------------------

test("ACCEPT — a scan that lost a frozen engine renders a banner naming the engine and the reason", async () => {
  const html = await renderDashboardShell({ scan: storedScanRow(SHRANK) });
  const text = textOf(html);

  assert.ok(
    html.includes('data-testid="engine-set-change-banner"'),
    "a scan whose engine set shrank must render the banner — this is the silence the finding is about"
  );
  assert.ok(
    html.includes('data-engine-set-state="shrank"'),
    "the banner must carry the state the record recorded"
  );
  assert.ok(
    text.includes(SHRANK.title),
    `the record's own headline must be on screen; got: ${text.slice(0, 400)}`
  );
  assert.ok(text.includes(SHRANK.detail), "the record's own explanation must be on screen");
  assert.ok(
    text.includes("Perplexity"),
    "the engine that stopped resolving must be named, not merely counted"
  );
  assert.ok(text.includes("not probed"), "the dropped engine must be marked as never probed");
  assert.ok(
    text.includes("1 of 2"),
    "the banner must say how many of the frozen engines the index was blended over — this is why engines_counted fell"
  );
  assert.ok(text.includes("Fewer engines"), "shrank reads as a warning, not as 'not comparable'");
  assert.ok(
    !text.includes("Not comparable"),
    "a shrank scan is still comparable; only a refrozen one is not"
  );
});

test("ACCEPT — a refrozen scan says it is not comparable and names the substitute", async () => {
  const html = await renderDashboardShell({
    scan: storedScanRow(REFROZEN, { enginesCounted: 0 }),
  });
  const text = textOf(html);

  assert.ok(
    html.includes('data-engine-set-state="refrozen"'),
    "the worse of the two states must reach the DOM as itself"
  );
  assert.ok(text.includes("Not comparable"), "refrozen must not be softened into 'Fewer engines'");
  assert.ok(!text.includes("Fewer engines"));
  assert.ok(text.includes(REFROZEN.title));
  assert.ok(
    text.includes("cannot be compared to this brand's history"),
    "the reader must be told the comparison is broken, which is what a refreeze costs them"
  );
  assert.ok(
    text.includes("ChatGPT"),
    "the engine that answered instead must be named — it appears in no slice, so this banner is the only place it can"
  );
  assert.ok(text.includes("Perplexity"), "the frozen engines that stopped resolving must be named");
});

test("a healthy scan renders no engine-set banner at all", async () => {
  const html = await renderDashboardShell({ scan: storedScanRow(null) });
  assert.ok(
    !html.includes('data-testid="engine-set-change-banner"'),
    "a scan whose frozen set held must not be annotated with an 'everything is fine' banner"
  );
  // ...and the surface still rendered, so the assertion above is not passing
  // because nothing was drawn.
  assert.ok(html.includes('data-testid="score-band"') || html.includes("Acme"), "the dashboard still rendered");
});

test("a record with an unrecognised state is shown, not swallowed", async () => {
  const html = await renderDashboardShell({
    scan: storedScanRow({
      ...SHRANK,
      state: "engine_set_teleported",
    }),
  });
  const text = textOf(html);
  assert.ok(html.includes('data-testid="engine-set-change-banner"'));
  assert.ok(
    text.includes("engine_set_teleported"),
    "a state this build does not know must be printed as recorded, never rendered as an empty banner"
  );
});

test("a record that arrived without wording still says something, never a blank banner", async () => {
  const html = await renderDashboardShell({
    scan: storedScanRow({ state: "shrank", dropped_engines: [], substituted_engines: [] }),
  });
  const text = textOf(html);
  assert.ok(html.includes('data-testid="engine-set-change-banner"'));
  assert.ok(
    text.includes("changed while it ran") || text.includes("carried no explanation"),
    "a record missing its title/detail must produce a stated gap, not empty space"
  );
  assert.ok(text.includes("—"), "unknown counts render as an em dash, never as 0");
});

test("a malformed engine reference still renders a name, never a bare dash", async () => {
  const html = await renderDashboardShell({
    scan: storedScanRow({
      ...SHRANK,
      // A record written by an older or a broken producer: one bare string, one
      // object with no label, one with nothing at all.
      dropped_engines: ["perplexity", { engine: "chatgpt" }, {}],
    }),
  });
  const text = textOf(html);
  assert.ok(text.includes("Perplexity — not probed"));
  assert.ok(text.includes("ChatGPT — not probed"));
  assert.ok(
    text.includes("an engine this record did not name — not probed"),
    "an unnameable engine must say so; a chip reading ' — not probed' is an empty state in disguise"
  );
});

test("the banner survives a scan that ALSO tripped the data-source gate", async () => {
  // The two events are independent. Suppressing the engine-set reason behind
  // the reliability banner would restore the silence for the worst scans.
  const row = storedScanRow(REFROZEN, { enginesCounted: 0 });
  row.raw_results.summary_stats.data_source_issue = true;
  row.raw_results.engines.aio.degraded = true;
  row.raw_results.engines.aio.non_branded_with_answer = 0;
  row.raw_results.engines.aio.error_rate_pct = 100;
  const html = await renderDashboardShell({ scan: row });
  assert.ok(
    html.includes('data-testid="engine-set-change-banner"'),
    "an unreliable scan is exactly the one whose engine set most needs explaining"
  );
});

// ---------------------------------------------------------------------------
// 3. The harness's own teeth. If these fail, every assertion above is worthless
//    because the render never got past the skeleton.
// ---------------------------------------------------------------------------

test("the harness renders the real dashboard, not a loading skeleton", async () => {
  const html = await renderDashboardShell({ scan: storedScanRow(null) });
  assert.ok(html.length > 500, "the render produced markup");
  assert.ok(
    !/class="skel"/.test(html) || html.includes("Acme"),
    "if this is the skeleton, the effect shim stopped working and the banner assertions prove nothing"
  );
  assert.ok(html.includes("Acme"), "the scan under test was actually normalized and rendered");
});
