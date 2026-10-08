import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

import { resolveShareOfVoice, SHARE_STATE, NOT_AVAILABLE_LABEL } from "../perceev/charts/shareOfVoice.js";

/**
 * R2.7.10 — THE SHARE OF VOICE A CUSTOMER ACTUALLY SEES.
 *
 * R2.7.6 taught `ScoreBreakdown.jsx` to tell a never-computed share apart from
 * a measured zero. No route imported that component, so the fix reached nobody
 * (routeReachability.test.mjs is the guard that now makes such a thing
 * impossible to add). The question R2.7.10 had to answer before retiring it was
 * whether the SAME defect was live, unfixed, on whatever the scan report
 * actually renders.
 *
 * It is not. The mounted chain is
 *
 *   app/dashboard/[brand]/[scanId]/page.js
 *     -> DashboardShell -> OverviewView -> OverviewAnalytics
 *     -> RankAndSharePanel -> Donut
 *
 * and RankAndSharePanel calls the very same resolveShareOfVoice(). This file
 * renders that live pair and asserts the three states are three different
 * objects on screen. It is the evidence for "the component that IS mounted on
 * the scan-report route carries the distinction", rather than a reading of the
 * source.
 *
 * THE not_computed PATH, specifically. The R2.7.6 verifier noticed that the
 * retired test's `!card.includes("%")` assertion held only on its chosen
 * fixture — a scan with no per-engine summaries at all, reason
 * `no_engine_summaries`. On the far more common real path (engines present,
 * every `share_of_voice_pct` null, reason `not_computed`) the honest sentence
 * is "...That is not the same as a 0% share.", so the markup legitimately
 * contains a percent sign and the string "0%". A blanket "no % anywhere" guard
 * is therefore wrong twice over: it passes for the wrong reason on one fixture
 * and would fail on correct behaviour on another. The assertions below are
 * scoped to the HEADLINE — the element that claims to be the brand's share —
 * so honest prose can say "0%" while the number nobody measured stays absent.
 *
 * WHAT THIS FILE DOES NOT PROVE: static markup only. No browser, no CSS, no
 * effects — it proves the words and the state attributes reach the DOM, not
 * that they are legible. OverviewAnalytics' fetch is not exercised here; that
 * is DashboardShell's harness's job.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", "..");
const PANEL_PATH = path.join(HERE, "RankAndSharePanel.jsx");

// ---------------------------------------------------------------------------
// Harness: compile the REAL component tree from disk.
// ---------------------------------------------------------------------------

/** lucide-react icons: any named export, rendering nothing. */
const iconModule = new Proxy(
  { __esModule: true },
  {
    get: (target, prop) => (prop in target ? target[prop] : () => null),
  }
);

/** framer-motion: `motion.<tag>` as the plain tag, animation props dropped. */
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
  [
    "framer-motion",
    {
      __esModule: true,
      motion: motionProxy,
      AnimatePresence: ({ children }) => children,
      useReducedMotion: () => true,
    },
  ],
  ["lucide-react", iconModule],
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
 * Load one project file and everything it imports, for real.
 *
 * Only `react`, `framer-motion` and `lucide-react` are substituted, and none of
 * those produces text. There is deliberately no catch-all for project paths: an
 * unresolvable specifier throws, because a stub in this position would replace
 * shareOfVoice.js — the module under test — with something that agrees with
 * every assertion below.
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
  for (const specifier of [
    ...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g),
  ].map((m) => m[1])) {
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

/** Render the live panel exactly as OverviewAnalytics mounts it. */
async function renderPanel(result, rankedEntries = []) {
  const exports = await loadProjectModule(PANEL_PATH);
  const Panel = exports.RankAndSharePanel;
  assert.equal(
    typeof Panel,
    "function",
    "RankAndSharePanel.jsx must still export `RankAndSharePanel` — OverviewAnalytics imports it by that name"
  );
  return renderToStaticMarkup(React.createElement(Panel, { result, rankedEntries }));
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
 * The headline element only — the one that claims to be the brand's share.
 * Assertions about "no percentage" belong here and nowhere else: the
 * explanatory sentence beneath it is allowed to contain "0%", and must be, on
 * the not_computed path.
 */
function headlineOf(html) {
  const m = html.match(/data-testid="sov-donut-headline"[^>]*>([\s\S]*?)<\/span>/);
  assert.ok(m, `no share-of-voice headline rendered; markup was: ${textOf(html).slice(0, 300)}`);
  return textOf(m[1]);
}

function hasStateChip(html) {
  return html.includes('data-testid="sov-donut-state-chip"');
}

/** The donut's composition run: hatched means "nothing to divide". */
function isHatched(html) {
  return html.includes("sb-hatch");
}

const base = (overrides = {}) => ({
  brand: "Zouk",
  rosterSource: "extracted",
  ...overrides,
});

// ---------------------------------------------------------------------------
// 1. THE not_computed PATH. Engines reported; none measured a rival roster.
//    This is the most common real shape and the one the retired test's fixture
//    never exercised.
// ---------------------------------------------------------------------------

const NOT_COMPUTED = base({
  perEngineSummaries: {
    aio: { share_of_voice_pct: null, self_mentions: 2, total_brand_mentions: null },
    perplexity: { share_of_voice_pct: null, self_mentions: 0, total_brand_mentions: null },
  },
});

test("ACCEPT — the not_computed path is the reason the fixture reaches", () => {
  const share = resolveShareOfVoice(NOT_COMPUTED);
  assert.equal(share.reason, "not_computed", "this fixture must exercise the reason under test");
  assert.equal(share.state, SHARE_STATE.UNAVAILABLE);
  assert.equal(share.pct, null);
});

test("ACCEPT — a not_computed share renders an em dash, never a percentage, on the live panel", async () => {
  const html = await renderPanel(NOT_COMPUTED);
  const headline = headlineOf(html);

  assert.equal(
    headline,
    "—",
    `the headline must be an em dash for a share nobody computed; it was "${headline}"`
  );
  assert.ok(
    !/\d/.test(headline),
    `no digit may appear in the headline of an unmeasured share; it was "${headline}"`
  );
  assert.ok(hasStateChip(html), "the em dash must be accompanied by a state chip, never left bare");
  assert.ok(
    textOf(html).includes(NOT_AVAILABLE_LABEL),
    "the chip must carry the shared not-available wording"
  );
  assert.ok(
    isHatched(html),
    "the composition run must be hatched — a full or empty bar would assert a division that never happened"
  );
});

test("ACCEPT — the not_computed path says WHY, and is allowed to write '0%' inside that sentence", async () => {
  const html = await renderPanel(NOT_COMPUTED);
  const text = textOf(html);

  assert.ok(
    html.includes('data-testid="sov-donut-unavailable"'),
    "the roster was fine, so this is the 'unavailable' explanation, not the 'not assessed' one"
  );
  assert.ok(
    text.includes("no engine in this scan measured a rival roster") ||
      text.includes("No engine in this scan measured a rival roster"),
    `the panel must name the cause; text was: ${text.slice(0, 400)}`
  );
  // The point of this test. A blanket "the markup contains no %" guard would
  // fail here on CORRECT behaviour, which is why the assertions above are
  // scoped to the headline instead.
  assert.ok(
    text.includes("That is not the same as a 0% share."),
    "the sentence that distinguishes 'undefined' from 'zero' is the whole honesty claim, " +
      "and it necessarily contains the characters '0%'"
  );
  assert.equal(
    resolveShareOfVoice(NOT_COMPUTED).detail,
    // Verbatim: the panel must print the resolver's sentence, so the donut and
    // any future surface cannot drift into two vocabularies again.
    "No engine in this scan measured a rival roster, so share of voice is undefined for it. " +
      "That is not the same as a 0% share.",
    "the resolver owns the wording"
  );
  assert.ok(text.includes(resolveShareOfVoice(NOT_COMPUTED).detail), "and the panel prints it verbatim");
});

// ---------------------------------------------------------------------------
// 2. THE DISTINCTION ITSELF, on the live surface. Standing rule 1.
// ---------------------------------------------------------------------------

/** One engine assessed a roster, found four mentions, none of them ours. */
const MEASURED_ZERO = base({
  perEngineSummaries: {
    aio: {
      share_of_voice_pct: 0,
      self_mentions: 0,
      total_brand_mentions: 4,
      top_rivals: [{ name: "Rival A", mentions: 4 }],
    },
  },
});

test("ACCEPT — the live panel prints a measured zero as a number", async () => {
  assert.equal(resolveShareOfVoice(MEASURED_ZERO).state, SHARE_STATE.MEASURED);

  const html = await renderPanel(MEASURED_ZERO);
  assert.equal(headlineOf(html), "0.0%", "a measured zero is a quantity and prints as one");
  assert.ok(
    !hasStateChip(html),
    "a measured zero is not in a state — the chip belongs to the absent cases"
  );
  assert.ok(
    !isHatched(html),
    "a measured zero has a real composition (the rivals hold it) and must draw it"
  );
  assert.ok(textOf(html).includes("Rival A"), "the brands that DID hold the mentions are named");
});

test("ACCEPT — measured zero and never-computed are different objects on screen", async () => {
  const zero = await renderPanel(MEASURED_ZERO);
  const absent = await renderPanel(NOT_COMPUTED);

  assert.notEqual(headlineOf(zero), headlineOf(absent), "this is the whole finding");
  assert.notEqual(
    textOf(zero),
    textOf(absent),
    "the two states must not read identically to a customer"
  );
  assert.equal(hasStateChip(zero), false);
  assert.equal(hasStateChip(absent), true);
  assert.equal(isHatched(zero), false);
  assert.equal(isHatched(absent), true);
});

test("a scan with no per-engine summaries at all is unavailable for its own reason", async () => {
  const result = base();
  assert.equal(resolveShareOfVoice(result).reason, "no_engine_summaries");

  const html = await renderPanel(result);
  assert.equal(headlineOf(html), "—");
  assert.ok(hasStateChip(html));
  assert.ok(
    textOf(html).includes("stored no per-engine summary"),
    "a different cause gets a different sentence, not a shared shrug"
  );
});

test("a scan whose rival extractor never ran says 'not assessed', not a share", async () => {
  // The scan-level field is deliberately present AND large: a roster that was
  // never assessed supports no share, whatever any field says.
  const html = await renderPanel(base({ rosterSource: "unavailable", shareOfVoicePct: 100 }));

  assert.equal(headlineOf(html), "—", "an unassessed roster must not print 100%");
  assert.ok(!textOf(html).includes("100.0%"), "the number nobody earned must be absent");
  assert.ok(
    html.includes('data-testid="sov-donut-not-assessed"'),
    "'extractor offline' and 'nothing measured' are different facts with different ids"
  );
  assert.ok(textOf(html).includes("Not assessed"), "and different words");
});

test("a measured non-zero share still renders its number and composition", async () => {
  const html = await renderPanel(
    base({
      perEngineSummaries: {
        aio: {
          share_of_voice_pct: 40,
          self_mentions: 2,
          total_brand_mentions: 5,
          top_rivals: [{ name: "Rival A", mentions: 3 }],
        },
      },
    })
  );

  assert.equal(headlineOf(html), "40.0%");
  assert.ok(!hasStateChip(html), "a real number needs no state chip");
  assert.ok(!isHatched(html), "a measured share draws its composition");
});

// ---------------------------------------------------------------------------
// 3. The harness's own teeth.
// ---------------------------------------------------------------------------

test("the harness renders the REAL panel with the REAL share module", async () => {
  const html = await renderPanel(NOT_COMPUTED);

  assert.ok(html.includes('data-testid="rank-share-row"'), "this is RankAndSharePanel's own markup");
  assert.ok(html.includes('data-testid="share-strap"'), "with its Share of Voice strap");
  assert.ok(html.includes('data-testid="sov-donut"'), "and the real Donut inside it");
  // Proof shareOfVoice.js was not stubbed: the label this file imported through
  // node's own loader is the string that came out of the compiled tree.
  assert.ok(NOT_AVAILABLE_LABEL.length > 0);
  assert.ok(textOf(html).includes(NOT_AVAILABLE_LABEL));
});

test("the harness refuses to stub a project module it was not told about", async () => {
  await assert.rejects(
    () => loadProjectModule(path.join(HERE, "does-not-exist.jsx")),
    /ENOENT|no such file/i,
    "a missing module must throw, not resolve to an agreeable Proxy"
  );

  // The substitution table is a finite, enumerated list — not a Proxy that
  // answers to anything. A catch-all here would have replaced shareOfVoice.js
  // with a stub that agrees with every assertion in this file, which is how the
  // retired ScoreBreakdown harness's own note said such a suite goes vacuous.
  assert.deepEqual(
    [...EXTERNAL.keys()].sort(),
    ["framer-motion", "lucide-react", "react"],
    "only these three are substituted; none of them produces text"
  );
  assert.equal(EXTERNAL.has("@/components/perceev/charts/shareOfVoice"), false);
  assert.equal(EXTERNAL.has("./shareOfVoice"), false);
  assert.equal(
    resolveSpecifier("@/components/perceev/charts/shareOfVoice", PANEL_PATH),
    path.join(SRC, "components", "perceev", "charts", "shareOfVoice.js"),
    "the module under test is loaded from disk, not from the substitution table"
  );
});

test("the live surface is the one the scan-report route mounts", async () => {
  // Cheap structural restatement of routeReachability.test.mjs's walk, kept
  // here so this file's premise is visible where its assertions are.
  const analytics = await readFile(path.join(HERE, "OverviewAnalytics.jsx"), "utf8");
  assert.ok(
    /<RankAndSharePanel\s/.test(analytics),
    "OverviewAnalytics must still render RankAndSharePanel, or this file tests a surface nobody sees"
  );
  const overview = await readFile(path.join(HERE, "OverviewView.jsx"), "utf8");
  assert.ok(/<OverviewAnalytics\s/.test(overview));
});
