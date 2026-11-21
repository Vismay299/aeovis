import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

import { ROSTER_SOURCE, describeRosterState } from "../../shared/scoring/rosterContinuity.js";

/**
 * R2.7.12 — THE RIVAL COUNT A CUSTOMER ACTUALLY SEES.
 *
 * OverviewView's fourth KPI used to be
 *
 *   <span className="stat__v">{competitorsFound ?? 0}</span>
 *   <span className="stat__d dim">
 *     {(competitorsFound ?? 0) === 0 ? 'None co-mentioned yet' : ...}
 *   </span>
 *
 * on the live scan-report route (app/dashboard/[brand]/[scanId]/page.js ->
 * DashboardShell -> OverviewView). The number is standing rule 5; the sentence
 * under it is worse, because it promotes an absent measurement into a stated
 * finding about the market.
 *
 * THIS FILE RENDERS THE REAL COMPONENT. It compiles OverviewView.jsx and every
 * project module it imports off disk with sucrase and puts the output through
 * react-dom/server, so what is asserted is markup the browser would receive,
 * not a string scan of the source. Only `react` and `lucide-react` are
 * substituted, and neither emits text. The harness is lifted from
 * liveShareOfVoiceSurface.test.mjs / sourcesCitationShareSurface.test.mjs,
 * which established the pattern on this route.
 *
 * FIVE CASES, AND THE LAST TWO ARE THE POINT:
 *   1. prop absent                      -> em dash + chip, no digit, no claim
 *   2. count 0, roster_source=unavailable -> em dash + chip (the LIVE path:
 *      countCompetitorsFound([]) in services/api.js returns a confident 0 for
 *      a roster the extractor never built, so nullish-checking alone would
 *      never have caught this one)
 *   3. count 3, roster_source=carried_forward -> em dash + chip; those three
 *      are last scan's rivals, not this scan's measurement
 *   4. count 0, roster_source=extracted -> the digit 0 AND "None co-mentioned
 *      yet". A measured zero is a finding and must still be stated.
 *   5. count 4, roster_source absent (pre-R0.3.3 scan) -> the digit 4
 *
 * WHAT THIS FILE DOES NOT PROVE: static markup only — no browser, no CSS, no
 * effects. It proves the em dash, the chip and the reason reach the DOM, not
 * that they are legible. It does not run the scan pipeline, and it does not
 * exercise DashboardShell (which is not mountable in this harness); the
 * shell's own `?? 0` pair on the degradation banner is covered by the source
 * guard at the bottom of this file and is labelled as such.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", "..");
const VIEW_PATH = path.join(HERE, "OverviewView.jsx");
const SHELL_PATH = path.join(HERE, "DashboardShell.jsx");

// ---------------------------------------------------------------------------
// Harness: compile the real component tree from disk.
// ---------------------------------------------------------------------------

/** lucide-react icons: any named export, rendering nothing. */
const iconModule = new Proxy(
  { __esModule: true },
  { get: (target, prop) => (prop in target ? target[prop] : () => null) }
);

/** motion/react: `motion.<tag>` as the plain tag, animation props dropped. */
const motionProxy = new Proxy(
  {},
  {
    get(_t, tag) {
      return function MotionTag(props) {
        const { initial, animate, exit, transition, variants, whileHover, whileInView, ...rest } =
          props || {};
        return React.createElement(String(tag), rest);
      };
    },
  }
);

const reactModule = { ...React, __esModule: true };
reactModule.default = reactModule;

const EXTERNAL = new Map([
  ["react", reactModule],
  ["lucide-react", iconModule],
  [
    "motion/react",
    {
      __esModule: true,
      motion: motionProxy,
      AnimatePresence: ({ children }) => children,
      useReducedMotion: () => true,
    },
  ],
]);

const RESOLVE_EXT = [".js", ".jsx", ".mjs"];

function resolveSpecifier(specifier, fromFile) {
  let base;
  if (specifier.startsWith("@/")) base = path.join(SRC, specifier.slice(2));
  else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
  else return null;
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of RESOLVE_EXT) if (existsSync(base + ext)) return base + ext;
  for (const ext of RESOLVE_EXT) {
    const idx = path.join(base, "index" + ext);
    if (existsSync(idx)) return idx;
  }
  return null;
}

const cache = new Map();

/**
 * Load one project file and everything it imports, for real. There is
 * deliberately no catch-all for project specifiers: an unresolvable import
 * throws, because a stub in that position could replace rosterContinuity.js —
 * the predicate under test — with something that agrees with every assertion.
 */
async function loadProjectModule(file) {
  if (cache.has(file)) return cache.get(file);
  const source = await readFile(file, "utf8");
  const { code } = transform(source, {
    transforms: ["jsx", "imports"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    filePath: file,
  });

  const moduleRecord = { exports: {} };
  cache.set(file, moduleRecord.exports);

  const deps = new Map();
  for (const specifier of [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map(
    (m) => m[1]
  )) {
    if (deps.has(specifier)) continue;
    if (EXTERNAL.has(specifier)) {
      deps.set(specifier, EXTERNAL.get(specifier));
      continue;
    }
    const target = resolveSpecifier(specifier, file);
    if (target === null) {
      throw new Error(
        `${path.relative(SRC, file)} imports "${specifier}", which this harness will not ` +
          `resolve. Substitute it deliberately — a catch-all stub would make these ` +
          `assertions vacuous.`
      );
    }
    deps.set(specifier, await loadProjectModule(target));
  }

  const requireShim = (specifier) => {
    if (!deps.has(specifier)) throw new Error(`unprepared require("${specifier}")`);
    return deps.get(specifier);
  };

  // eslint-disable-next-line no-new-func
  const factory = new Function("require", "module", "exports", "React", code);
  factory(requireShim, moduleRecord, moduleRecord.exports, reactModule);
  cache.set(file, moduleRecord.exports);
  return moduleRecord.exports;
}

/**
 * A scan with real answered rows, so the rest of Overview renders normally and
 * the competitor KPI is the only thing under test. Nothing here carries a
 * rival count — that is always passed as an explicit prop, exactly as
 * DashboardShell does (`competitorsFound={result.competitorsFound}`).
 */
function scanFixture(rosterSource) {
  return {
    brand: "Northwind",
    visibilityScore: 41,
    summary: "",
    rosterSource,
    rawResults: [
      {
        prompt: "best crm for field teams",
        is_branded_query: false,
        aio_present: true,
        brand_mentioned_in_text: true,
        competitors_found_in_text: [],
        competitors_cited: [],
      },
      {
        prompt: "crm with offline mode",
        is_branded_query: false,
        aio_present: true,
        brand_mentioned_in_text: false,
        competitors_found_in_text: [],
        competitors_cited: [],
      },
    ],
  };
}

/** Render the live Overview exactly as DashboardShell mounts it. */
async function renderOverview({ competitorsFound, rosterSource }) {
  const exports = await loadProjectModule(VIEW_PATH);
  const View = exports.OverviewView;
  assert.equal(
    typeof View,
    "function",
    "OverviewView.jsx must still export `OverviewView` — DashboardShell imports it by that name"
  );
  return renderToStaticMarkup(
    React.createElement(View, {
      result: scanFixture(rosterSource),
      dataSourceIssue: false,
      onTabChange: () => {},
      heroScore: 41,
      aioCoverage: 80,
      nonBrandedWithAio: 2,
      promptsTracked: 2,
      presenceRate: 50,
      visibleCount: 1,
      competitorsFound,
      promptsAnalyzed: 2,
      mentionedNonBrandedCount: 1,
      citedNonBrandedCount: 0,
      interpretation: "Half the answers name you.",
      tier: "moderate",
    })
  );
}

/**
 * Slice out one `data-testid` element and its subtree by counting div depth.
 * Assertions are scoped to this block and never to the whole page: the other
 * three KPIs legitimately print digits, and a page-wide "no digit" guard would
 * be green for the wrong reason.
 */
function blockOf(html, testId) {
  const marker = `data-testid="${testId}"`;
  const at = html.indexOf(marker);
  assert.notEqual(at, -1, `no element carries ${marker} — the KPI was renamed or removed`);
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

function textOf(html) {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** The headline element — the one that claims to be a count of rivals. */
function headlineOf(block) {
  const m = block.match(/<span class="stat__v[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<span class="stat__d/);
  assert.ok(m, "the KPI must still have a `stat__v` headline followed by its `stat__d` caption");
  return m[1];
}

const MARKET_CLAIMS = ["None co-mentioned yet", "Found in the answers themselves"];

// ---------------------------------------------------------------------------
// The unmeasured cases: no digit, no claim about the market.
// ---------------------------------------------------------------------------

const UNMEASURED = [
  {
    name: "the prop is absent entirely",
    props: { competitorsFound: undefined, rosterSource: null },
  },
  {
    name: "the count is 0 because rival extraction never ran (roster_source=unavailable)",
    props: { competitorsFound: 0, rosterSource: ROSTER_SOURCE.UNAVAILABLE },
  },
  {
    name: "the count is last scan's, carried forward (roster_source=carried_forward)",
    props: { competitorsFound: 3, rosterSource: ROSTER_SOURCE.CARRIED_FORWARD },
  },
];

for (const scenario of UNMEASURED) {
  test(`R2.7.12 — an unmeasured rival count renders as not-measured when ${scenario.name}`, async () => {
    const html = await renderOverview(scenario.props);
    const block = blockOf(html, "kpi-competitors");
    const text = textOf(block);

    assert.ok(
      !/[0-9]/.test(text),
      `the rival KPI printed a digit for a count nobody measured: ${text}`
    );
    for (const claim of MARKET_CLAIMS) {
      assert.ok(
        !text.includes(claim),
        `the rival KPI stated "${claim}" about a market nobody looked at: ${text}`
      );
    }
    assert.match(
      headlineOf(block),
      /—/,
      "the headline must be an em dash when the count was not measured"
    );
    assert.match(
      text,
      /Not measured/,
      "the em dash must be accompanied by a state chip saying so"
    );
    assert.ok(
      textOf(block).length > "Rivals holding answers — Not measured".length,
      "the chip must be accompanied by a reason, not left as a bare label"
    );
  });
}

test("R2.7.12 — the roster reason is the shared helper's sentence, not a local paraphrase", async () => {
  for (const source of [ROSTER_SOURCE.UNAVAILABLE, ROSTER_SOURCE.CARRIED_FORWARD]) {
    const html = await renderOverview({ competitorsFound: 0, rosterSource: source });
    const text = textOf(blockOf(html, "kpi-competitors"));
    const detail = textOf(describeRosterState(source).detail);
    assert.ok(
      text.includes(detail),
      `roster_source=${source} must explain itself with describeRosterState's detail, so this ` +
        `surface cannot drift from RivalsView and the donut. Rendered: ${text}`
    );
  }
});

// ---------------------------------------------------------------------------
// The inverse: blanking a real measurement is the same crime.
// ---------------------------------------------------------------------------

test("R2.7.12 — a MEASURED zero still prints 0 and still says none were co-mentioned", async () => {
  const html = await renderOverview({
    competitorsFound: 0,
    rosterSource: ROSTER_SOURCE.EXTRACTED,
  });
  const block = blockOf(html, "kpi-competitors");
  const text = textOf(block);

  assert.equal(
    textOf(headlineOf(block)),
    "0",
    "an extracted roster that found nobody is a finding: the headline is the number 0"
  );
  assert.ok(
    text.includes("None co-mentioned yet"),
    "a measured zero must still state the finding it is"
  );
  assert.ok(
    !text.includes("Not measured"),
    "a measured zero must not be dressed up as an absent measurement"
  );
});

test("R2.7.12 — a pre-R0.3.3 scan with no roster_source is treated as measured", async () => {
  const html = await renderOverview({ competitorsFound: 4, rosterSource: null });
  const block = blockOf(html, "kpi-competitors");
  assert.equal(textOf(headlineOf(block)), "4");
  assert.ok(textOf(block).includes("Found in the answers themselves"));
});

// ---------------------------------------------------------------------------
// The shielded pair, asserted so the distinction stays deliberate.
// ---------------------------------------------------------------------------

test("R2.7.12 — the two dataSourceIssue-shielded KPIs still blank on a flagged reading", async () => {
  /*
   * Answer coverage and Your presence keep their `?? 0`, which is only
   * defensible because `dataSourceIssue` blanks them first. That is the whole
   * basis for leaving them alone, so it is asserted rather than assumed — if
   * someone deletes the shield, this goes red and the `?? 0` underneath it
   * becomes the next task's problem with evidence attached.
   */
  const exports = await loadProjectModule(VIEW_PATH);
  const html = renderToStaticMarkup(
    React.createElement(exports.OverviewView, {
      result: scanFixture(ROSTER_SOURCE.EXTRACTED),
      dataSourceIssue: true,
      onTabChange: () => {},
      heroScore: 41,
      aioCoverage: null,
      presenceRate: null,
      promptsTracked: 2,
      competitorsFound: 0,
      interpretation: "",
      tier: "weak",
    })
  );
  for (const id of ["kpi-aio-coverage", "kpi-presence"]) {
    const headline = textOf(headlineOf(blockOf(html, id)));
    assert.ok(
      headline.startsWith("—"),
      `${id} must blank its headline when dataSourceIssue is set, got "${headline}"`
    );
  }
});

// ---------------------------------------------------------------------------
// DashboardShell's degradation banner — SOURCE GUARD, not a render test.
// ---------------------------------------------------------------------------

test("R2.7.12 GUARD — the degradation banner's legacy rows do not print 0% for a missing figure", async () => {
  /*
   * DashboardShell is a client component wired to next/navigation and is not
   * mountable in this harness, so this is a source guard and is labelled one.
   * It is worth having anyway: the banner exists to say the reading is
   * incomplete, and `{result.aioCoveragePct ?? 0}%` is a confident measurement
   * printed on the one screen whose job is to deny one.
   *
   * NOTE THE LATENCY, honestly: services/api.js ends normalizeResult() with
   * `aioCoveragePct = aioCoveragePct ?? 0`, so a normalized scan arrives here
   * already coerced and the em dash cannot yet appear through that path. This
   * guard pins the render edge; killing the upstream coercion is another
   * task's file.
   *
   * SCOPED TO THE BANNER, deliberately. The same `?? 0` survives further down
   * in the ScoreBand `stats` array, on a verdict strip that renders only when
   * `dataSourceIssue` is FALSE and whose value slots are plain strings that
   * ScoreBand.jsx would have to be taught to blank. That is a different
   * surface, a different fix and a file owned by another task in flight; a
   * whole-file assertion here would either be red for work this task did not
   * do or would quietly pull that work in.
   */
  const shell = await readFile(SHELL_PATH, "utf8");
  const from = shell.indexOf('data-testid="data-source-issue-banner"');
  const to = shell.indexOf('data-testid="engine-degraded-banner"');
  assert.ok(
    from !== -1 && to > from,
    "DashboardShell must still carry the data-source-issue banner ahead of the degraded-engine " +
      "banner — this guard reads the slice between them and cannot locate it otherwise"
  );
  const banner = shell.slice(from, to);

  for (const metric of ["aioCoveragePct", "aioErrorRatePct"]) {
    assert.ok(
      !banner.includes(`result.${metric} ?? 0`),
      `the degradation banner still falls back to 0 for result.${metric} — that is a ` +
        `measurement claimed by the one screen that exists to deny one`
    );
    assert.ok(
      banner.includes(`result.${metric} == null ? "—" : \`\${result.${metric}}%\``),
      `the degradation banner must render a missing result.${metric} as an em dash, matching ` +
        `the degradedEngines rows above it`
    );
  }
});
