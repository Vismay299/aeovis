import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  ENGINE_LABELS,
  deployedEngines,
  deployedEngineLabels,
  formatEngineList,
  parseEngineList,
  engineDriftWarning,
} from "./engines/deployedEngines.js";
import { DEFAULT_UNBRANDED_TARGET } from "./scoring/promptSetSize.js";
import { SAMPLE_DESTINATIONS, SAMPLE_RESULT } from "../data/mockData.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFile(path.join(REPO, rel), "utf8");

const SHEET_PATH = path.join(REPO, "src/components/landing/AnswerSheet.jsx");
const PAGE_PATH = path.join(REPO, "src/app/page.js");

/**
 * The landing surfaces that attribute a sample answer to an engine. Both carry
 * a chip beside a fabricated answer, and both got there by typing a name.
 *
 * R2.10.6 widened this from AnswerSheet.jsx alone. R2.10.5 closed the hero
 * sheet's chip and its close record said that was the last typed engine name on
 * the page; page.js:295 was a second one, on a second sample card, and rebuilt
 * under NEXT_PUBLIC_ENGINES=perplexity it was the ONLY "Google AI Overview"
 * left in the served HTML. The list is the fix: a guard that scans one of two
 * identical surfaces is a guard that certifies the one it does not read.
 */
const LITERAL_SCAN_FILES = [
  ["src/components/landing/AnswerSheet.jsx", SHEET_PATH],
  ["src/app/page.js", PAGE_PATH],
];

/**
 * page.js types engine names in exactly ONE place that is not an attribution:
 * the ENGINE_NOTE dictionary (page.js:117-121). Its entries are reached only
 * through DEPLOYED_ENGINE_LABELS.map(...), so an entry for an engine this
 * deployment does not probe can never render.
 *
 * WHAT SHIPS, exactly. This PARSES the declaration; it does not read lines. It
 * walks from `const ENGINE_NOTE = {` one character at a time, always knowing
 * which quote it is inside, and accepts one shape and no other:
 *
 *     <key>: <value>,     key   = a bare identifier or a quoted string, and it
 *                                 must be a known engine label
 *                         value = ONE quoted string literal, on ONE line
 *
 * The KEY is dropped from the scanned text. The VALUE is KEPT in it, so every
 * engine label written into any note's prose is scanned, with one stated
 * allowance: an entry's own key label may appear in its own prose ("ChatGPT
 * returns a single paragraph"), so occurrences of that ONE label are replaced
 * by a placeholder before the value is handed back. That is
 * labels.filter((l) => l !== own) — every OTHER label in that value survives
 * and is scanned. Replaced rather than deleted, so the allowance can never
 * splice a value's neighbouring words into a label nobody wrote.
 *
 * EVERYTHING ELSE THROWS. A template-literal value, a value spanning two lines,
 * a concatenation, an array, a nested object, a call, a comment inside the
 * block, a key that is not a known engine label, an empty dictionary, a
 * declaration that does not end at `};`, engine labels that overlap so the
 * own-label allowance could hide one, a missing DEPLOYED_ENGINE_LABELS filter:
 * every one of those is a shape this exemption cannot reason about, and an
 * exemption that cannot reason about a shape must REFUSE it, not guess at it.
 * That is the posture the declaration and filter guards already take.
 *
 * WHY A PARSER AND NOT A HEURISTIC. Three line-oriented versions shipped and
 * all three were evaded within minutes, always by the same move: put an engine
 * name in a note VALUE where the line heuristic reads a key.
 *   1. The first cut per LINE: any line opening with a label and a colon was
 *      taken for that line's key and deleted whole, so a value Prettier-wrapped
 *      onto its own line beginning "ChatGPT: ..." was erased instead of scanned.
 *   2. The second cut only the key TOKEN and gated it on the previous non-blank
 *      line ending in `{` or `,` — raw text, with no idea which quote it was
 *      inside. So a TEMPLATE-LITERAL value whose first line ended in a comma
 *      made its own continuation line look like the start of an entry, and
 *      "ChatGPT: and the click that never happens is what it costs you."
 *      rendered into the engine rail of a NEXT_PUBLIC_ENGINES=aio build with
 *      all 17 tests here reporting green. One comma was enough.
 * A comma inside a string is not structure, and only something that knows which
 * quote it is inside can tell the two apart. So that is what this is.
 *
 * IT READS THE RAW FILE, BEFORE withoutComments. Same reason: a slash-star
 * "comment" written inside a note is not a comment at all, it is prose the page
 * renders. Stripping first took the engine name out of a value that reads
 * "An AI Overview answer, slash-star ChatGPT: and the click that never happens
 * star-slash, is what your buyer reads." and the aio-only build printed it into
 * the rail with every test green. So the parse happens first, on raw text; a
 * real comment INSIDE the declaration is refused like any other shape this
 * cannot parse; and every value is handed back with its comment openers
 * defanged, so the stripper that runs afterwards cannot reach into it either.
 */
function withoutEngineNoteDictionary(src, labels) {
  if (!Array.isArray(labels) || labels.length === 0) {
    throw new Error("landingHonesty: the ENGINE_NOTE exemption needs the label list to scope itself");
  }
  // The own-label allowance is a text replacement inside one value, which is
  // only sound while no label can run into or contain another. If one could,
  // replacing the own label might take a real off-deployment label out of the
  // scanned text with it. Refuse rather than silently under-scan.
  for (const a of labels) {
    for (const b of labels) {
      if (a === b) continue;
      let clash = b.includes(a);
      for (let k = 1; !clash && k < a.length; k += 1) clash = b.startsWith(a.slice(a.length - k));
      if (clash) {
        throw new Error(
          'landingHonesty: engine labels "' + a + '" and "' + b + '" overlap, so the '
            + "ENGINE_NOTE own-label allowance could delete the second one out of a "
            + "note it was written into. Rework the allowance before shipping a label "
            + "that contains or runs into another."
        );
      }
    }
  }
  const DECL = "const ENGINE_NOTE = {";
  const start = src.indexOf(DECL);
  if (start < 0) {
    throw new Error(
      "landingHonesty: page.js no longer declares ENGINE_NOTE in the shape this "
        + "guard exempts from the typed-literal scan. Re-read the exemption before "
        + "widening it — it is the one blind spot in this check."
    );
  }
  const lineOf = (at) => src.slice(0, at).split("\n").length;
  const refuse = (at, what) => {
    throw new Error(
      "landingHonesty: the ENGINE_NOTE exemption refuses to scan " + what
        + " (page.js line " + lineOf(at) + "). Every entry must be a key and a "
        + "single-line quoted string. A shape this guard cannot parse is a shape it "
        + "cannot exempt safely: a template literal wrapped after a comma is how an "
        + "off-deployment engine name last reached the served HTML."
    );
  };
  const SPACE = " \t\r\n";
  const entries = [];
  let i = start + DECL.length;
  let closed = false;
  while (i < src.length) {
    while (i < src.length && SPACE.includes(src[i])) i += 1;
    if (i >= src.length) break;
    if (src[i] === "}") {
      closed = true;
      i += 1;
      break;
    }
    // --- the key: a bare identifier, or a string in matching quotes ---
    const keyAt = i;
    let key;
    if (src[i] === "'" || src[i] === '"') {
      const q = src[i];
      i += 1;
      const from = i;
      while (i < src.length && src[i] !== q && src[i] !== "\n") i += 1;
      if (src[i] !== q) refuse(keyAt, "a key that is not a plain single-line quoted string");
      key = src.slice(from, i);
      i += 1;
    } else {
      const from = i;
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) i += 1;
      if (i === from) {
        refuse(keyAt, "something that is not a key: a spread, a computed key, or a comment");
      }
      key = src.slice(from, i);
    }
    while (src[i] === " " || src[i] === "\t") i += 1;
    if (src[i] !== ":") refuse(i, "a key that is not followed by a colon");
    i += 1;
    // --- the value: exactly one quoted string, on exactly one line ---
    while (i < src.length && SPACE.includes(src[i])) i += 1;
    const valueAt = i;
    const q = src[i];
    if (q !== "'" && q !== '"') {
      refuse(
        valueAt,
        "a value that is not a quoted string: a template literal, a concatenation, "
          + "an array, a nested object or a call"
      );
    }
    i += 1;
    const from = i;
    while (i < src.length && src[i] !== q) {
      if (src[i] === "\n") refuse(valueAt, "a value that spans more than one line");
      if (src[i] === "\\") {
        if (src[i + 1] === "\n") refuse(valueAt, "a value continued onto a second line by a backslash");
        i += 2;
      } else {
        i += 1;
      }
    }
    if (i >= src.length) refuse(valueAt, "a value whose quote never closes");
    entries.push({ key, value: src.slice(from, i), at: keyAt });
    i += 1;
    // --- the separator: a comma, or the end of the dictionary ---
    while (i < src.length && SPACE.includes(src[i])) i += 1;
    if (src[i] === ",") {
      i += 1;
      continue;
    }
    if (src[i] === "}") {
      closed = true;
      i += 1;
      break;
    }
    refuse(i, "an entry not followed by a comma or by the end of the dictionary");
  }
  if (!closed) refuse(start, "an ENGINE_NOTE declaration whose brace never closes");
  if (src[i] !== ";") refuse(i, "an ENGINE_NOTE declaration that does not end at a semicolon");
  const rest = src.slice(i + 1);
  if (!/RAIL_NOTES = DEPLOYED_ENGINE_LABELS\.map\(\(name\) => ENGINE_NOTE\[name\]\)/.test(rest)) {
    throw new Error(
      "landingHonesty: ENGINE_NOTE is exempt from the typed-literal scan ONLY "
        + "because DEPLOYED_ENGINE_LABELS filters it down to the deployed engines. "
        + "That filter is gone, so the exemption now hides a renderable literal."
    );
  }
  if (entries.length === 0) {
    throw new Error(
      "landingHonesty: ENGINE_NOTE is empty, so this exemption read zero entries and "
        + "the engine rail renders no note at all. A scan that covered nothing must "
        + "say so rather than report itself clean."
    );
  }
  const scanned = entries
    .map(({ key, value, at }) => {
      if (!labels.includes(key)) {
        throw new Error(
          'landingHonesty: ENGINE_NOTE is keyed "' + key + '" at page.js line ' + lineOf(at)
            + ", which is not a known engine label. RAIL_NOTES looks these entries up BY "
            + "LABEL, so a key that is not one is either a note that can never render or "
            + "a place to keep an engine name out of this scan."
        );
      }
      // The one allowance: this entry's OWN label, inside its own prose. Then
      // defang the two comment openers, because the caller strips comments with
      // a regex AFTER this runs and a "/* ChatGPT */" inside a note is text the
      // page renders, not a comment. Labels hold no slashes, so this can
      // neither destroy a label nor spell one.
      return value
        .split(key)
        .join(" [own engine label] ")
        .split("/*")
        .join("/ *")
        .split("*/")
        .join("* /")
        .split("//")
        .join("/ /");
    })
    .join("\n");
  return src.slice(0, start) + scanned + rest;
}

/**
 * Evaluate the sample report AND the hero's sample card under a given
 * NEXT_PUBLIC_ENGINES.
 *
 * deployedEngines() captures the inlined env expression at MODULE LOAD, so an
 * in-process test can only ever see one engine list. A child process is the
 * only way to assert the sample actually FOLLOWS the deployment rather than
 * happening to match it today — the same thing the verifier did by hand with a
 * rebuild.
 *
 * R2.10.5 widened it past mockData.js. AnswerSheet.jsx and page.js are JSX and
 * cannot be imported by bare node, so each card is covered two ways in the SAME
 * child, at the same env: `primaryEngine` is the value both chips are now
 * assigned, evaluated under this deployment, and `typed[file].literals` is
 * every engine name still TYPED into that file. A returned literal shows up in
 * the second even when the first is right, which is exactly the state both
 * cards were found in — and a literal that happens to EQUAL today's deployed
 * engine is caught by the second clause only, which is how page.js:295 would
 * have been missed by a value check alone.
 *
 * R2.10.6 widened the file list from AnswerSheet.jsx to LITERAL_SCAN_FILES.
 */
function sampleReadingUnder(engines) {
  const href = pathToFileURL(path.join(REPO, "src/data/mockData.js")).href;
  const enginesHref = pathToFileURL(path.join(REPO, "src/lib/engines/deployedEngines.js")).href;
  const code = `
    const m = await import(${JSON.stringify(href)});
    const eng = await import(${JSON.stringify(enginesHref)});
    const { readFileSync } = await import("node:fs");
    // The same comment-stripper the source guards use, shipped into the child
    // rather than re-typed, so a comment that EXPLAINS this fix cannot read as
    // the literal it removed.
    const withoutComments = ${withoutComments.toString()};
    const withoutEngineNoteDictionary = ${withoutEngineNoteDictionary.toString()};
    const allLabels = Object.values(eng.ENGINE_LABELS);
    const deployedLabels = eng.deployedEngineLabels();
    // Only page.js gets the ENGINE_NOTE cut; every other file is scanned whole.
    //
    // The cut runs FIRST, on the raw file. withoutComments is a regex and a
    // note VALUE is a string, so stripping first deletes a "/* ... */" written
    // INSIDE a note out of the scanned text while the browser still renders it
    // verbatim — proven: a value reading
    //   'An AI Overview answer/* ChatGPT: ... */ is what your buyer reads.'
    // put ChatGPT into the rail of an aio-only build with every test green.
    // The parser reads the value before any of that, and hands it back with its
    // comment openers defanged so this stripper cannot reach into it either.
    const sourceOf = (rel, abs) => {
      const raw = readFileSync(abs, "utf8");
      return rel === "src/app/page.js"
        ? withoutComments(withoutEngineNoteDictionary(raw, allLabels))
        : withoutComments(raw);
    };
    const typed = {};
    for (const [rel, abs] of ${JSON.stringify(LITERAL_SCAN_FILES)}) {
      const src = sourceOf(rel, abs);
      typed[rel] = {
        literals: allLabels.filter((l) => src.includes(l)),
        offDeployment: allLabels.filter(
          (l) => src.includes(l) && !deployedLabels.includes(l),
        ),
      };
    }
    const r = m.SAMPLE_RESULT;
    process.stdout.write(JSON.stringify({
      primaryEngine: eng.primaryDeployedEngineLabel(),
      typed,
      tracked: r.promptsTracked,
      analyzed: r.promptsAnalyzed,
      rows: r.results.length,
      topPrompts: r.topPrompts.length,
      rowEngines: [...new Set(r.results.map((x) => x.engine))],
      promptEngines: [...new Set(r.topPrompts.map((x) => x.engine))],
      engineKeys: Object.keys(r.engines),
      probeSources: r.probeSources,
      destinations: m.SAMPLE_DESTINATIONS,
      wins: r.results.filter((x) => x.visible).length,
      share: r.visibilityScore,
      refs: r.results.reduce((a, x) => a + x.aio_references.length, 0),
      ownRefs: r.results.filter((x) => x.brand_cited).length,
    }));
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", code], {
    env: { ...process.env, NEXT_PUBLIC_ENGINES: engines, ENGINES: engines },
    encoding: "utf8",
  });
  return JSON.parse(out);
}

/**
 * R2.10.1 — the landing page must not claim more than the deployment does.
 *
 * Three specific overclaims: a "Live" chip with a status LED on a hardcoded
 * script, a fictional sample answer stamped with a precise timestamp, and a
 * hero sentence naming three engines while the deployment probed two and had
 * no OPENAI_API_KEY at all.
 */

test("deployedEngines — under-claims when unset, never over-claims", () => {
  assert.deepEqual(deployedEngines({}), ["aio"], "an unconfigured deployment claims the default only");
  assert.deepEqual(deployedEngines({ ENGINES: "aio,perplexity" }), ["aio", "perplexity"]);
  assert.deepEqual(
    deployedEngines({ NEXT_PUBLIC_ENGINES: "aio,chatgpt" }),
    ["aio", "chatgpt"],
    "the client-readable mirror wins, because that is what the page can actually see"
  );
  // An unknown name must be dropped, not rendered as a label the user cannot place.
  assert.deepEqual(deployedEngines({ ENGINES: "aio,gemini-ultra-9" }), ["aio"]);
  assert.deepEqual(parseEngineList("  AIO , Perplexity "), ["aio", "perplexity"]);
});

test("formatEngineList reads as prose for one, two and three engines", () => {
  assert.equal(formatEngineList(["Google AI Overview"]), "Google AI Overview");
  assert.equal(formatEngineList(["Google AI Overview", "Perplexity"]), "Google AI Overview and Perplexity");
  assert.equal(
    formatEngineList(["Google AI Overview", "ChatGPT", "Perplexity"]),
    "Google AI Overview, ChatGPT and Perplexity"
  );
  assert.equal(formatEngineList([]), "no answer engines");
});

test("engineDriftWarning fires when the copy and the fleet disagree", () => {
  assert.equal(engineDriftWarning({ ENGINES: "aio,perplexity", NEXT_PUBLIC_ENGINES: "aio,perplexity" }), null);
  assert.equal(engineDriftWarning({ ENGINES: "aio,perplexity", NEXT_PUBLIC_ENGINES: "perplexity,aio" }), null);
  const warn = engineDriftWarning({ ENGINES: "aio", NEXT_PUBLIC_ENGINES: "aio,chatgpt" });
  assert.match(String(warn), /does not match/);
});

test("GUARD — the landing page names no engine in prose", async () => {
  const src = await read("src/app/page.js");

  // The hero sentence must be DERIVED, not typed.
  //
  // This used to assert only that the token ENGINE_SENTENCE appeared somewhere
  // and that one specific phrasing did not. That left the whole overclaim one
  // line away: replacing the assignment with
  //   const ENGINE_SENTENCE = 'Google AI Overview, ChatGPT and Perplexity';
  // put all three engines back in the rendered hero and every guard here still
  // passed. Assert the ASSIGNMENT, the way the rail guard does for DEMO_ENGINES.
  assert.match(
    src,
    /const ENGINE_SENTENCE = formatEngineList\(deployedEngineLabels\(\)\);/,
    "ENGINE_SENTENCE must be assigned from formatEngineList(deployedEngineLabels())"
  );
  assert.ok(
    !/const ENGINE_SENTENCE\s*=\s*['"`]/.test(src),
    "a typed sentence is exactly how the hero came to advertise an engine with no API key"
  );
  assert.match(src, /Perceev asks \{ENGINE_SENTENCE\}/, "and the hero must render it");
  assert.ok(
    !/asks Google AI Overview, ChatGPT and Perplexity/.test(src),
    "the hardcoded three-engine claim must not return"
  );
});

test("GUARD — no 'Live' chip on scripted content", async () => {
  const sheet = await read("src/components/landing/AnswerSheet.jsx");

  assert.ok(
    !/chip__led/.test(sheet),
    "the status LED asserts a live probe; this component types out a hardcoded script"
  );
  assert.ok(!/>\s*Live\s*</.test(sheet), "no Live label on scripted content");
  assert.match(sheet, /Sample answer/, "it must say what it is");
});

/**
 * Strip comments before asserting on rendered copy.
 *
 * Without this the guard fails on the comment that EXPLAINS the fix — the same
 * trap the CI guard in testCoverageGuard.test.mjs documents, where a comment
 * saying "no `|| true` here" reads as an escape hatch itself.
 */
function withoutComments(src) {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "") // JSX comments
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/^\s*\/\/.*$/gm, ""); // line comments
}

test("GUARD — the sample answer card is labelled, and carries no fake timestamp", async () => {
  const raw = await read("src/app/page.js");
  const src = withoutComments(raw);

  assert.ok(
    !/16 Aug 2026 · 09:14 IST/.test(src),
    "a fictional answer must not wear a real answer's provenance"
  );
  assert.match(src, /Sample · illustrative brands/, "the card must declare itself a sample");

  // The brands on that card are invented; they may stay, but only as samples.
  assert.ok(/NorthPeak/.test(src) && /Brightwave/.test(src));
});

test("GUARD — the advertised question count is the count a scan tracks", async () => {
  const src = await read("src/app/page.js");

  assert.match(src, /const TRACKED = DEFAULT_UNBRANDED_TARGET;/, "TRACKED must be derived, not typed");
  assert.ok(
    !/const TRACKED = \d+/.test(src),
    "a literal here is how the page came to advertise 36 while a scan tracked 30"
  );

  // The worker must read the same constant, or the two can drift again.
  const worker = await read("src/lib/workers/scanWorker.js");
  assert.match(worker, /import \{ DEFAULT_UNBRANDED_TARGET \}/);
  assert.ok(
    !/const DEFAULT_UNBRANDED_TARGET = \d+/.test(worker),
    "the worker must not redeclare its own copy"
  );
});

test("GUARD — the donut is the sample report's own split, not a second copy", async () => {
  const src = withoutComments(await read("src/app/page.js"));

  // The donut must account for every tracked question, or the illustration
  // contradicts the number beside it. It used to be four typed literals in
  // page.js, which is how the page reached 13/10/5/2 while the sample report
  // one click away stayed on 15/12/6/3. Now it renders the report's own array.
  assert.match(
    src,
    /const DESTINATIONS = SAMPLE_DESTINATIONS\.map/,
    "the donut must render the sample report's split, not a second copy of it"
  );
  assert.ok(
    !/answers:\s*\d+/.test(src),
    "a typed answer count on the landing page is the drift this guard exists to stop"
  );

  assert.equal(SAMPLE_DESTINATIONS.length, 4, "expected four destinations");
  const sum = SAMPLE_DESTINATIONS.reduce((a, d) => a + d.answers, 0);
  assert.equal(
    sum,
    DEFAULT_UNBRANDED_TARGET,
    `the destinations sum to ${sum}, not the ${DEFAULT_UNBRANDED_TARGET} the page advertises`
  );

  // And the split is the ROWS, not a plausible set of numbers beside them.
  const held = (key) => SAMPLE_DESTINATIONS.find((d) => d.key === key).answers;
  assert.equal(held("you"), SAMPLE_RESULT.results.filter((r) => r.visible).length);
  assert.equal(
    held("r1") + held("r2"),
    SAMPLE_RESULT.results.filter((r) => r.competitors_found_in_text.length > 0).length
  );
});

test("GUARD — the engine rail shows only deployed engines, with the report's own tallies", async () => {
  const src = await read("src/app/page.js");

  assert.match(
    src,
    /DEMO_ENGINES = DEPLOYED_ENGINE_KEYS\.map/,
    "the rail must be derived from the deployed list"
  );
  assert.match(
    src,
    /SAMPLE_RESULT\.engines\[key\]/,
    "and its asked/reached must be the sample report's rows, not a share typed beside them"
  );
  assert.ok(
    !/\{ name: 'ChatGPT', asked:/.test(src),
    "a hardcoded ChatGPT row advertises an engine this deployment does not probe"
  );
  assert.ok(
    !/reachedShare/.test(src),
    "a hardcoded reach share is a gauge with nothing behind it — it read 42% while the report it previews said 40%"
  );
});

test("GUARD — every engine label the page can render is a known engine", () => {
  for (const label of deployedEngineLabels({ ENGINES: "aio,chatgpt,perplexity" })) {
    assert.ok(Object.values(ENGINE_LABELS).includes(label), `${label} is not a known engine label`);
  }
});

/**
 * R2.10.1 (second pass) — the sample report is ONE CLICK from the hero.
 *
 * page.js "See a sample report" -> saveScan -> services/api.js sessionStorage
 * -> dashboard/page.js loadScan/isSample -> DashboardShell -> OverviewView,
 * which renders promptsTracked verbatim. The first pass moved the landing page
 * to 30 questions and two engines and left mockData.js on 36 with twelve
 * answers credited to ChatGPT, an engine with no API key on this deployment.
 * Nothing tied the two files together. These do.
 */

test("GUARD — the sample report tracks the count a scan tracks", () => {
  assert.equal(
    SAMPLE_RESULT.promptsTracked,
    DEFAULT_UNBRANDED_TARGET,
    "the report behind the hero button must not claim more questions than a scan runs"
  );
  assert.equal(SAMPLE_RESULT.promptsAnalyzed, DEFAULT_UNBRANDED_TARGET);
  assert.equal(SAMPLE_RESULT.results.length, DEFAULT_UNBRANDED_TARGET, "one row per tracked question");
  assert.equal(SAMPLE_RESULT.topPrompts.length, DEFAULT_UNBRANDED_TARGET, "and one tracked-prompt row per question");
});

test("GUARD — the sample report names no engine this deployment does not probe", () => {
  const deployed = new Set(deployedEngines());

  for (const key of Object.keys(SAMPLE_RESULT.engines)) {
    assert.ok(deployed.has(key), `engines has "${key}", which this deployment does not probe`);
  }
  for (const key of SAMPLE_RESULT.probeSources) {
    assert.ok(deployed.has(key), `probeSources has "${key}", which this deployment does not probe`);
  }
  for (const row of SAMPLE_RESULT.results) {
    assert.ok(deployed.has(row.engine), `a result row is attributed to "${row.engine}"`);
  }
  for (const row of SAMPLE_RESULT.topPrompts) {
    assert.ok(deployed.has(row.engine), `a tracked prompt is attributed to "${row.engine}"`);
  }

  // Every per-engine tally must add back up to the whole reading, or the
  // dashboard's multi-engine mode shows a total nothing sums to.
  const answered = Object.values(SAMPLE_RESULT.engines).reduce((a, e) => a + e.answered, 0);
  const visible = Object.values(SAMPLE_RESULT.engines).reduce((a, e) => a + e.visible, 0);
  assert.equal(answered, DEFAULT_UNBRANDED_TARGET);
  assert.equal(visible, SAMPLE_RESULT.results.filter((r) => r.visible).length);
});

test("GUARD — the sample report FOLLOWS the deployed engine list", () => {
  // Not "matches today" — follows. Run it under a different deployment and the
  // report has to move, the way the hero and the rail were proven to.
  const two = sampleReadingUnder("aio,perplexity");
  assert.deepEqual(two.probeSources, ["aio", "perplexity"]);
  assert.deepEqual(two.rowEngines.sort(), ["aio", "perplexity"]);
  assert.deepEqual(two.promptEngines.sort(), ["aio", "perplexity"]);
  assert.equal(two.tracked, DEFAULT_UNBRANDED_TARGET);

  const three = sampleReadingUnder("aio,chatgpt,perplexity");
  assert.deepEqual(three.probeSources, ["aio", "chatgpt", "perplexity"]);
  assert.deepEqual(three.rowEngines.sort(), ["aio", "chatgpt", "perplexity"]);
  assert.equal(three.tracked, DEFAULT_UNBRANDED_TARGET, "the count does not move with the engine list");

  const one = sampleReadingUnder("aio");
  assert.deepEqual(one.probeSources, ["aio"]);
  assert.deepEqual(one.rowEngines, ["aio"], "a single-engine deployment must not show a second engine");
  assert.equal(one.tracked, DEFAULT_UNBRANDED_TARGET);

  // The verdict itself is the same reading whatever the split.
  assert.equal(one.wins, two.wins);
  assert.equal(two.wins, three.wins);
  assert.equal(one.share, three.share);
  assert.deepEqual(one.destinations, three.destinations);

  // R2.10.5 — the hero's own answer sheet, in the same child, under the same
  // varied env. Its chip was the literal 'Perplexity': rebuilt under
  // NEXT_PUBLIC_ENGINES=aio the hero sentence and the rail both narrowed to
  // Google AI Overview and the served HTML still held exactly one Perplexity,
  // and it was this chip. A second deployment where perplexity is the ONLY
  // engine is what makes this follow rather than match — under "aio" alone a
  // typed "Google AI Overview" would still look right.
  const solo = sampleReadingUnder("perplexity");
  assert.deepEqual(solo.probeSources, ["perplexity"]);
  assert.equal(one.primaryEngine, "Google AI Overview");
  assert.equal(two.primaryEngine, "Google AI Overview");
  assert.equal(three.primaryEngine, "Google AI Overview");
  assert.equal(
    solo.primaryEngine,
    "Perplexity",
    "the sample cards' chips must move with the deployment, not merely match it today"
  );

  // Clause one, the VALUE clause: nothing typed into either file names an
  // engine outside this deployment. Clause two, the TYPED clause: nothing types
  // an engine name into either file at all. Both are needed and R2.10.5's
  // verifier proved why — a literal that equals TODAY'S deployed engine passes
  // clause one under every env, and page.js:295 was exactly that literal.
  for (const [name, reading] of [["aio", one], ["aio,perplexity", two], ["aio,chatgpt,perplexity", three], ["perplexity", solo]]) {
    for (const [file, found] of Object.entries(reading.typed)) {
      assert.deepEqual(
        found.offDeployment,
        [],
        `under ENGINES=${name} ${file} still types ${found.offDeployment.join(", ")}, `
          + "an engine this deployment does not probe"
      );
      assert.deepEqual(
        found.literals,
        [],
        `no engine name may be TYPED into ${file} at all — it happening to be `
          + "true of today's deployment is how the Perplexity chip survived R2.10.1 "
          + "and how the page.js sample chip survived R2.10.5"
      );
    }
  }

  // Both files must actually have been scanned. Object.entries of an empty
  // object iterates zero times and the loop above passes without reading a
  // thing, which is the failure mode this guard exists to prevent.
  for (const [name, reading] of [["aio", one], ["aio,perplexity", two], ["aio,chatgpt,perplexity", three], ["perplexity", solo]]) {
    assert.deepEqual(
      Object.keys(reading.typed).sort(),
      ["src/app/page.js", "src/components/landing/AnswerSheet.jsx"],
      `under ENGINES=${name} the typed-literal scan did not cover both sample cards`
    );
  }

  // And each chip must be assigned from the deployed list, not from a string
  // that happens to spell one. Assert the assignment, the way the hero
  // sentence and the rail do.
  const sheet = withoutComments(readFileSync(SHEET_PATH, "utf8"));
  assert.match(
    sheet,
    /const SHEET_ENGINE = primaryDeployedEngineLabel\(\);/,
    "SHEET_ENGINE must be assigned from primaryDeployedEngineLabel()"
  );
  assert.ok(
    !/const SHEET_ENGINE\s*=\s*['"`]/.test(sheet),
    "a typed chip is exactly how this card came to name Perplexity on an aio-only deployment"
  );
  assert.match(sheet, /className="chip">\{SHEET_ENGINE\}/, "and the chip must render it");

  // R2.10.6 — the evidence section's sample card, the second one.
  const page = withoutComments(readFileSync(PAGE_PATH, "utf8"));
  assert.match(
    page,
    /const SAMPLE_CARD_ENGINE = primaryDeployedEngineLabel\(\);/,
    "SAMPLE_CARD_ENGINE must be assigned from primaryDeployedEngineLabel()"
  );
  assert.ok(
    !/const SAMPLE_CARD_ENGINE\s*=\s*['"`]/.test(page),
    "a typed chip is how this card went on naming Google AI Overview under NEXT_PUBLIC_ENGINES=perplexity"
  );
  assert.match(
    page,
    /className="chip">\{SAMPLE_CARD_ENGINE\}/,
    "and the evidence card's chip must render it"
  );
});

/**
 * R2.10.6, third pass — the ENGINE_NOTE exemption itself, exercised directly.
 *
 * The scan above reads the page.js on disk, so it can only ever pin the
 * dictionary as it is written TODAY. This pins the EXEMPTION, against the
 * shapes a future edit can produce, and none of them are hypothetical. Two
 * shipped versions of this guard were evaded by a note VALUE that a line
 * heuristic read as a key:
 *   - a value Prettier-wrapped onto its own line beginning "ChatGPT: ...";
 *   - and, once the cut was narrowed to the key token, a TEMPLATE LITERAL whose
 *     first line ended in a comma, so its continuation line looked like the
 *     start of an entry. That one rendered "ChatGPT: and the click that never
 *     happens is what it costs you." into the engine rail of a
 *     NEXT_PUBLIC_ENGINES=aio build with all 17 tests here green.
 * So the exemption now PARSES, and refuses every shape it cannot parse. Both
 * halves are pinned below: what is scanned, and what is refused.
 *
 * Same function, same input the child process gives it: the RAW source and the
 * full label list, with comments stripped from what the parser hands back
 * rather than from what it reads.
 */
test("GUARD — the ENGINE_NOTE exemption parses the dictionary, and refuses what it cannot parse", () => {
  const labels = Object.values(ENGINE_LABELS);
  const deployedUnderAio = deployedEngineLabels({ ENGINES: "aio" });

  const RAIL = "const RAIL_NOTES = DEPLOYED_ENGINE_LABELS.map((name) => ENGINE_NOTE[name]).filter(Boolean);\n";
  const pageShaped = (entries) => `const ENGINE_NOTE = {\n${entries}\n};\n\n${RAIL}`;

  // The two clauses the child asserts, in the order the child runs them: the
  // dictionary is parsed out of the RAW source, and only then are comments
  // stripped from what is left.
  const scan = (entries) => {
    const src = withoutComments(withoutEngineNoteDictionary(pageShaped(entries), labels));
    const typed = labels.filter((l) => src.includes(l));
    return { typed, offDeployment: typed.filter((l) => !deployedUnderAio.includes(l)) };
  };
  const refuses = (entries, why) => assert.throws(() => scan(entries), /refuses to scan/, why);

  // The real file must survive the parser, or this guard is strict about a
  // shape nobody ships.
  const realPage = withoutComments(withoutEngineNoteDictionary(readFileSync(PAGE_PATH, "utf8"), labels));
  assert.deepEqual(
    labels.filter((l) => realPage.includes(l)),
    [],
    "page.js as written must parse, and leave no engine label in the scanned text"
  );

  // Today's shape: the keys are exempt, and a note may name its OWN engine in
  // its own prose. That allowance is the whole exemption, stated.
  assert.deepEqual(
    scan(
      "  'Google AI Overview': 'An AI Overview answer is the one your buyer reads.',\n"
        + "  ChatGPT: 'ChatGPT returns a single paragraph. There is no second place inside it.',\n"
        + "  Perplexity: 'Perplexity cites its sources, so a lost answer names the page that took it.',"
    ).typed,
    [],
    "an entry's own key, and its own label inside its own note, are what this exemption is for"
  );

  // THE ROUND-3 EVASION, and the nine shapes around it. A template literal
  // wrapped after a comma made its own continuation line read as an entry
  // start, because /[{,]$/ cannot tell a comma inside a string from structure.
  // A parser does not have to: none of these is a single-line quoted string, so
  // every one of them is refused by name.
  const OPEN = "`"; // written out so this test's own prose cannot be the fixture
  refuses(
    "  'Google AI Overview': " + OPEN + "An AI Overview answer is the one your buyer reads,\n"
      + "ChatGPT: and the click that never happens is what it costs you." + OPEN + ",",
    "the template wrapped after a comma is the shape that rendered ChatGPT on an aio-only build"
  );
  refuses(
    "  'Google AI Overview': " + OPEN + "An AI Overview answer is the one your buyer reads,\n"
      + "    ChatGPT: and the click that never happens." + OPEN + ",",
    "the same wrap, indented"
  );
  refuses(
    "  'Google AI Overview': " + OPEN + "An AI Overview answer is the one your buyer reads,\n"
      + "\tChatGPT: and the click that never happens." + OPEN + ",",
    "the same wrap, tab-indented"
  );
  refuses(
    "  'Google AI Overview': " + OPEN + "An AI Overview answer is the one your buyer reads,\n"
      + "  ChatGPT : and the click that never happens." + OPEN + ",",
    "a space before the colon does not make a continuation line anything else"
  );
  refuses(
    "  'Google AI Overview': " + OPEN + "An AI Overview answer is what a buyer reads {\n"
      + "  ChatGPT: and the click that never happens." + OPEN + ",",
    "nor does a brace at the end of the first line"
  );
  refuses(
    "  'Google AI Overview': " + OPEN + "An AI Overview answer is the one your buyer reads,\n"
      + "  // ChatGPT: and the click that never happens.\n"
      + "  still rendered." + OPEN + ",",
    "a comment line INSIDE a template is prose the page renders, and the template is refused"
  );
  refuses(
    "  'Google AI Overview': " + OPEN + "An AI Overview answer,\n"
      + "  /* ChatGPT: and the click that never happens. */\n"
      + "  still rendered." + OPEN + ",",
    "and so is a block comment inside a template"
  );
  refuses(
    "  'Google AI Overview': {\n    ChatGPT: 'and the click that never happens.',\n  },",
    "a nested object's key line is not an ENGINE_NOTE key line"
  );
  refuses(
    "  'Google AI Overview': fmt({\n    ChatGPT: 'and the click that never happens.',\n  }),",
    "nor is one inside a call argument"
  );
  refuses(
    "  'Google AI Overview': " + OPEN + "ChatGPT: an AI Overview answer." + OPEN + ",",
    "a single-line template is refused too: this exemption reads quoted strings only"
  );

  // WHAT IS STILL SCANNED, rather than refused. A quoted single-line value is a
  // shape the parser understands, wherever it sits, so its prose is scanned
  // whole and only the key token is dropped.
  const wrapped = scan(
    "  'Google AI Overview':\n"
      + "    'ChatGPT: an AI Overview answer is the one your buyer reads without clicking anything.',"
  );
  assert.deepEqual(
    wrapped.typed,
    ["ChatGPT"],
    "a value Prettier-wrapped onto its own line is a VALUE, and is scanned"
  );
  assert.deepEqual(
    wrapped.offDeployment,
    ["ChatGPT"],
    "and under ENGINES=aio that note RENDERS, so it must fail as an engine this deployment does not probe"
  );
  assert.deepEqual(
    scan("  'Google AI Overview': 'ChatGPT: an AI Overview answer is the one your buyer reads.',").typed,
    ["ChatGPT"],
    "the single-line form must not regress"
  );
  assert.deepEqual(
    scan("  'Google AI Overview':\n    'an AI Overview answer is not what ChatGPT would write.',").typed,
    ["ChatGPT"],
    "a label mid-sentence on a wrapped value is scanned like any other word of it"
  );
  assert.deepEqual(
    scan("  ChatGPT: 'Perplexity cites its sources, ChatGPT does not.',").typed,
    ["Perplexity"],
    "only the entry's OWN label is allowed inside its value"
  );
  assert.deepEqual(
    scan('  ChatGPT: "Perplexity cites its sources, ChatGPT does not.",').typed,
    ["Perplexity"],
    "and the quote style does not change what is scanned"
  );
  // A "comment" written INSIDE a note is prose the page renders. withoutComments
  // is a regex and used to run first, so it deleted the engine name out of the
  // scanned text while the aio-only build printed it into the rail. The parser
  // reads the raw value before the stripper can, and defangs the openers on the
  // way out so it cannot reach in afterwards.
  assert.deepEqual(
    scan(
      "  'Google AI Overview': 'An AI Overview answer/* ChatGPT: and the click that "
        + "never happens */ is what your buyer reads.',"
    ).typed,
    ["ChatGPT"],
    "a block comment inside a note VALUE renders, so it must be scanned"
  );
  assert.deepEqual(
    scan("  'Google AI Overview': 'An AI Overview answer // ChatGPT: and what it costs you.',").typed,
    ["ChatGPT"],
    "and so does a pair of slashes inside one"
  );
  assert.deepEqual(
    scan("  'Google AI Overview': 'an answer\\'s first line, and what ChatGPT costs you.',").typed,
    ["ChatGPT"],
    "an escaped quote inside a value is content, not the end of the value"
  );
  refuses(
    "  // ChatGPT: a note about the notes\n  'Google AI Overview': 'an AI Overview answer.',",
    "a REAL comment inside the declaration is read raw now, and is a shape this parser refuses"
  );
  // Two entries on one line is STRUCTURE, not a guess: the parser reads two
  // keys and two values, both keys are real ENGINE_NOTE keys, and both are
  // reached only through the DEPLOYED_ENGINE_LABELS filter.
  assert.deepEqual(
    scan("  'Google AI Overview': 'one', ChatGPT: 'two',").typed,
    [],
    "a second entry on the same line is an entry, and its key is exempt like any other"
  );
  assert.deepEqual(
    scan("  'Google AI Overview': 'one', ChatGPT: 'two names Perplexity',").typed,
    ["Perplexity"],
    "while its VALUE is scanned like any other"
  );

  // Shapes that are not one quoted string, or not an entry at all: refused,
  // where the previous versions scanned them and happened to catch them.
  refuses(
    "  'Google AI Overview': 'an AI Overview answer '\n    + 'ChatGPT: and what it costs you '\n    + 'in clicks.',",
    "a concatenated value is not one quoted string"
  );
  refuses(
    "  'Google AI Overview': ['an AI Overview answer',\n    'ChatGPT: and what it costs you'],",
    "nor is an array of them"
  );
  refuses(
    "  'Google AI Overview': 'an AI Overview answer', // ChatGPT: and what it costs you\n  Perplexity: 'x',",
    "nor is a trailing comment on a key line, which withoutComments never removed either"
  );
  refuses(
    "  'Google AI Overview': 'an AI Overview answer \\\n  ChatGPT: and what it costs you',",
    "a backslash-continued value spans two lines"
  );

  // And the shape guards throw rather than exempting what they cannot reason
  // about. Each of these is a way the dictionary could stop being the safe
  // thing this exemption assumes it is.
  assert.throws(
    () => withoutEngineNoteDictionary("const SOMETHING_ELSE = {};\n", labels),
    /no longer declares ENGINE_NOTE/,
    "a moved or renamed dictionary must stop the guard, not silently widen it"
  );
  assert.throws(
    () => withoutEngineNoteDictionary(pageShaped("  ChatGPT: 'a',").replace(RAIL, "const RAIL_NOTES = Object.values(ENGINE_NOTE);\n"), labels),
    /filters it down to the deployed engines/,
    "without the DEPLOYED_ENGINE_LABELS filter the exemption hides a renderable literal"
  );
  assert.throws(
    () => withoutEngineNoteDictionary(pageShaped("  ChatGPT: 'a',"), []),
    /needs the label list to scope itself/
  );
  assert.throws(
    () => withoutEngineNoteDictionary(pageShaped(""), labels),
    /read zero entries/,
    "an emptied dictionary is a scan that covered nothing, and must say so"
  );
  assert.throws(
    () => withoutEngineNoteDictionary(pageShaped("  Gemini: 'a note for an engine this file does not know',"), labels),
    /not a known engine label/,
    "a key that is not a label is either dead or a hiding place"
  );
  assert.throws(
    () => withoutEngineNoteDictionary(`const ENGINE_NOTE = {\n  ChatGPT: 'a',\n}\n\n${RAIL}`, labels),
    /does not end at a semicolon/,
    "the declaration must end where this parser thinks it ends"
  );
  assert.throws(
    () => withoutEngineNoteDictionary(pageShaped("  ChatGPT: 'a',"), ["ChatGPT", "GPT"]),
    /overlap/,
    "the own-label allowance is a text replacement, and must refuse labels that could overlap"
  );
});

test("GUARD — the sample report backs the '64 pages, six of them yours' claim", () => {
  const refs = SAMPLE_RESULT.results.reduce((a, r) => a + r.aio_references.length, 0);
  const mine = SAMPLE_RESULT.results.filter((r) => r.brand_cited).length;

  // page.js states these as words ("The 64 pages...", "The other fifty-eight")
  // and hands them to SourcesViz as literals. They are only true because the
  // data below produces them; if it stops, this fails instead of the copy
  // quietly becoming fiction.
  assert.equal(refs, 64, "the sample must actually cite 64 sources");
  assert.equal(mine, 6, "six of them must actually be pages the brand controls");

  const src = withoutComments(readFileSync(path.join(REPO, "src/app/page.js"), "utf8"));
  assert.match(src, /SourcesViz total=\{64\} mine=\{6\}/, "the slide must quote those same two numbers");
});

test("GUARD — the scan page's sample panel is read off the sample report", async () => {
  const src = withoutComments(await read("src/app/scan/page.js"));

  // Scoped to the panel, because a CSS width of '100%' elsewhere on the page is
  // not a claim about anything.
  const start = src.indexOf("const SAMPLE_FACTS");
  assert.ok(start >= 0, "the scan page must still declare SAMPLE_FACTS");
  const block = src.slice(start, src.indexOf("export default function Scan"));

  // It used to type '41%' and '15 / 36' beside a button that opens a report
  // now reading 43% and 13 / 30.
  assert.ok(!/'\d+%'/.test(block), "a typed share of AI cannot follow the report this panel previews");
  assert.ok(!/\d+ \/ \d+/.test(block), "nor a typed 'n / total'");
  assert.match(block, /SAMPLE_RESULT\.visibilityScore/);
  assert.match(block, /SAMPLE_RESULT\.promptsTracked/);
  assert.match(block, /SAMPLE_RESULT\.competitorsFound/);
});

test("GUARD — engineDriftWarning runs in production, not only here", async () => {
  // It was written for a real failure and documented in .env.example as though
  // it ran on deploy, but the ONLY caller anywhere was this file. A guard that
  // exists solely inside its own test is the same shape of claim as a Live chip
  // on a script.
  const script = await read("scripts/check-secrets.mjs");
  assert.match(
    script,
    /engineDriftWarning\(process\.env\)/,
    "check:secrets must actually call it, on the real environment"
  );
  assert.match(
    script,
    /engine advertising — what the landing page names vs what the fleet can probe/,
    "and report it under its own heading, so it is never silent"
  );
  assert.match(
    script,
    /failures\.length \|\| !engines\.ok \? 1 : 0/,
    "a mismatch must move the exit code — a warning nobody reads is what this replaces"
  );

  // The same check closes the isConfigured() gap deployedEngines() cannot see:
  // an advertised engine with no key is an engine every scan skips.
  assert.match(script, /OPENAI_API_KEY/, "the advertised-vs-funded check must know chatgpt's key");
  assert.match(script, /PERPLEXITY_API_KEY/, "and perplexity's");

  // And the operator-facing comment must name the thing that actually runs.
  const envExample = await read(".env.example");
  assert.match(
    envExample,
    /check:secrets/,
    ".env.example must point operators at the check that exists, not at a function nothing calls"
  );
});
