import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

import { describeEngineSetChange } from "../../lib/scoring/enginePipeline.js";
import * as apiClient from "../../services/api.js";
import * as formatModule from "../../utils/format.js";
import * as aliasesModule from "../../lib/scoring/aliases.js";
import * as brandKeyModule from "../../lib/scoring/brandKey.js";
import * as aioConstantsModule from "../../lib/scoring/aioConstants.js";
import * as enginePipelineModule from "../../lib/scoring/enginePipeline.js";

/**
 * R2.7.8 — an engine chip must be able to carry a state instead of a number.
 *
 * THE BUG. ScoreBand rendered every chip as `{chip.label} {chip.value}%`: an
 * unconditional percent sign. A chip could therefore only ever hold a number,
 * so an engine that was frozen into the scan and never probed had no way to
 * appear — DashboardShell built the row from `perEngineSummaries` alone, and a
 * dropped engine has no slice in there. The headline surface listed the engines
 * that answered and gave no sign the set was smaller than the scan promised.
 * (R3.2.5's banner names them in prose below the number; this puts the marker
 * on the number itself.)
 *
 * WHAT THIS FILE PROVES, AND HOW.
 *
 *   1. By RUNNING the pure formatter exported from ScoreBand.jsx: what decides
 *      whether a "%" is printed is a finite number, and nothing else.
 *   2. By RENDERING the real ScoreBand (sucrase + react-dom/server) and reading
 *      its markup: a null-valued chip reaches the DOM as an em dash plus a
 *      state, with no percent sign on it.
 *   3. THE ACCEPT TEST: by rendering the real DashboardShell with the real
 *      ScoreBand wired in, from a stored `scans` row whose engine set shrank —
 *      and asserting the chip row is DIFFERENT from the same scan with both
 *      frozen engines answering. That difference is the accept criterion
 *      stated literally, and it is computed from the two rendered rows rather
 *      than asserted string by string, so a fix that only decorates the healthy
 *      case cannot pass it.
 *
 * WHAT IT CANNOT PROVE, said rather than implied:
 *   - This is `renderToStaticMarkup`. No browser, no CSS, no layout: it shows
 *     the words and the data-attributes reach the DOM, not that a reader can
 *     see them, that the chip row wraps, or that `chip--warn` is legible. There
 *     is no visual-regression harness in this repo (R6.4.11).
 *   - It does not run the worker or the /api/scans shaper. The hop from a live
 *     scan to a stored `engine_set_change` record is proven in
 *     src/lib/workers/engineSetChange.test.mjs; the record fed in below is
 *     built by the REAL describeEngineSetChange, so the field names are the
 *     ones the worker persists.
 *   - It does not prove the per-engine `state` / `state_reason` shape being
 *     added by R2.1.1 is what lands. It proves the opposite thing on purpose:
 *     the chip renders honestly whether that field is present or absent.
 *   - The DashboardShell harness runs useEffect synchronously (see the shim);
 *     that changes WHEN the component's code runs, never what it computes.
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

/** useEffect run synchronously during render, deps-aware. See engineSetChangeSurface.test.mjs. */
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

/** Compile one .jsx file to CJS and evaluate it against a require shim. */
async function loadJsx(filePath, requireShim, ReactImpl) {
  const source = await readFile(filePath, "utf8");
  const { code } = transform(source, {
    transforms: ["jsx", "imports"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    filePath,
  });
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function("require", "module", "exports", "React", code);
  factory(requireShim, module, module.exports, ReactImpl);
  return module.exports;
}

/** The REAL ScoreBand module — including its pure `describeEngineChip` export. */
async function loadScoreBand() {
  return loadJsx(
    SCORE_BAND_PATH,
    (specifier) => {
      throw new Error(`ScoreBand.jsx unexpectedly imports "${specifier}"`);
    },
    React
  );
}

/**
 * Render the REAL DashboardShell with the REAL ScoreBand.
 *
 * The one meaningful difference from engineSetChangeSurface.test.mjs's harness:
 * that one stubs every `@/components/**` import, which means it never rendered
 * a single engine chip. Here ScoreBand is the component under test, so it is
 * compiled and wired in for real; everything else is still a stub.
 */
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
    ["@/services/api", apiStub],
    ["@/utils/format", formatModule],
    ["@/lib/scoring/aliases", aliasesModule],
    ["@/lib/scoring/brandKey", brandKeyModule],
    ["@/lib/scoring/aioConstants", aioConstantsModule],
    ["@/lib/scoring/enginePipeline", enginePipelineModule],
  ]);

  const requireShim = (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    if (specifier.startsWith("@/components/") || specifier.startsWith("@/lib/")) {
      return anyNamedExport;
    }
    throw new Error(
      `DashboardShell imports "${specifier}", which this harness does not resolve. ` +
        `Add it to the map (real module) or the stub list, deliberately.`
    );
  };

  const shellModule = await loadJsx(SHELL_PATH, requireShim, patchedReact);
  const Shell = shellModule.default;
  assert.equal(typeof Shell, "function", "DashboardShell.jsx must still default-export a component");

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

/**
 * The engine chips out of a rendered dashboard, each as its own markup string.
 *
 * A chip may contain a nested <span> (the state marker), so this walks balanced
 * span tags rather than regexing to the next `</span>` — a lazy match would
 * silently return one truncated blob and make every comparison below vacuous.
 */
function chipRowOf(html) {
  assert.ok(
    html.includes('data-testid="score-band"'),
    "the score band did not render, so nothing below proves anything"
  );
  const chips = [];
  const openChip = /<span[^>]*data-testid="engine-chip"[^>]*>/g;
  let m;
  while ((m = openChip.exec(html)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const tag = /<\/?span\b[^>]*>/g;
    tag.lastIndex = i;
    let t;
    while (depth > 0 && (t = tag.exec(html)) !== null) {
      depth += t[0].startsWith("</") ? -1 : 1;
      i = t.index + t[0].length;
    }
    assert.equal(depth, 0, "unbalanced chip markup — the extractor is lying about what rendered");
    chips.push(html.slice(m.index, i));
  }
  return chips;
}

/**
 * A stored `scans` row. `engines` is the per-engine slice map (what becomes
 * `perEngineSummaries`); `engineSetChange` is the worker's record, or null when
 * the frozen set held.
 */
function storedScanRow({ engines, engineSetChange = null, enginesCounted = null }) {
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
    id: "scan-score-band-chips",
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
      engines_counted: enginesCounted ?? Object.keys(engines).length,
      visibility_index_pct: 50,
      engines,
      scoring_version: "v7-aio-only",
      prompt_set_id: "acme.com:v1",
    },
  };
}

const healthySlice = (engine, share) => ({
  engine,
  share_of_ai_pct: share,
  non_branded_queries: 2,
  non_branded_with_answer: 2,
  error_rate_pct: 0,
  degraded: false,
});

/** What the worker persists for a [aio, perplexity] scan that lost perplexity. */
const SHRANK = describeEngineSetChange({
  frozen: ["aio", "perplexity"],
  registered: ["aio"],
  probed: ["aio"],
});

// ---------------------------------------------------------------------------
// 1. The formatter, run. The percent sign is a consequence of a number.
// ---------------------------------------------------------------------------

test("describeEngineChip prints a percent sign only for a finite number", async () => {
  const { describeEngineChip } = await loadScoreBand();
  assert.equal(typeof describeEngineChip, "function", "ScoreBand must export the chip formatter");

  assert.deepEqual(
    { value: describeEngineChip({ label: "AI Overview", value: 42 }).value, measured: true },
    { value: "42%", measured: true }
  );
  // 0% is a MEASURED zero and must keep its percent sign — that is the whole
  // reason a hardcoded one was tempting, and the reason it was wrong.
  assert.equal(describeEngineChip({ label: "AI Overview", value: 0 }).value, "0%");
  assert.equal(describeEngineChip({ label: "AI Overview", value: 0 }).measured, true);
  // A numeric string is still a measurement (older records store it that way).
  assert.equal(describeEngineChip({ label: "AI Overview", value: "37.5" }).value, "37.5%");

  for (const absent of [null, undefined, "", "  ", "—", NaN, Infinity, {}, []]) {
    const c = describeEngineChip({ label: "Perplexity", value: absent });
    assert.equal(c.measured, false, `${String(absent)} is not a measurement`);
    assert.equal(c.value, "—", `${String(absent)} must render as an em dash`);
    assert.ok(!c.value.includes("%"), `${String(absent)} must never carry a percent sign`);
    assert.ok(c.state, "an unmeasured chip must carry a state, never a bare dash");
  }
});

test("describeEngineChip never turns an absent measurement into a zero", async () => {
  const { describeEngineChip } = await loadScoreBand();
  const missing = describeEngineChip({ label: "Perplexity", value: null });
  const zero = describeEngineChip({ label: "Perplexity", value: 0 });
  assert.notDeepEqual(
    missing,
    zero,
    "'not measured' and 'measured 0%' must not be the same chip (standing rule 5)"
  );
  assert.equal(zero.state, null, "a healthy measured chip carries no state marker");
});

test("describeEngineChip tolerates a state field being present OR absent", async () => {
  const { describeEngineChip } = await loadScoreBand();

  // Absent (today's pipeline): the fallback still says something.
  assert.equal(describeEngineChip({ label: "Perplexity", value: null }).state, "not measured");

  // Present (R2.1.1's shape, whatever the vocabulary turns out to be): printed
  // as it arrived, and its reason carried alongside.
  const stated = describeEngineChip({
    label: "Perplexity",
    value: null,
    state: "engine_unavailable",
    stateReason: "the provider returned 503 for every prompt",
  });
  assert.equal(stated.state, "engine_unavailable");
  assert.equal(stated.reason, "the provider returned 503 for every prompt");
  assert.equal(stated.value, "—");

  // A state this build does not recognise on a MEASURED chip is still shown.
  assert.equal(describeEngineChip({ label: "AI Overview", value: 50, state: "throttled" }).state, "throttled");
  // ...but "measured normally" adds no noise.
  assert.equal(describeEngineChip({ label: "AI Overview", value: 50, state: "ok" }).state, null);

  // A state can never manufacture a percent sign.
  assert.equal(describeEngineChip({ label: "X", value: null, state: "ok" }).value, "—");
});

test("describeEngineChip names an engine the record failed to name", async () => {
  const { describeEngineChip } = await loadScoreBand();
  const c = describeEngineChip({ value: null });
  assert.match(c.label, /engine this scan did not name/);
  assert.ok(!/^\s*—/.test(`${c.label} ${c.value}`), "a chip must not read as a bare dash");
});

// ---------------------------------------------------------------------------
// 2. The rendered ScoreBand.
// ---------------------------------------------------------------------------

test("a rendered unmeasured chip is an em dash plus a state, with no percent sign", async () => {
  const { ScoreBand } = await loadScoreBand();
  const html = renderToStaticMarkup(
    React.createElement(ScoreBand, {
      score: 50,
      engineChips: [
        { key: "a", label: "AI Overview", value: 50 },
        { key: "b", label: "Perplexity", value: null, state: "not probed", stateReason: "frozen, never answered" },
      ],
    })
  );
  const text = textOf(html);

  assert.ok(text.includes("AI Overview 50%"), "a measured chip still reads as a percentage");
  assert.ok(text.includes("Perplexity —"), "an unmeasured chip reads as an em dash");
  assert.ok(text.includes("not probed"), "...followed by the state that explains it");
  assert.ok(!text.includes("—%"), "the nonsense the hardcoded percent sign produced must be gone");
  assert.ok(!/Perplexity 0/.test(text), "an unmeasured engine must never render as a zero");
  assert.ok(
    html.includes('data-engine-measured="false"'),
    "the unmeasured chip must be machine-distinguishable, not only visually"
  );
  assert.ok(html.includes('data-engine-measured="true"'), "...and the measured one too");
  assert.ok(html.includes("frozen, never answered"), "the reason must reach the DOM as the chip's title");
});

test("a rendered measured 0% chip is not the unmeasured chip", async () => {
  const { ScoreBand } = await loadScoreBand();
  const zero = renderToStaticMarkup(
    React.createElement(ScoreBand, { score: 0, engineChips: [{ label: "Perplexity", value: 0 }] })
  );
  const missing = renderToStaticMarkup(
    React.createElement(ScoreBand, { score: 0, engineChips: [{ label: "Perplexity", value: null }] })
  );
  assert.ok(textOf(zero).includes("Perplexity 0%"), "a real zero keeps its percent sign");
  assert.notEqual(zero, missing, "measured zero and never measured must not render identically");
});

// ---------------------------------------------------------------------------
// 3. THE ACCEPT TEST — the whole path, rendered.
// ---------------------------------------------------------------------------

test("ACCEPT — a scan whose engine set shrank has a chip row unlike one where every engine answered", async () => {
  const bothAnswered = await renderDashboardShell({
    scan: storedScanRow({
      engines: { aio: healthySlice("aio", 50), perplexity: healthySlice("perplexity", 30) },
    }),
  });
  const shrank = await renderDashboardShell({
    scan: storedScanRow({
      engines: { aio: healthySlice("aio", 50) },
      engineSetChange: SHRANK,
      enginesCounted: 1,
    }),
  });

  const healthyChips = chipRowOf(bothAnswered);
  const shrankChips = chipRowOf(shrank);

  // Teeth for the whole test: if no chips rendered at all, everything below is
  // vacuous.
  assert.ok(healthyChips.length >= 2, `both engines must produce chips; got ${healthyChips.length}`);

  // THE CRITERION, stated as itself: the two rows must not be the same row.
  assert.notDeepEqual(
    shrankChips,
    healthyChips,
    "a scan that lost a frozen engine must not have a chip row indistinguishable from one where every engine answered"
  );

  // ...and specifically, the dropped engine is PRESENT and MARKED, not omitted.
  const shrankChipText = textOf(shrankChips.join(" "));
  assert.ok(
    shrankChipText.includes("Perplexity"),
    `the engine that was frozen but never probed must appear in the chip row; got: ${shrankChipText}`
  );
  assert.ok(shrankChipText.includes("not probed"), "...marked as never probed");
  assert.ok(shrankChipText.includes("—"), "...carrying an em dash where its share would be");
  assert.ok(
    !shrankChipText.includes("—%"),
    "the hardcoded percent sign is what made an unmeasured chip unrenderable"
  );
  assert.ok(
    !/Perplexity[^%]{0,12}\b0%/.test(shrankChipText),
    "a never-probed engine must never be shown as 0% (standing rule 5)"
  );
  assert.ok(
    shrankChips.some((c) => c.includes('data-engine-measured="false"')),
    "the dropped engine's chip must declare itself unmeasured"
  );

  // The healthy row is unchanged: no state noise added to a scan where nothing
  // went wrong.
  const healthyChipText = textOf(healthyChips.join(" "));
  assert.ok(healthyChipText.includes("AI Overview 50%"));
  assert.ok(healthyChipText.includes("Perplexity 30%"));
  assert.ok(
    !healthyChipText.includes("not probed") && !healthyChipText.includes("not measured"),
    "a scan where every frozen engine answered must not be annotated as if something went missing"
  );
  assert.ok(
    healthyChips.every((c) => c.includes('data-engine-measured="true"')),
    "every chip on a healthy scan is a measurement"
  );
});

test("ACCEPT — the marker survives the engine that was ALSO the only one left", async () => {
  // engines_counted fell to 1, so `isMultiEngine` is the least reliable thing
  // to gate the row on. The dropped engine must show either way.
  const html = await renderDashboardShell({
    scan: storedScanRow({
      engines: { aio: healthySlice("aio", 50) },
      engineSetChange: SHRANK,
      enginesCounted: 1,
    }),
  });
  const chipText = textOf(chipRowOf(html).join(" "));
  assert.ok(chipText.includes("AI Overview 50%"), "the engine that did answer keeps its number");
  assert.ok(chipText.includes("Perplexity"), "the engine that did not is still named on the headline");
});

test("an engine whose slice exists but carries no share renders as unmeasured, not as 0%", async () => {
  const html = await renderDashboardShell({
    scan: storedScanRow({
      engines: {
        aio: healthySlice("aio", 50),
        perplexity: { ...healthySlice("perplexity", 0), share_of_ai_pct: null },
      },
    }),
  });
  const chipText = textOf(chipRowOf(html).join(" "));
  assert.ok(chipText.includes("Perplexity —"), "a null share is an em dash");
  assert.ok(!chipText.includes("Perplexity 0%"), "a null share is not a measured zero");
  assert.ok(!chipText.includes("—%"), "and never a dash wearing a percent sign");
});

test("a scan with no engine trouble at all renders no state marker anywhere in the row", async () => {
  const html = await renderDashboardShell({
    scan: storedScanRow({
      engines: { aio: healthySlice("aio", 50), perplexity: healthySlice("perplexity", 30) },
    }),
  });
  assert.ok(
    !html.includes('data-engine-measured="false"'),
    "an all-clear scan must not grow a fake absence"
  );
});
