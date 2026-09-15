import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

import { normalizeResult } from "../../services/api.js";

/**
 * R2.2.11 — THE CITATION SHARE A CUSTOMER ACTUALLY SEES.
 *
 * The first pass of R2.2.11 made the scan-level mirror
 * (src/lib/scoring/enginePipeline.js) and summaryToMetricsRow
 * (src/lib/analytics/rollup.js) publish `null` instead of `0` when the citation
 * denominator is empty — every answered non-branded row's citation list
 * unobserved, so there is nothing to divide by. Both fixes were correct and
 * both were INVISIBLE, because SourcesView.jsx ended the chain with
 * `{result.brandCitationSharePct ?? 0}<small>%</small>`: the honest null was
 * coerced straight back into a confident "0% of non-branded answers citing
 * you". Byte-identical output before and after the fix.
 *
 * This file is the guard for the render edge, and it is deliberately not a unit
 * test of a helper: it compiles the REAL SourcesView.jsx off disk, feeds it a
 * result produced by the REAL normalizeResult() in src/services/api.js, and
 * reads the markup. The only hand-built thing is the database row, which is the
 * actual boundary — everything from there to the DOM is the shipped code.
 *
 * BOTH DIRECTIONS ARE ASSERTED, because blanking a real measurement is the same
 * crime as inventing one:
 *   - denominator 0, every citation leg unverified  -> em dash + state chip + why
 *   - denominator 4, brand in none of the lists     -> the number 0, with "%"
 *
 * ON THE "no digits" ASSERTIONS: they are scoped to the HEADLINE element
 * (`stat__v`), never to the whole panel. The honest explanation legitimately
 * ends "This is not a 0% share.", and a blanket "no percent sign anywhere"
 * guard would fail on correct behaviour — the trap liveShareOfVoiceSurface.test
 * .mjs documents from R2.7.6.
 *
 * WHAT THIS FILE DOES NOT PROVE: static markup only. No browser, no CSS, no
 * effects. It proves the words and the em dash reach the DOM, not that they are
 * legible. It also does not run the scan pipeline — that is
 * src/lib/scoring/citationShareEmptyDenominator.test.mjs, which drives the real
 * registry and asserts the null is produced in the first place.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, "..", "..");
const VIEW_PATH = path.join(HERE, "SourcesView.jsx");
const SHELL_PATH = path.join(HERE, "DashboardShell.jsx");

// ---------------------------------------------------------------------------
// Harness: compile the real component tree from disk. Lifted from
// liveShareOfVoiceSurface.test.mjs, which established the pattern.
// ---------------------------------------------------------------------------

const iconModule = new Proxy(
  { __esModule: true },
  { get: (target, prop) => (prop in target ? target[prop] : () => null) }
);

const reactModule = { ...React, __esModule: true };
reactModule.default = reactModule;

const EXTERNAL = new Map([
  ["react", reactModule],
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
 * Load one project file and everything it imports, for real. There is no
 * catch-all for project paths on purpose: a stub in that position could replace
 * SourcesView's own helper with something that agrees with every assertion.
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

  const module = { exports: {} };
  cache.set(file, module.exports);

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
  factory(requireShim, module, module.exports, reactModule);
  cache.set(file, module.exports);
  return module.exports;
}

async function loadView() {
  const exports = await loadProjectModule(VIEW_PATH);
  assert.equal(
    typeof exports.SourcesView,
    "function",
    "SourcesView.jsx must still export `SourcesView` — DashboardShell imports it by that name"
  );
  return exports;
}

/** Render the live view exactly as DashboardShell mounts it: <SourcesView result={...} />. */
async function renderView(result) {
  const { SourcesView } = await loadView();
  return renderToStaticMarkup(React.createElement(SourcesView, { result }));
}

/**
 * Slice one element out of static markup by a substring of its opening tag,
 * counting nested spans so the chip inside `stat__v` is included rather than
 * truncating at the first `</span>`.
 */
function sliceElement(html, marker) {
  const open = html.indexOf(marker);
  assert.notEqual(open, -1, `markup does not contain an element matching ${marker}`);
  const start = html.lastIndexOf("<", open);
  let depth = 0;
  const tag = /<(\/?)(span|div)\b/g;
  tag.lastIndex = start;
  let m;
  while ((m = tag.exec(html))) {
    depth += m[1] === "/" ? -1 : 1;
    if (depth === 0) return html.slice(start, html.indexOf(">", tag.lastIndex) + 1);
  }
  throw new Error(`unbalanced markup while slicing ${marker}`);
}

/**
 * The text a human READS, with tags (and therefore attribute values) removed.
 *
 * This matters: the `title` on the state chip carries the explanation, and the
 * honest explanation ends "This is not a 0% share." Asserting "no digits" over
 * raw markup would fail on correct behaviour — so the digit assertions below run
 * over the rendered text, and the explanation is asserted separately, by name.
 */
function visibleText(html) {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Fixtures: rows shaped like the database, normalized by the shipped normalizer.
// ---------------------------------------------------------------------------

/** A non-branded answer row that DID carry a readable source list. */
const citedRow = (domain, engine) => ({
  query: `best ${domain} tools`,
  engine,
  is_branded: false,
  aio_present: true,
  brand_mentioned: false,
  brand_cited: false,
  citations: [`https://${domain}/guide`],
  references: [`https://${domain}/guide`],
});

/**
 * A non-branded answer row whose citation list was never observed — no
 * `citations` / `references` key at all, which is what a dead citation leg
 * leaves behind and what R2.2.2 excludes from `citation_denominator`.
 */
const unverifiedRow = (n, engine) => ({
  query: `unverified question ${n}`,
  engine,
  is_branded: false,
  aio_present: true,
  brand_mentioned: false,
  brand_cited: false,
});

/**
 * Build the persisted `scans` row the dashboard route hands to normalizeResult.
 *
 * `brand_citation_share_pct` is exactly what enginePipeline's mirror wrote and
 * scanWorker.js:2000 persisted; the engine slices are what summarizeEngineSlice
 * emits (citation_denominator / citations_unverified_count, R2.2.2).
 *
 * The scan is deliberately MULTI-ENGINE and internally consistent. The mirror
 * follows `engines.aio`, so the aio slice's counters are the ones that explain
 * the missing share, and its answered rows carry no source list. A second
 * engine answered and cited normally — that is what keeps `top_domains`
 * populated and the stat grid on screen at all (with every engine dead,
 * SourcesView short-circuits to its own honest "Sources not recorded" panel and
 * the share is never rendered). It is also the case that would defeat a naive
 * reason built by summing every slice.
 */
function scanRow({ sharePct, denominator, unverified, answered }) {
  const engines = {
    aio: {
      non_branded_with_answer: answered,
      citation_denominator: denominator,
      citations_unverified_count: unverified,
      cited_non_branded: 0,
      share_of_ai_pct: 25,
    },
    perplexity: {
      non_branded_with_answer: 2,
      citation_denominator: 2,
      citations_unverified_count: 0,
      cited_non_branded: 0,
      share_of_ai_pct: 25,
    },
  };
  const results = [
    // aio: `unverified` rows with no source list, `denominator` rows with one.
    ...Array.from({ length: unverified ?? 0 }, (_, i) => unverifiedRow(i + 1, "aio")),
    ...Array.from({ length: denominator ?? 0 }, (_, i) => citedRow(`source-${i + 1}.com`, "aio")),
    citedRow("rival-one.com", "perplexity"),
    citedRow("rival-two.com", "perplexity"),
  ];
  return {
    brand: "Acme",
    website: "https://acme.example",
    results,
    summary_stats: {
      visibility_pct: 25,
      citation_share_pct: sharePct,
      citation_denominator: denominator,
      citations_unverified_count: unverified,
    },
    brand_citation_share_pct: sharePct,
    engines,
    top_domains: [
      { domain: "rival-one.com", count: 1, type: "competitor" },
      { domain: "rival-two.com", count: 1, type: "other" },
    ],
    raw_results: { engines, top_domains: [] },
  };
}

// ---------------------------------------------------------------------------

test("R2.2.11 — an unmeasurable citation share renders an em dash and why, NEVER 0%", async () => {
  // Every citation leg died: two answered non-branded rows, both unverified,
  // so the pool is empty and the mirror published null (enginePipeline.js).
  const result = normalizeResult(
    scanRow({ sharePct: null, denominator: 0, unverified: 2, answered: 2 }),
    "Acme",
    "https://acme.example"
  );

  assert.equal(
    result.brandCitationSharePct,
    null,
    "precondition: the normalizer must still be handing SourcesView a null — " +
      "if this fails the leak moved upstream of the render edge"
  );

  const html = await renderView(result);
  const stat = sliceElement(html, 'data-testid="brand-citation-share"');
  const headline = sliceElement(stat, 'class="stat__v is-you"');
  const shown = visibleText(headline);

  assert.match(shown, /—/, "a share nobody could compute renders as an em dash");
  assert.doesNotMatch(
    shown,
    /\d/,
    `the headline must carry NO number for an unmeasured share; it read "${shown}"`
  );
  assert.doesNotMatch(
    shown,
    /%/,
    `no percent sign either — "0%" and "—" must not be the same pixel; it read "${shown}"`
  );
  assert.match(
    headline,
    /class="chip chip--warn"/,
    "standing rule 5: the em dash travels with a state chip, not alone"
  );
  assert.match(shown, /Not measured/, "the chip must name the state");

  // ...and the REASON, read off the slice's own counters, not invented here.
  assert.match(
    stat,
    /2 of 2 answered non-branded answers came back unverified/,
    `the reason must quote citations_unverified_count / non_branded_with_answer; got ${stat}`
  );
  assert.doesNotMatch(
    stat,
    /of non-branded answers citing you/,
    "the caption that asserts a measured share must not survive an unmeasured one"
  );
});

test("R2.2.11 — a GENUINE 0% still renders as 0%, not as an em dash", async () => {
  // Four citation lists read in full, brand in none of them. That is a real
  // measurement and blanking it would be the opposite failure.
  const result = normalizeResult(
    scanRow({ sharePct: 0, denominator: 4, unverified: 0, answered: 4 }),
    "Acme",
    "https://acme.example"
  );

  assert.equal(result.brandCitationSharePct, 0, "precondition: a measured zero reaches the view");

  const html = await renderView(result);
  const headline = sliceElement(
    sliceElement(html, 'data-testid="brand-citation-share"'),
    'class="stat__v is-you"'
  );

  assert.equal(
    visibleText(headline),
    "0%",
    "a measured zero is a finding: it must print as the number 0 with its percent sign"
  );
  assert.match(headline, /<small>%<\/small>/, "rendered by the same markup as any other share");
  assert.doesNotMatch(headline, /—/, "and NO em dash — nothing here is unknown");
  assert.doesNotMatch(headline, /Not measured/, "and no state chip");
});

test("R2.2.11 — a measured non-zero share is unchanged", async () => {
  const result = normalizeResult(
    scanRow({ sharePct: 37.5, denominator: 8, unverified: 0, answered: 8 }),
    "Acme",
    "https://acme.example"
  );
  const html = await renderView(result);
  const headline = sliceElement(
    sliceElement(html, 'data-testid="brand-citation-share"'),
    'class="stat__v is-you"'
  );
  assert.equal(visibleText(headline), "37.5%");
  assert.doesNotMatch(headline, /—/);
});

test("R2.2.11 — describeCitationShare distinguishes the states, including a numeric string", async () => {
  const { describeCitationShare } = await loadView();
  assert.equal(typeof describeCitationShare, "function");

  // `scans.brand_citation_share_pct` is Postgres `numeric`. A driver that hands
  // back "0.0" is reporting a MEASUREMENT; treating it as absent would blank a
  // real zero, which is the failure this task exists to prevent in reverse.
  assert.deepEqual(describeCitationShare({ brandCitationSharePct: "0.0" }), {
    value: 0,
    chip: null,
    note: null,
  });
  assert.equal(describeCitationShare({ brandCitationSharePct: 12 }).value, 12);

  // No number, and no slice to explain it: say that, rather than guess a reason.
  const blind = describeCitationShare({ brandCitationSharePct: null });
  assert.equal(blind.value, null);
  assert.equal(blind.chip, "Not measured");
  assert.match(blind.note, /no citation denominator/);

  // No number, empty pool, nothing was ever answered — a different fact from
  // "answered but unverified", and it must not borrow that sentence.
  const unanswered = describeCitationShare({
    brandCitationSharePct: null,
    perEngineSummaries: {
      aio: { citation_denominator: 0, citations_unverified_count: 0, non_branded_with_answer: 0 },
    },
  });
  assert.match(unanswered.note, /No non-branded answer reached the citation stage/);
  assert.doesNotMatch(unanswered.note, /unverified/);

  // The reason comes from the slice the scan-level number MIRRORS (`engines.aio`,
  // else the first engine), not from every slice added up: a healthy second
  // engine must not be quoted as the explanation for a number it did not produce.
  const mixed = describeCitationShare({
    brandCitationSharePct: null,
    perEngineSummaries: {
      aio: { citation_denominator: 0, citations_unverified_count: 2, non_branded_with_answer: 2 },
      perplexity: {
        citation_denominator: 5,
        citations_unverified_count: 0,
        non_branded_with_answer: 5,
      },
    },
  });
  assert.match(mixed.note, /2 of 2 answered/, `read the mirrored slice; got "${mixed.note}"`);
  assert.doesNotMatch(mixed.note, /5/, "the healthy engine's counters are not the reason");

  // No `aio` key at all (a text-engine-only scan): the mirror falls back to the
  // first engine, and so does the reason.
  const firstEngine = describeCitationShare({
    brandCitationSharePct: null,
    perEngineSummaries: {
      perplexity: {
        citation_denominator: 0,
        citations_unverified_count: 3,
        non_branded_with_answer: 3,
      },
    },
  });
  assert.match(firstEngine.note, /3 of 3 answered/);

  // NaN and undefined are not measurements either.
  assert.equal(describeCitationShare({ brandCitationSharePct: undefined }).value, null);
  assert.equal(describeCitationShare({ brandCitationSharePct: "n/a" }).value, null);
  assert.equal(describeCitationShare(undefined).value, null);
});

test("R2.2.11 — the surface this guards is the one DashboardShell mounts", async () => {
  // The fix is worthless on a component no route reaches (the R2.7.6 lesson).
  // Read, not assumed: DashboardShell renders SourcesView for view "sources",
  // and "sources" is an accepted view.
  const shell = await readFile(SHELL_PATH, "utf8");
  assert.match(
    shell,
    /view === "sources" && <SourcesView result=\{result\} \/>/,
    "DashboardShell must still mount SourcesView with the normalized result"
  );
  assert.match(
    shell,
    /validViews = \[[^\]]*"sources"/,
    '"sources" must still be a reachable view'
  );
});
