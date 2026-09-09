/**
 * R6.4.12 (second half) — "engine chip" names ONE concept in this tree.
 *
 * WHAT THE FINDING SAID, AND WHAT TURNED OUT TO BE TRUE.
 *
 * The R2.7.8 implementer filed AnswersView's `engineChips` array as "a second
 * unshared implementation of the concept whose percent-sign rule R2.7.8 just
 * gave one home". Resolving the anchor: it is not. The two arrays are different
 * concepts that had collided on one name, and merging them would have been the
 * wrong fix:
 *
 *   ScoreBand's engineChips   `{ label, value, state }` where `value` is a
 *                             share_of_ai_pct that CAN BE GENUINELY ABSENT.
 *                             That absence is the whole reason R2.7.8 built
 *                             describeEngineChip: em dash plus state, never 0,
 *                             never a bare "—%".
 *   AnswersView's array       `{ label, count }` where count is
 *                             `prompts.filter(...).length` — always a real
 *                             integer over the rows in hand. A count of 0 is a
 *                             measured zero, not a missing measurement.
 *
 * Routing the second through the first would let an always-measured number
 * render as "not measured": the same lie as `?? 0`, pointed the other way. So
 * the remedy is not a merge. It is (a) the name, which now means one thing —
 * AnswersView's array is `engineFilters` — and (b) this guard, so the name
 * cannot start meaning two things again without a test going red.
 *
 * The duplication that WAS real in AnswersView was one level down: the verdict
 * filter row and the engine filter row were two copies of identical pill
 * markup. They are now one `FilterRow`.
 *
 * WHAT THIS FILE PROVES:
 *   1. By RENDERING the real AnswersView: the engine filter row exists, its
 *      counts are the true per-engine tallies (computed here, independently of
 *      the component), they conserve — every prompt is counted exactly once —
 *      and no pill carries a percent sign.
 *   2. By walking the source: `engineChips` appears in exactly two files and
 *      `describeEngineChip` is defined exactly once. A second engine-chip
 *      renderer fails this.
 *
 * WHAT IT CANNOT PROVE: `renderToStaticMarkup`, so no browser, no CSS, no
 * click. It shows the words and attributes reach the DOM; it does not show a
 * reader can see them or that the filter actually filters on click.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync as read, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

import * as interlockingModule from "./interlocking.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ANSWERS_PATH = path.join(HERE, "AnswersView.jsx");
const SCORE_BAND_PATH = path.join(HERE, "ScoreBand.jsx");
const SHELL_PATH = path.join(HERE, "DashboardShell.jsx");
const SRC = path.resolve(HERE, "../..");

function nullComponent() {
  return null;
}

/** Every icon import resolves to a component that renders nothing. */
const anyNamedExport = new Proxy(
  { __esModule: true },
  {
    get(target, prop) {
      if (prop in target) return target[prop];
      return nullComponent;
    },
  }
);

/** Compile one .jsx file to CJS and evaluate it. Same shape as scoreBandEngineChips.test.mjs. */
function loadJsx(filePath, requireShim) {
  const source = read(filePath, "utf8");
  const { code } = transform(source, {
    transforms: ["jsx", "imports"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    filePath,
  });
  /* Named `mod`, not `module`: the compiled CJS still receives it as its
     `module` parameter, but @next/next/no-assign-module-variable fires on the
     local name. scoreBandEngineChips.test.mjs predates that and still trips it;
     not touched here, it is another task's file. */
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function("require", "module", "exports", "React", code);
  factory(requireShim, mod, mod.exports, React);
  return mod.exports;
}

function loadAnswersView() {
  const reactModule = { ...React, __esModule: true };
  reactModule.default = reactModule;
  const modules = new Map([
    ["react", reactModule],
    ["lucide-react", anyNamedExport],
    ["./interlocking", { ...interlockingModule, __esModule: true }],
  ]);
  return loadJsx(ANSWERS_PATH, (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    throw new Error(`AnswersView.jsx imports "${specifier}", which this harness does not resolve — add it deliberately.`);
  });
}

/**
 * A multi-engine tracked set. Deliberately lopsided (4 / 2 / 1) so a component
 * that printed the same number on every pill, or the total on every pill, is
 * caught by arithmetic rather than by one lucky equality.
 */
const PROMPTS = [
  { prompt: "best crm for hospitals", engine: "aio", aioPresent: true, visible: true },
  { prompt: "hospital crm comparison", engine: "aio", aioPresent: true, visible: false },
  { prompt: "crm for clinics", engine: "aio", aioPresent: false, visible: false },
  { prompt: "top healthcare crm", engine: "aio", aioPresent: true, visible: false, brandCited: true },
  { prompt: "best crm for hospitals", engine: "perplexity", aioPresent: true, visible: true },
  { prompt: "hospital crm comparison", engine: "perplexity", aioPresent: false, visible: false, error: "503" },
  { prompt: "best crm for hospitals", engine: "chatgpt", aioPresent: true, visible: false },
];

function renderAnswers(props) {
  const { AnswersView } = loadAnswersView();
  assert.equal(typeof AnswersView, "function", "AnswersView.jsx must still export the component");
  return renderToStaticMarkup(React.createElement(AnswersView, props));
}

/** The `<div data-testid="...">` block for one filter row, or null. */
function filterRow(html, testid) {
  const open = new RegExp(`<div[^>]*data-testid="${testid}"[^>]*>`).exec(html);
  if (!open) return null;
  let depth = 1;
  let i = open.index + open[0].length;
  const tag = /<\/?div\b[^>]*>/g;
  tag.lastIndex = i;
  let t;
  while (depth > 0 && (t = tag.exec(html)) !== null) {
    depth += t[0].startsWith("</") ? -1 : 1;
    i = t.index + t[0].length;
  }
  assert.equal(depth, 0, `unbalanced markup for ${testid} — the extractor is lying about what rendered`);
  return html.slice(open.index, i);
}

/** [{ key, count, text }] for every pill in a row. */
function pillsOf(rowHtml) {
  const out = [];
  const re = /<button[^>]*data-filter-key="([^"]*)"[^>]*data-filter-count="([^"]*)"[^>]*>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(rowHtml)) !== null) {
    out.push({
      key: m[1],
      count: Number(m[2]),
      text: m[3].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1. The rendered engine filter row is a COUNT row, and the counts are real.
// ---------------------------------------------------------------------------

test("R6.4.12 — the engine filter row carries true per-engine tallies, not percentages", () => {
  const html = renderAnswers({ prompts: PROMPTS, brandAliases: ["Acme"] });

  const row = filterRow(html, "answers-engine-filters");
  assert.ok(row, "the engine filter row did not render, so nothing below proves anything");

  const pills = pillsOf(row);
  assert.ok(pills.length >= 4, `expected an "all" pill plus three engines; got ${pills.length}`);

  // Computed HERE from the fixture, not read back off the component.
  const expected = new Map([
    ["all", PROMPTS.length],
    ["aio", PROMPTS.filter((p) => p.engine === "aio").length],
    ["perplexity", PROMPTS.filter((p) => p.engine === "perplexity").length],
    ["chatgpt", PROMPTS.filter((p) => p.engine === "chatgpt").length],
  ]);
  assert.deepEqual(new Map(pills.map((p) => [p.key, p.count])), expected, "an engine pill is claiming a count it did not earn");

  // TEETH: the tallies are distinct, so "every pill printed the same number"
  // cannot pass. (4 / 2 / 1 by construction.)
  const engineCounts = pills.filter((p) => p.key !== "all").map((p) => p.count);
  assert.equal(new Set(engineCounts).size, engineCounts.length, "the fixture must keep the tallies distinct");

  // CONSERVATION: every prompt is counted under exactly one engine. A phantom
  // engine, or one prompt counted twice, breaks this.
  assert.equal(
    engineCounts.reduce((a, b) => a + b, 0),
    PROMPTS.length,
    "the engine pills must account for every tracked prompt exactly once"
  );

  // The percent-sign rule is not "shared with ScoreBand" — it is "this row has
  // no percentages in it at all". A count is not a share.
  assert.ok(!row.includes("%"), `a count row must not print a percent sign: ${row}`);
  for (const pill of pills) {
    assert.ok(/\d/.test(pill.text), `pill "${pill.key}" rendered no number at all: ${pill.text}`);
    assert.ok(!pill.text.includes("—"), `pill "${pill.key}" rendered an em dash; a count is never absent`);
  }
});

test("R6.4.12 — the two filter rows are one renderer, and both still render", () => {
  const html = renderAnswers({ prompts: PROMPTS, brandAliases: ["Acme"] });

  const verdicts = filterRow(html, "answers-verdict-filters");
  const engines = filterRow(html, "answers-engine-filters");
  assert.ok(verdicts, "the verdict filter row must still render");
  assert.ok(engines, "and the engine filter row alongside it");

  const verdictPills = pillsOf(verdicts);
  assert.equal(verdictPills.length, 5, "all / names you / rival held it / no answer / cited you");
  assert.equal(
    verdictPills.find((p) => p.key === "all").count,
    PROMPTS.length,
    "the verdict row's counts must be real too"
  );
  assert.equal(
    verdictPills.find((p) => p.key === "visible").count,
    PROMPTS.filter((p) => p.visible).length
  );
  assert.ok(!verdicts.includes("%"), "the verdict row is a count row as well");

  // Both rows carry the same machine-readable shape because they are the same
  // component. If someone re-forks one of them, these attributes go missing.
  for (const [name, row] of [["verdict", verdicts], ["engine", engines]]) {
    assert.match(row, /data-filter-key="/, `${name} row lost its key attribute — is it still FilterRow?`);
    assert.match(row, /data-filter-count="/, `${name} row lost its count attribute`);
  }
});

test("R6.4.12 — a single-engine scan shows no engine row, and an engineless one shows none either", () => {
  // Not a bug: with one engine there is nothing to filter between. Asserted so
  // the absence is a decision on record rather than an accident, and so the
  // positive test above cannot be satisfied by a row that always renders.
  const single = renderAnswers({ prompts: PROMPTS.filter((p) => p.engine === "aio") });
  assert.equal(filterRow(single, "answers-engine-filters"), null, "one engine, nothing to choose between");
  assert.ok(filterRow(single, "answers-verdict-filters"), "the verdict row is still there");

  const engineless = renderAnswers({ prompts: [{ prompt: "q", aioPresent: true, visible: true }] });
  assert.equal(filterRow(engineless, "answers-engine-filters"), null, "no engine recorded, no engine row");

  const empty = renderAnswers({ prompts: [] });
  assert.equal(filterRow(empty, "answers-engine-filters"), null);
  const emptyVerdicts = pillsOf(filterRow(empty, "answers-verdict-filters"));
  assert.ok(
    emptyVerdicts.every((p) => p.count === 0),
    "with no prompts every count is a real zero — that is a measurement, not an absence"
  );
});

// ---------------------------------------------------------------------------
// 2. THE GUARD — one engine-chip concept, one implementation.
// ---------------------------------------------------------------------------

/**
 * Comments removed so the guard reads code. AnswersView.jsx names `engineChips`
 * in a doc comment explaining that its own row is NOT one; flagging that would
 * punish the explanation.
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1");
}

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
      continue;
    }
    if (!/\.(js|jsx|mjs)$/.test(entry)) continue;
    if (/\.test\.(mjs|js)$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

/**
 * `engineChips` means ScoreBand's MEASUREMENT row and nothing else.
 *
 *   - ScoreBand.jsx      owns the prop and the only renderer for it.
 *   - DashboardShell.jsx builds the array and passes it down. It supplies raw
 *     values (`value: measured ? share : null`) and never a preformatted
 *     string, because ScoreBand decides what an absent measurement looks like.
 *
 * Any third file using this name is either a second renderer (the finding) or a
 * different concept wearing the same name (what AnswersView was). Both are
 * failures; give the second one its own name, as `engineFilters` now has.
 */
const ENGINE_CHIP_FILES = new Set([SCORE_BAND_PATH, SHELL_PATH]);

test("R6.4.12 GUARD — `engineChips` names exactly one concept", () => {
  const files = sourceFiles(SRC);
  assert.ok(files.length > 100, `the walker found only ${files.length} source files — it is not walking the tree`);

  const users = files.filter((f) => /\bengineChips\b/.test(stripComments(read(f, "utf8"))));

  assert.deepEqual(
    users.map((f) => path.relative(SRC, f)).sort(),
    [...ENGINE_CHIP_FILES].map((f) => path.relative(SRC, f)).sort(),
    "a third file is using the name `engineChips`. If it is a second renderer, fold it onto ScoreBand's; " +
      "if it is a different concept, give it a different name."
  );

  // NON-VACUITY: the expectation must not be an empty set that trivially
  // matches. The two allowlisted files must really contain the name.
  for (const owner of ENGINE_CHIP_FILES) {
    assert.match(stripComments(read(owner, "utf8")), /\bengineChips\b/, `${owner} no longer uses the name it owns`);
  }
});

test("R6.4.12 GUARD — describeEngineChip is defined once, in ScoreBand", () => {
  const files = sourceFiles(SRC);
  const definers = files.filter((f) =>
    /(export\s+)?(const|let|var|function)\s+describeEngineChip\b/.test(stripComments(read(f, "utf8")))
  );

  assert.deepEqual(
    definers,
    [SCORE_BAND_PATH],
    "the engine-chip formatter has more than one definition — the percent-sign rule has two homes again"
  );

  // ...and no near-miss spelling of the same job elsewhere.
  //
  // This is the census, not a prohibition: everything named *EngineChip* in the
  // tree, each entry justified. A NEW name lands here and fails, forcing the
  // author to say which of the three things it is. Every current entry:
  //
  //   ScoreBand.jsx          describeEngineChip — THE formatter, and the chip
  //                          it formats. The percent-sign rule (R2.7.8).
  //   DashboardShell.jsx     measuredEngineChips / droppedEngineChips — the two
  //                          halves that BUILD ScoreBand's array. Same concept,
  //                          upstream of it; they supply raw values and format
  //                          nothing.
  //   PromptMetricsTable.jsx <EngineChips> — a DIFFERENT concept sharing the
  //                          name: per-prompt, per-engine outcome badges
  //                          ({engine, answered, mentioned}) carrying no number
  //                          at all, so the percent-sign rule cannot apply to
  //                          it. Allowlisted rather than renamed because that
  //                          file is outside R6.4.12's scope; the collision is
  //                          filed as follow-up, not fixed quietly here.
  //
  // NOT caught, and deliberately: describeShareMetric in
  // components/perceev/charts/shareOfVoice.js. It formats a scan-level share of
  // voice — a different measurement with its own resolver — and says so.
  const NAMED_ENGINE_CHIP = new Set([
    SCORE_BAND_PATH,
    SHELL_PATH,
    path.join(HERE, "PromptMetricsTable.jsx"),
  ]);
  const census = files.filter((f) =>
    /(export\s+)?(const|let|var|function)\s+\w*[eE]ngineChip\w*\s*[=(]/.test(stripComments(read(f, "utf8")))
  );
  assert.deepEqual(
    census.map((f) => path.relative(SRC, f)).sort(),
    [...NAMED_ENGINE_CHIP].map((f) => path.relative(SRC, f)).sort(),
    "something new is called an engine chip. Fold it onto ScoreBand's formatter if it carries a " +
      "measurement, or name it for what it actually is — and then add it here with the reason."
  );
});

test("R6.4.12 GUARD — the guard's patterns match the code they forbid", () => {
  // TEETH FOR THE GUARD. A source walker whose regexes match nothing passes on
  // the empty set. These are the literal shapes AnswersView.jsx carried before
  // this task, and the shape a second formatter would take.
  const WAS_THERE = [
    "  const engineChips = useMemo(() => {",
    "export const describeEngineChip = (chip) => {",
    "function renderEngineChip(chip) {",
  ];
  assert.match(WAS_THERE[0], /\bengineChips\b/, "the name pattern no longer matches the code it forbids");
  assert.match(
    WAS_THERE[1],
    /(export\s+)?(const|let|var|function)\s+describeEngineChip\b/,
    "the definition pattern no longer matches"
  );
  assert.match(
    WAS_THERE[2],
    /(export\s+)?(const|let|var|function)\s+\w*[eE]ngineChip\w*\s*[=(]/,
    "the near-miss pattern no longer matches"
  );

  // And the stripper does not blank real code while removing prose.
  const stripped = stripComments("/* engineChips is ScoreBand's */\nconst engineChips = [];");
  assert.doesNotMatch(stripped, /ScoreBand's/, "block comments must be removed");
  assert.match(stripped, /const engineChips = \[\]/, "but the code after them must survive");
});
