import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

import {
  ENGINE_LABELS,
  deployedEngines,
  deployedEngineLabels,
  formatEngineList,
  parseEngineList,
  engineDriftWarning,
  primaryDeployedEngineLabel,
} from "./engines/deployedEngines.js";
import { DEFAULT_UNBRANDED_TARGET } from "./scoring/promptSetSize.js";
import { SAMPLE_DESTINATIONS, SAMPLE_RESULT } from "../data/mockData.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const read = (rel) => readFile(path.join(REPO, rel), "utf8");

const SHEET_REL = "src/components/landing/AnswerSheet.jsx";
const PAGE_REL = "src/app/page.js";
const SHEET_PATH = path.join(REPO, SHEET_REL);
const PAGE_PATH = path.join(REPO, PAGE_REL);

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
      // defang the two comment openers, because the caller strips comments
      // AFTER this runs and a "/* ChatGPT */" inside a note is text the page
      // renders, not a comment. Labels hold no slashes, so this can neither
      // destroy a label nor spell one.
      //
      // R6.4.9 — and defang the QUOTES for the same reason, one layer down.
      // What this function returns is no longer source code: it is note prose
      // spliced into the middle of a file. withoutComments is now a lexer that
      // refuses text it cannot place, so a lone apostrophe in a note ("an
      // answer's first line") would read as a string that never closes and
      // stop the whole scan on honest input. Replaced with a space, never
      // deleted, so this can never splice two words into a label nobody wrote —
      // and no engine label contains a quote, so no label can be destroyed.
      return value
        .split(key)
        .join(" [own engine label] ")
        .split("/*")
        .join("/ *")
        .split("*/")
        .join("* /")
        .split("//")
        .join("/ /")
        .split("'")
        .join(" ")
        .split('"')
        .join(" ")
        .split("`")
        .join(" ");
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
    const renderableText = ${renderableText.toString()};
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
    //
    // R6.4.9 — and the last step decodes escape spellings, because every clause
    // below asks includes() and '\\x43hatGPT' renders ChatGPT to a reader while
    // spelling nothing to a substring search.
    const sourceOf = (rel, abs) => {
      const raw = readFileSync(abs, "utf8");
      return renderableText(
        rel === "src/app/page.js"
          ? withoutComments(withoutEngineNoteDictionary(raw, allLabels))
          : withoutComments(raw),
      );
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
  /**
   * R6.4.9, the escape clause, applied here. The negative clause at the bottom
   * of this test is a TOKEN check, and a token can be written '\x43hatGPT' or
   * '&#67;hatGPT' and still reach the reader as the name. So it reads the
   * DECODED text as well as the raw bytes.
   *
   * The SHAPE clauses stay on the raw source deliberately: `const X = '` is
   * structure, decoding is not structure-preserving, and no escape spelling can
   * evade a shape clause anyway — a typed literal is a typed literal however
   * its characters are written.
   */
  const rendered = renderableText(src);

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
    !/asks Google AI Overview, ChatGPT and Perplexity/.test(rendered),
    "the hardcoded three-engine claim must not return, in any spelling that renders as it"
  );
});

test("GUARD — no 'Live' chip on scripted content", async () => {
  // R6.4.9, the escape clause: every assertion here is a token check, and
  // "Li&#118;e" renders Live. Read what the reader sees, not the bytes.
  const sheet = renderableText(await read("src/components/landing/AnswerSheet.jsx"));

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
 *
 * R6.4.9 — IT LEXES. It used to be three regexes:
 *
 *     .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")   // JSX comments
 *     .replace(/\/\*[\s\S]*?\*\//g, "")       // block comments
 *     .replace(/^\s*\/\/.*$/gm, "")           // line comments
 *
 * A regex has no idea which quote it is inside, and a comment sequence typed
 * INSIDE a string or a template is not a comment at all: it is prose the browser
 * renders verbatim. So the second regex deleted renderable text out of the
 * scanned copy while the built page went on showing it. R2.10.6 found this for
 * page.js's ENGINE_NOTE and closed it there, by parsing that one declaration out
 * of the RAW file before the stripper could reach into it. Every other guarded
 * file kept the hole, and it was still live: adding
 *
 *     { t: ' is cited more often/* ChatGPT: ... star-slash, particularly by ...' },
 *
 * to AnswerSheet.jsx's SHEET array put ChatGPT into the rendered sheet — proven
 * by a react-dom/server render of the component in its reduced-motion state,
 * which is the state a reduced-motion visitor sees — with all 17 tests in this
 * file green.
 *
 * The second regex was worse than it looks. `[\s\S]*?` is lazy but unanchored,
 * so a lone "/*" inside a string ran forward to the NEXT "star-slash" anywhere in the
 * file — the close of some real comment fifty lines down — and deleted every
 * line between them. A guard that silently skips a span is worse than no guard,
 * because it certifies what it never read. The canary test below injects an
 * engine name on every line of every guarded file precisely to catch that.
 *
 * WHAT THIS DOES INSTEAD. One pass, one character at a time, always knowing
 * which quote it is inside:
 *   - a ' or " span is copied out verbatim, escapes and all;
 *   - a template literal is copied verbatim, and its ${...} holes are code
 *     again, tracked on a stack so nesting is exact;
 *   - // and /* are comments ONLY in code position, and are replaced by a space
 *     plus their own newlines, so nothing splices and every later line number
 *     still means what it says.
 *
 * IT REFUSES RATHER THAN GUESSES. A quote that runs past the end of its line, a
 * quote that never closes, a block comment that never closes, a template or a
 * ${...} that never closes: each throws, naming the line. That is the same fix
 * landingProbeCounter.test.mjs needed after its round-one scanner let an
 * apostrophe pair in JSX prose swallow a live Math.random() — a scanner that
 * loses its place must say so.
 *
 * THE QUOTE-PHASE RULE, added in R6.4.9's second round, and the reason it
 * exists. The first round shipped the lexer above and documented two "blind
 * spots". The first was real and stayed open. The SECOND was described as safe
 * and was not: it was an exploitable hole, and the verifier walked through it.
 *
 * The mechanism. JSX text is code position to this lexer (blind spot 1 below),
 * so an apostrophe in JSX PROSE is read as a string delimiter. It does not just
 * over-scan the prose — it SHIFTS QUOTE PAIRING FOR THE REST OF THE LINE, so a
 * REAL string literal later on the same line lands in what the lexer believes is
 * code, and a comment run inside that real string is stripped. The executed
 * payload, one line of AnswerSheet.jsx:
 *
 *     <span className="chip">Brightwave's mention</span>
 *     <span className="chip">{' cited SLASH-STAR Perplexity STAR-SLASH first'}</span>
 *     <span className="chip">NorthPeak's pick</span>
 *
 * all on one line. The lexer pairs the apostrophe in "Brightwave's" with the one
 * that OPENS the real string, so the real string's contents read as code and its
 * comment run is deleted; the apostrophe in "NorthPeak's" pairs with the one that
 * CLOSED it, so the line ends in code and nothing refuses. React writes the
 * string out character for character, so "Perplexity" reached the DOM with all
 * 24 tests in this file green. The same vehicle on one line of page.js hid
 * ChatGPT. Both are pinned below as regression cases, with their plain-spelling
 * controls.
 *
 * THE FIX, and why this one rather than a refusal. A comment run is stripped
 * only if it is stripped under EVERY quote phase of its line. Concretely: if the
 * same quote character occurs both BEFORE the opener and AFTER it on the opener's
 * own line, then some pairing of those two quotes puts the opener INSIDE a string,
 * so the run is kept verbatim instead of deleted. That is sound in the only
 * direction that matters — it can never delete text the browser renders — and it
 * is cheap: no JSX parser, one line of context, no guess about which reading is
 * true. Where it is wrong it KEEPS a real comment, which makes the scan read a
 * comment and fail loudly, never read clean over prose.
 *
 * The alternative the verifier offered was to REFUSE an ambiguous line by name.
 * Rejected, because the ambiguity test cannot tell the payload from
 * `const a = 'x'; // note`, and every file this suite strips is full of that
 * shape — a refusal would fire on ordinary source, be allowlisted within a day,
 * and end up meaning nothing. Refusal is right when the lexer has LOST its place;
 * here it still has a place, it just has two, and keeping the text is the answer
 * that covers both.
 *
 * Backticks are deliberately NOT part of this test. A template spans lines and is
 * tracked on the stack above, and a pair of backticks straddling a comment on one
 * line is the ordinary `${x SLASH-STAR c STAR-SLASH}` hole, which must keep being
 * stripped. A stray backtick in JSX prose runs into "a template that never
 * closes" instead, which is a refusal — the loud direction.
 *
 * KNOWN BLIND SPOTS, stated rather than papered over:
 *   1. JSX TEXT is read as CODE position. `<p>answer/* ChatGPT star-slash reads</p>`
 *      is prose React renders, and with no quote character anywhere on the line
 *      the rule above has nothing to catch, so the sequence is still stripped.
 *      This class is OPEN. Closing it needs a real JSX parser.
 *
 *      THE CANARY DOES NOT CATCH IT, and R6.4.9's first round claimed it did.
 *      That claim was false and this is the correction: the canary appends its
 *      token at the END of a line, AFTER the star-slash, where the token survives
 *      stripping — so the line reads as loud while the run between the markers is
 *      gone. What the canary does catch is a span the stripper SKIPS (the lazy
 *      regex swallow) and a token written inside the first quoted span of a
 *      MUST_READ line. What covers the JSX-text class instead is the render
 *      baseline in "PROOF — no surface renders an engine label its deployment
 *      does not probe, under any config": both guarded surfaces are compiled and
 *      rendered under a list of deployment configs, and every label in
 *      ENGINE_LABELS that a config does not deploy is asserted ABSENT from the
 *      markup, raw and decoded. That test also asserts that every known label is
 *      off-deployment under at least one config in the list, so the sentence
 *      above cannot quietly become false by a label being added. A name hidden in
 *      JSX text is still a name in the DOM, so it fails there even while the
 *      source scan is blind to it — that is checked, not hoped for: splicing a
 *      bare "SLASH-STAR Perplexity STAR-SLASH" into the sheet's JSX text fails
 *      that test ALONE, with all 24 others green. Neither guarded file writes a
 *      bare comment opener into JSX text today.
 *   2. A REGEX LITERAL containing a quote (/don't/) would be read as opening a
 *      string. Neither guarded file has one; if one appears, the refusals above
 *      fire rather than the scan quietly narrowing.
 *   3. includes() cannot see a COMPUTED spelling (String.fromCharCode(67) +
 *      'hatGPT'). Escape spellings are handled — see renderableText below — but
 *      arithmetic is not, and no source scan in this repo can be.
 */
function withoutComments(src) {
  const lineOf = (at) => src.slice(0, at).split("\n").length;
  const lose = (at, what) => {
    throw new Error(
      "landingHonesty: the comment stripper lost track of the source at line "
        + lineOf(at) + " — " + what + ". A stripper that guesses deletes text the "
        + "browser renders: that is how an engine name reached the served HTML with "
        + "every guard in this file green. Refuse rather than half-read."
    );
  };
  let out = "";
  let i = 0;
  const n = src.length;
  /**
   * The quote-phase test, documented at length above. Returns the quote
   * character that makes the phase at `at` ambiguous, or null when every phase
   * of this line agrees that `at` is in code.
   *
   * Sound direction: a quote that appears only BEFORE the opener can either pair
   * off before it or run past the end of its line, and a single-quoted or
   * double-quoted span that runs past its line is not a phase JavaScript allows
   * (the lexer above refuses one). So "before only" leaves the opener in code
   * under every admissible reading. "Before AND after" does not.
   *
   * Escapes are ignored on purpose: counting a \' as a delimiter can only ADD
   * ambiguity, which can only keep more text, which is the safe direction.
   */
  const ambiguousPhaseAt = (at) => {
    const from = at === 0 ? 0 : src.lastIndexOf("\n", at - 1) + 1;
    let to = src.indexOf("\n", at);
    if (to < 0) to = n;
    const before = src.slice(from, at);
    const after = src.slice(at + 2, to);
    for (const q of ["'", '"']) {
      if (before.includes(q) && after.includes(q)) return q;
    }
    return null;
  };
  // Mode stack. A `code` frame counts its own braces so a ${...} hole knows
  // where it ends; a template frame copies text until its own backtick.
  const stack = [{ code: true, depth: 0 }];
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i];
    if (!top.code) {
      if (c === "\\") {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        out += c;
        i += 1;
        stack.pop();
        continue;
      }
      if (c === "$" && src[i + 1] === "{") {
        out += "${";
        i += 2;
        stack.push({ code: true, depth: 0 });
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      const at = i;
      out += c;
      i += 1;
      while (i < n && src[i] !== q) {
        if (src[i] === "\n") {
          lose(at, "a " + q + " opens a span that runs past the end of its line");
        }
        if (src[i] === "\\") {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += src[i];
        i += 1;
      }
      if (i >= n) lose(at, "a quote that never closes");
      out += q;
      i += 1;
      continue;
    }
    if (c === "`") {
      out += c;
      i += 1;
      stack.push({ code: false });
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      let to = src.indexOf("\n", i);
      if (to < 0) to = n;
      // Ambiguous phase: this may not be a comment at all. Copy it out verbatim
      // rather than lexing it, so a quote inside it cannot open a span that then
      // "runs past the end of its line" and refuses honest source.
      if (ambiguousPhaseAt(i)) out += src.slice(i, to);
      i = to;
      continue; // the newline itself is kept, so line numbers survive
    }
    if (c === "/" && src[i + 1] === "*") {
      const at = i;
      const end = src.indexOf("*/", i + 2);
      if (end < 0) lose(at, "a block comment that never closes");
      if (ambiguousPhaseAt(at)) {
        out += src.slice(at, end + 2);
        i = end + 2;
        continue;
      }
      // A space so nothing splices, then the comment's own newlines, so every
      // line number in every later message still means what it says.
      out += " " + src.slice(i, end).replace(/[^\n]/g, "");
      i = end + 2;
      continue;
    }
    if (c === "{") {
      top.depth += 1;
      out += c;
      i += 1;
      continue;
    }
    if (c === "}") {
      if (top.depth === 0 && stack.length > 1) {
        out += c;
        i += 1;
        stack.pop();
        continue;
      }
      if (top.depth > 0) top.depth -= 1;
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  if (stack.length !== 1) {
    lose(Math.max(0, n - 1), "a template literal or a ${...} hole that never closes");
  }
  return out;
}

/**
 * The stripper this file shipped until R6.4.9, kept as a COUNTER-EXAMPLE oracle
 * and used to decide nothing about the app.
 *
 * Its job here is to be wrong in a known direction: it has no idea which quote
 * it is inside, so it deletes more than a comment. Several assertions below
 * lean on that. The fixture and render proofs require this one to MISS each
 * committed payload, so a payload that stops being an evasion stops passing as
 * one; and the stripper test requires it to lose every line the shipping lexer
 * keeps.
 */
const NAIVE_STRIPPER = (src) => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

/**
 * R6.4.9, second half — the escape clause.
 *
 * Every source guard in this file, and every sibling that scans source text,
 * asks `src.includes('ChatGPT')`. JavaScript and JSX both spell that name
 * several other ways, all of which the browser renders identically and none of
 * which includes() can see:
 *
 *     '\x43hatGPT'          'ChatGPT'        '\u{43}hatGPT'
 *     <p>&#67;hatGPT</p>    <p>&#x43;hatGPT</p>   Google&nbsp;AI Overview
 *
 * So the scan decodes them first. This runs on ALREADY-STRIPPED text and its
 * output feeds includes() only — it is never asserted against for structure, so
 * decoding cannot break a shape check. It can only ever ADD text, which means
 * its failure direction is a false FAILURE on honest code, not a false green.
 *
 * The non-breaking space clause is here for the same reason: a "Google AI
 * Overview" whose spaces are U+00A0 reads as the label to every visitor and to
 * no includes().
 *
 * WHERE IT IS APPLIED, so the next reader does not have to grep for it. Every
 * clause in this file that asks whether a NAME or a CLAIM is present now reads
 * decoded text:
 *   - sourceOf() in the child scan, which is the typed-literal clause over both
 *     guarded files;
 *   - the ENGINE_NOTE exemption test's scan();
 *   - the committed-fixture test and the canary;
 *   - the four regex token clauses above: the three-engine hero sentence, the
 *     Live chip, the fictional timestamp, and the hardcoded ChatGPT rail row.
 *
 * WHERE IT IS DELIBERATELY NOT APPLIED: the SHAPE clauses — `const X = '`,
 * `= formatEngineList(...)`, `DEMO_ENGINES = DEPLOYED_ENGINE_KEYS.map`. Those
 * assert structure, decoding is not structure-preserving, and an escape
 * spelling cannot evade them in the first place: a typed literal is still a
 * typed literal whatever its characters are written as.
 *
 * NOT COVERED, and no source scan can cover it: a spelling computed at runtime,
 * e.g. String.fromCharCode(67) + 'hatGPT', or a name assembled from a fetched
 * value. The guards in this file are source guards and that is their edge; the
 * value clause in the sample-report guard is what covers the runtime side.
 */
function renderableText(src) {
  const chr = (code) => {
    try {
      return String.fromCodePoint(code);
    } catch {
      return " "; // an unspellable escape becomes a character that joins nothing
    }
  };
  return src
    .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_m, h) => chr(parseInt(h, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => chr(parseInt(h, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, h) => chr(parseInt(h, 16)))
    .replace(/&#x([0-9a-fA-F]{1,6});/g, (_m, h) => chr(parseInt(h, 16)))
    .replace(/&#(\d{1,7});/g, (_m, d) => chr(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/[\u00a0\u2007\u202f]/g, " ");
}

test("GUARD — the sample answer card is labelled, and carries no fake timestamp", async () => {
  const raw = await read("src/app/page.js");
  // R6.4.9, the escape clause: a timestamp spelled with an escaped digit reads
  // the same on the page and matches nothing here. Decode before asserting.
  const src = renderableText(withoutComments(raw));

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
  // R6.4.9, the escape clause: the engine name in this row can be spelled
  // '\x43hatGPT' and render identically, so the token half reads decoded text.
  // The typed-literal clause in the child scan (sourceOf -> renderableText) is
  // the wider net; this one names the exact shape that shipped.
  assert.ok(
    !/\{ name: 'ChatGPT', asked:/.test(renderableText(src)),
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
    const src = renderableText(withoutComments(withoutEngineNoteDictionary(pageShaped(entries), labels)));
    const typed = labels.filter((l) => src.includes(l));
    return { typed, offDeployment: typed.filter((l) => !deployedUnderAio.includes(l)) };
  };
  const refuses = (entries, why) => assert.throws(() => scan(entries), /refuses to scan/, why);

  // The real file must survive the parser, or this guard is strict about a
  // shape nobody ships.
  const realPage = renderableText(
    withoutComments(withoutEngineNoteDictionary(readFileSync(PAGE_PATH, "utf8"), labels)),
  );
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
  assert.match(script, /LLM_API_KEY/, "the advertised-vs-funded check must know the shared model gateway key");
  assert.match(script, /isOpenRouterEngineConfigured/, "and validate each engine against the configured OpenRouter model");

  // And the operator-facing comment must name the thing that actually runs.
  const envExample = await read(".env.example");
  assert.match(
    envExample,
    /check:secrets/,
    ".env.example must point operators at the check that exists, not at a function nothing calls"
  );
});

/**
 * R6.4.9, finding C11 — the comment stripper itself, exercised directly.
 *
 * The scan above reads the two files on disk, so it can only pin what is
 * written there TODAY. This pins the TOOL, against the shapes an edit can
 * produce, and none of them are hypothetical:
 *
 *   - R2.10.6 proved a slash-star run inside a page.js ENGINE_NOTE value put
 *     ChatGPT into the engine rail of an aio-only build with every test green,
 *     and closed it for that ONE declaration by parsing it out of the raw file.
 *   - R6.4.9 proved the same move still worked everywhere else. Adding
 *     " is cited more often SLASH-STAR ChatGPT: ... STAR-SLASH, particularly
 *     by..." to AnswerSheet.jsx's SHEET array rendered ChatGPT into the sheet —
 *     confirmed by a react-dom/server render of the component in the state a
 *     reduced-motion visitor sees — with all 17 tests in this file green.
 *
 * Every literal below is built by concatenation rather than typed, for the
 * reason the ENGINE_NOTE test gives for its own backtick: a test whose prose
 * IS the fixture cannot be read, and cannot be edited safely either.
 */
test("GUARD — the comment stripper deletes comments, and nothing else", () => {
  const OPEN = "/" + "*";
  const CLOSE = "*" + "/";
  const TICK = String.fromCharCode(96);
  const AP = String.fromCharCode(39);
  const DQ = String.fromCharCode(34);
  const SPAN = "<span className=" + DQ;

  // --- a real comment still goes ---
  assert.ok(
    !withoutComments("const a = 1; // ChatGPT is not deployed here\n").includes("ChatGPT"),
    "a line comment is a comment"
  );
  assert.ok(
    !withoutComments(OPEN + " ChatGPT is not deployed here " + CLOSE + "\nconst a = 1;\n").includes("ChatGPT"),
    "and so is a block comment"
  );
  assert.ok(
    !withoutComments("<p>{" + OPEN + " ChatGPT " + CLOSE + "}</p>\n").includes("ChatGPT"),
    "and so is a JSX comment"
  );
  assert.ok(
    !withoutComments("const Chat" + OPEN + "x" + CLOSE + "GPT = 1;\n").includes("ChatGPT"),
    "a stripped comment leaves a space behind, so it can never splice two words "
      + "into a label nobody wrote"
  );

  // --- and prose that only LOOKS like a comment stays ---
  //
  // Each of these is checked twice: the shipping stripper must KEEP the name,
  // and the stripper it replaced must LOSE it. The second half is what makes
  // each one an evasion rather than a decoration.
  const evasions = [
    [
      "const t = 'An AI Overview answer" + OPEN + " ChatGPT: and the click that never "
        + "happens " + CLOSE + " is what your buyer reads.';\n",
      "a block comment inside a single-quoted string is prose the browser renders",
    ],
    [
      'const t = "An AI Overview answer' + OPEN + " ChatGPT: and the click " + CLOSE + ' reads.";\n',
      "and the quote style does not change that",
    ],
    [
      "const t = " + TICK + "An AI Overview answer\n" + OPEN + " ChatGPT: and the click "
        + CLOSE + "\nis what your buyer reads." + TICK + ";\n",
      "nor does a template literal spanning three lines",
    ],
    [
      "const t = " + TICK + "An AI Overview answer\n// ChatGPT: and what it costs you\n"
        + "is what your buyer reads." + TICK + ";\n",
      "a line whose first characters are slashes, inside a template, is still prose",
    ],
    [
      "const t = " + TICK + "answer ${label} " + OPEN + " ChatGPT " + CLOSE + TICK + ";\n",
      "text after a ${...} hole is back inside the template, and still renders",
    ],
    [
      "const t = 'answer'; // ok\nconst u = 'and " + OPEN + " ChatGPT " + CLOSE + " reads';\n",
      "a real comment on one line does not license reaching into the string on the next",
    ],
    /**
     * R6.4.9 ROUND TWO — THE QUOTE-PHASE SHIFT, the two payloads that beat the
     * first round of this fix at 24/24 green. Both are one line, because the
     * phase shift is a per-line effect.
     *
     * The apostrophe in "Brightwave's" is JSX prose, not a delimiter, but this
     * lexer has no JSX parser. It pairs that apostrophe with the one that OPENS
     * the real string in the next chip, which leaves the real string's contents
     * in code position where the comment run is deleted; the apostrophe in
     * "NorthPeak's" pairs with the one that closed it, so the line ends in code
     * and nothing refuses. React writes the string out character for character.
     *
     * The end-to-end versions of these two — spliced into the real files,
     * rendered through react-dom/server, with their plain-spelling controls —
     * are in the PROOF test near the bottom of this file.
     */
    [
      "        " + SPAN + "chip chip--you" + DQ + ">Brightwave" + AP + "s mention</span>"
        + SPAN + "chip" + DQ + ">{" + AP + " cited " + OPEN + " ChatGPT " + CLOSE + " first"
        + AP + "}</span>" + SPAN + "chip" + DQ + ">NorthPeak" + AP + "s pick</span>\n",
      "an apostrophe in JSX prose shifts quote pairing for the rest of the line, so "
        + "a real string later on it must not be read as code — AnswerSheet.jsx",
    ],
    [
      "        " + SPAN + "chip chip--warn" + DQ + " style={{ marginLeft: " + AP + "auto"
        + AP + " }}>Brightwave" + AP + "s first</span>" + SPAN + "chip" + DQ + ">{" + AP
        + " cited " + OPEN + " ChatGPT " + CLOSE + " first" + AP + "}</span>" + SPAN
        + "chip" + DQ + ">NorthPeak" + AP + "s pick</span>\n",
      "and a style prop's own quoted value does not re-sync the phase — page.js",
    ],
  ];
  for (const [src, why] of evasions) {
    assert.ok(withoutComments(src).includes("ChatGPT"), why);
    assert.ok(
      !NAIVE_STRIPPER(src).includes("ChatGPT"),
      "the fixture must still evade the stripper it was written against, or it "
        + "has stopped testing anything: " + why
    );
    // The control: the same text with ONLY the comment markers taken out —
    // block markers where there are any, the slashes otherwise. Both strippers
    // must see it. A payload whose control is also invisible is not isolating the
    // comment run, it is testing something else.
    const noBlock = src.split(OPEN).join("").split(CLOSE).join("");
    const control = noBlock === src ? src.split("//").join("") : noBlock;
    assert.notEqual(control, src, "the control is the payload: " + why);
    assert.ok(withoutComments(control).includes("ChatGPT"), "control, current: " + why);
    assert.ok(NAIVE_STRIPPER(control).includes("ChatGPT"), "control, old stripper: " + why);
  }

  /**
   * THE OTHER SIDE OF THE PHASE RULE. It keeps a comment run whenever the same
   * quote character sits both before and after the opener on the opener's line,
   * so it has to be shown NOT firing on the ordinary shapes, or this file's own
   * doctrine — a comment that explains a fix must not read as the thing it
   * removed — quietly stops holding.
   */
  const stillStripped = [
    ["const a = 'answer'; // ChatGPT is not deployed\n", "a quoted value before a line comment, and no quote after it"],
    ["const a = 'answer'; " + OPEN + " ChatGPT " + CLOSE + "\n", "the same with a block comment"],
    ["<p>{" + OPEN + " ChatGPT " + CLOSE + "}</p>\n", "a JSX comment with no quote on the line"],
    ["const a = 'x';\n" + OPEN + " ChatGPT " + CLOSE + "\n", "a quote on the PREVIOUS line changes nothing"],
    [
      "const t = " + TICK + "answer ${x " + OPEN + " ChatGPT " + CLOSE + "} reads" + TICK + ";\n",
      "backticks are not part of the phase test, so a ${...} hole still strips",
    ],
  ];
  for (const [src, why] of stillStripped) {
    assert.ok(
      !withoutComments(src).includes("ChatGPT"),
      "the phase rule must not keep a real comment here: " + why
    );
  }

  // And the documented over-scan, asserted rather than hoped for: a real comment
  // BETWEEN two quoted spans on one line is kept, because some pairing of those
  // quotes puts it inside a string. That direction reads a comment and fails
  // loudly; it never reads clean over prose.
  assert.ok(
    withoutComments("const a = 'x'; " + OPEN + " ChatGPT " + CLOSE + " const b = 'y';\n").includes("ChatGPT"),
    "a comment straddled by quotes on one line is KEPT — the stated cost of the "
      + "phase rule. If this stops being true the rule has been narrowed, and the "
      + "payloads above are the thing to re-run."
  );

  // A comment inside a ${...} hole IS a comment: the hole is code again. This
  // is what proves the template handling tracks nesting rather than treating
  // everything after a backtick as verbatim.
  assert.ok(
    !withoutComments("const t = " + TICK + "answer ${x " + OPEN + " ChatGPT " + CLOSE + "} reads" + TICK + ";\n")
      .includes("ChatGPT"),
    "a ${...} hole is code, so a comment inside one is a comment"
  );

  // THE SPAN SWALLOW. The old block-comment regex was lazy but unanchored, so a
  // lone opener inside a string ran forward to the next closer ANYWHERE in the
  // file and deleted every line between them. A guard that skips a span is
  // worse than no guard: it certifies what it never read.
  const swallow = [
    "const opener = 'an AI Overview answer " + OPEN + " written inside a string';",
    "const CHIP = 'ChatGPT';",
    OPEN + " a real comment, and the closer the lazy regex used to run to " + CLOSE,
    "",
  ].join("\n");
  assert.ok(
    withoutComments(swallow).includes("ChatGPT"),
    "the line between a string's slash-star and a later real comment must survive"
  );
  assert.ok(
    !NAIVE_STRIPPER(swallow).includes("ChatGPT"),
    "and the old regex must still lose it, or this fixture has stopped being the bug"
  );

  // Line numbers survive, so every message this file prints still means what it
  // says. A stripper that collapses lines makes its own failures unreadable.
  const multiline = OPEN + "\n a\n b\n" + CLOSE + "\nconst a = 1;\n";
  assert.equal(
    withoutComments(multiline).split("\n").length,
    multiline.split("\n").length,
    "stripping must not renumber the file"
  );
});

test("GUARD — the comment stripper refuses source it cannot place, rather than half-reading it", () => {
  const OPEN = "/" + "*";
  const TICK = String.fromCharCode(96);

  const refusals = [
    ["const a = 'unclosed;\nconst b = 2;\n", "a quote that runs past the end of its line"],
    ['const a = "unclosed;\nconst b = 2;\n', "the same, double-quoted"],
    ["const a = 'never closed", "a quote that never closes at all"],
    ["const a = 1; " + OPEN + " never closed\n", "a block comment that never closes"],
    ["const a = " + TICK + "never closed;\n", "a template that never closes"],
    ["const a = " + TICK + "x ${ 1 + " + TICK + ";\n", "a ${...} hole that never closes"],
  ];
  for (const [src, why] of refusals) {
    assert.throws(
      () => withoutComments(src),
      /lost track of the source at line/,
      "a stripper that cannot place a character must say so: " + why
    );
  }

  // And it names the line, because "somewhere in page.js" is not a finding.
  assert.throws(
    () => withoutComments("const a = 1;\nconst b = 2;\nconst c = 'unclosed;\n"),
    /at line 3/,
    "the refusal must point at the character it could not place"
  );

  // The refusals must not fire on honest source: every file this suite strips
  // has to survive the lexer, or the guard is a permanent red herring.
  for (const rel of [
    "src/components/landing/AnswerSheet.jsx",
    "src/app/page.js",
    "src/app/scan/page.js",
    "src/lib/workers/scanWorker.js",
  ]) {
    assert.doesNotThrow(
      () => withoutComments(readFileSync(path.join(REPO, rel), "utf8")),
      rel + " must lex cleanly, or this stripper is strict about a shape the repo ships"
    );
  }
});

/**
 * R6.4.9, second half — the escape clause.
 *
 * Every source guard in this file, and every sibling that scans source text,
 * ends in src.includes(label). JavaScript and JSX each spell an engine name
 * several ways that render identically and match nothing. This is the finding
 * the roadmap called "not exemption-specific": it defeats the typed clause
 * itself, not just the ENGINE_NOTE allowance.
 */
test("GUARD — an escaped spelling of an engine name is decoded before includes() reads it", () => {
  // A real backslash and a real non-breaking space, built rather than typed, so
  // nothing in the editing chain can normalise away the thing under test.
  const BS = String.fromCharCode(92);
  const NBSP = String.fromCharCode(160);

  const spellings = [
    [BS + "x43hatGPT", "ChatGPT", "a hex escape in a string"],
    [BS + "u0043hatGPT", "ChatGPT", "a unicode escape in a string"],
    [BS + "u{43}hatGPT", "ChatGPT", "a codepoint escape in a string"],
    ["&#67;hatGPT", "ChatGPT", "an HTML numeric entity in JSX text"],
    ["&#x43;hatGPT", "ChatGPT", "the hex form of the same entity"],
    [BS + "u{50}erplexity", "Perplexity", "a codepoint escape, second engine"],
    ["Google&nbsp;AI&nbsp;Overview", "Google AI Overview", "a named non-breaking space"],
    ["Google" + NBSP + "AI" + NBSP + "Overview", "Google AI Overview", "a raw non-breaking space"],
  ];
  for (const [written, reads, why] of spellings) {
    assert.ok(
      !written.includes(reads),
      why + ": the fixture must not already spell the label, or it proves nothing"
    );
    assert.ok(
      renderableText(written).includes(reads),
      why + " renders " + reads + " to the reader, so the scan must read it that way too"
    );
  }

  // It must not INVENT a label out of honest source. Its failure direction is a
  // false FAILURE, never a false green, and that is only true while it stays a
  // decoder rather than a fuzzy matcher.
  assert.ok(!renderableText("const engines = deployedEngineLabels();\n").includes("ChatGPT"));
  assert.ok(!renderableText("const a = 1; // nothing to see\n").includes("Perplexity"));

  // NOT COVERED, stated rather than implied: a spelling computed at runtime. No
  // source scan in this repo can see it, and the value clause of the
  // sample-report guard is what covers that side.
  const computed = "const chip = String.fromCharCode(67) + 'hatGPT';\n";
  assert.ok(
    !renderableText(withoutComments(computed)).includes("ChatGPT"),
    "documented blind spot: a computed spelling is beyond every source guard here. "
      + "If this ever starts passing, the decoder has become a matcher and its "
      + "false-failure direction needs re-reading."
  );

  // And the decoding must happen in the CHILD that does the real scan, not only
  // in this process. The child is built from a template string, so nothing but
  // an assertion keeps the two pipelines in step.
  const child = sampleReadingUnder.toString();
  assert.match(child, /const renderableText = /, "the child must be given the decoder");
  assert.match(child, /return renderableText\(/, "and sourceOf must actually run it");
  assert.match(child, /const withoutComments = /, "and the same stripper this file uses");
});

test("GUARD — the committed evasion fixtures are caught, and the scan they beat still misses them", async () => {
  const labels = Object.values(ENGINE_LABELS);

  // Both fixtures render their payload. That is not an argument in a comment:
  // each was transformed with sucrase and rendered through react-dom/server,
  // and the provenance block at the top of each file records the markup.
  const cases = [
    [
      "comment-inside-a-string.jsx.txt",
      ["ChatGPT"],
      "a slash-star run inside a SHEET segment is prose React writes into the DOM",
    ],
    [
      "escaped-engine-name.jsx.txt",
      ["ChatGPT", "Google AI Overview", "Perplexity"],
      "three engine names spelled so that no substring search can see them",
    ],
    [
      // R6.4.9 round two. The rejection payload: an apostrophe in JSX prose
      // shifts quote pairing for the rest of the line, so the real string that
      // follows lands in code position and its comment run is stripped. This one
      // beat the FIRST version of the lexer, not only the regex it replaced.
      "quote-phase-shift.jsx.txt",
      ["Perplexity"],
      "an apostrophe in JSX prose moves the lexer's idea of which quote it is inside",
    ],
  ];

  for (const [name, expected, why] of cases) {
    const src = await read("src/lib/fixtures/landingHonesty/" + name);
    assert.ok(src.length > 400, name + " is too short to be the fixture it claims to be");

    const seen = labels.filter((l) => renderableText(withoutComments(src)).includes(l));
    assert.deepEqual(seen.sort(), [...expected].sort(), name + ": " + why);

    // The scan as it stood before R6.4.9 — the old stripper, no decoding. If
    // this ever starts seeing the payload, the fixture has stopped being an
    // evasion and needs replacing, not deleting.
    const before = labels.filter((l) => NAIVE_STRIPPER(src).includes(l));
    assert.deepEqual(
      before,
      [],
      name + " must still be invisible to the scan it was written against, or it "
        + "no longer proves the guard closed anything"
    );
  }
});

/**
 * R6.4.9 — THE RENDER PROOF, the half that is not a source scan.
 *
 * Everything above this point reasons about TEXT. A guard can be wrong about
 * text in two directions, and only one of them matters: it can over-scan, which
 * fails loudly, or it can delete something the browser still prints, which
 * reports green while the page lies. Finding C11 is the second kind, so arguing
 * it in a comment is not enough — the payload has to be shown reaching the DOM.
 *
 * So this compiles the REAL guarded surfaces with sucrase and renders them
 * through react-dom/server, the same harness
 * src/components/landing/engineRailAbsentTotal.test.mjs uses on EngineRail, and
 * asserts three things per payload, in this order:
 *
 *   1. the browser PRINTS the engine name — it is in the static markup;
 *   2. the scan as it stood before R6.4.9 (NAIVE_STRIPPER, no decoding) reads
 *      the same file CLEAN — the false green, reproduced rather than recalled;
 *   3. the scan as it stands now SEES it.
 *
 * Clause 2 is what makes this a regression test rather than a demonstration. If
 * a later edit makes the old scan catch the payload too, the payload has
 * stopped being the bug and needs replacing, not deleting.
 *
 * REDUCED MOTION, and why. The sheet types its passage out one character at a
 * time from a useEffect; renderToStaticMarkup runs no effects, so a plain
 * server render shows an EMPTY passage and would prove nothing about the text.
 * A visitor with prefers-reduced-motion gets `instant`, and sees the whole
 * passage at once — that is the state rendered here, produced by flipping the
 * one useState the effect would have set. The flip is asserted to have applied,
 * so a component rewrite fails this test instead of silently rendering nothing.
 *
 * WHAT IT CANNOT PROVE, stated: this is static markup, not a browser. It shows
 * the characters reach the DOM. It does not show a hydration pass, CSS, or what
 * a screen reader announces.
 *
 * R6.4.9 round two — IT RENDERS page.js TOO, and it renders under a CHOSEN
 * deployment. The first round rendered AnswerSheet.jsx alone, with a two-entry
 * module map, and its baseline clause asked one question: is the hard-coded token
 * "ChatGPT" absent. That left the documented JSX-text blind spot doing no work at
 * all — a name hidden in JSX text of page.js was covered by nothing. So the map
 * became a loader: `@/...` and relative specifiers are resolved and compiled from
 * disk, recursively, which is how the whole landing page renders here. Only four
 * specifiers are stubbed, each named and justified below, and anything else
 * throws rather than resolving to undefined.
 */

/**
 * The stub list, rebuilt per render so no two renders share mutable state.
 *
 * Deliberately short. A stub renders a proof of the stub, so each of these has to
 * be a module that cannot carry an engine name into the markup:
 *   - react: the real one.
 *   - next/link: an <a>. The only thing these proofs read off the markup is TEXT,
 *     and a Link's text is its children, which are rendered.
 *   - next/navigation: a static render never navigates. A throwing stub would
 *     fail the render for a reason unrelated to this guard.
 *   - lucide-react: icons are <svg> with no text. A Proxy rather than a list so a
 *     new icon import does not break the proof, and it passes aria-label and
 *     title through, because those DO reach a reader.
 */
function renderStubs() {
  return new Map([
    ["react", React],
    [
      "next/link",
      {
        __esModule: true,
        default: (p) => React.createElement(
          "a",
          { href: String(p.href ?? ""), className: p.className, style: p.style },
          p.children
        ),
      },
    ],
    [
      "next/navigation",
      {
        __esModule: true,
        useRouter: () => ({ push() {}, replace() {}, prefetch() {}, refresh() {}, back() {} }),
        usePathname: () => "/",
        useSearchParams: () => new URLSearchParams(),
      },
    ],
    [
      "lucide-react",
      new Proxy({ __esModule: true }, {
        get: (_t, key) => (key === "__esModule" ? true : ((p = {}) => React.createElement("svg", {
          "data-icon": String(key),
          "aria-label": p["aria-label"],
          title: p.title,
        }))),
      }),
    ],
  ]);
}

/**
 * Compile and render a real surface from disk.
 *
 * `env` is handed to the REAL deployedEngines module rather than stubbing it: that
 * module documents its `env` argument as the pure path tests are meant to take
 * (deployedEngines.js:71-73), and it is the only way to render the page under a
 * deployment other than this process's own, because NEXT_PUBLIC_ENGINES is
 * captured at module load. Every module in the graph — page.js, EngineRail,
 * mockData — gets the same env-bound copy, so the render is internally
 * consistent instead of half one deployment and half another.
 *
 * `overrides` maps an absolute path to source text, which is how a payload is
 * spliced in and how the sheet is put into its reduced-motion state.
 */
function renderSurface(entry, { env = null, overrides = new Map(), minChars = 200 } = {}) {
  const stubs = renderStubs();
  const enginesPath = path.join(REPO, "src/lib/engines/deployedEngines.js");
  const enginesModule = {
    __esModule: true,
    ENGINE_LABELS,
    formatEngineList,
    parseEngineList,
    engineDriftWarning,
    deployedEngines: (e = env) => deployedEngines(e),
    deployedEngineLabels: (e = env) => deployedEngineLabels(e),
    primaryDeployedEngineLabel: (e = env) => primaryDeployedEngineLabel(e),
  };
  const resolveFrom = (specifier, fromFile) => {
    let base;
    if (specifier.startsWith("@/")) base = path.join(REPO, "src", specifier.slice(2));
    else if (specifier.startsWith(".")) base = path.resolve(path.dirname(fromFile), specifier);
    else return null;
    for (const candidate of [base, base + ".js", base + ".jsx", path.join(base, "index.js")]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
    throw new Error(
      fromFile + ' imports "' + specifier + '", which resolves to no file on disk. '
        + "This harness compiles the real graph; a specifier it cannot resolve is a "
        + "broken import, not something to stub."
    );
  };
  const cache = new Map();
  const load = (file) => {
    const abs = path.resolve(file);
    if (abs === enginesPath) return enginesModule;
    if (cache.has(abs)) return cache.get(abs);
    const source = overrides.has(abs) ? overrides.get(abs) : readFileSync(abs, "utf8");
    const { code } = transform(source, {
      transforms: ["jsx", "imports"],
      jsxPragma: "React.createElement",
      jsxFragmentPragma: "React.Fragment",
      filePath: abs,
    });
    const mod = { exports: {} };
    cache.set(abs, mod.exports); // set before running, so a cycle resolves
    const requireShim = (specifier) => {
      if (stubs.has(specifier)) return stubs.get(specifier);
      const resolved = resolveFrom(specifier, abs);
      if (!resolved) {
        throw new Error(
          abs + ' imports "' + specifier + '", which this harness does not resolve. '
            + "Add it to renderStubs() deliberately — a silently stubbed import renders "
            + "a proof of the stub instead of a proof of the component."
        );
      }
      return load(resolved);
    };
    // eslint-disable-next-line no-new-func
    new Function("require", "module", "exports", "React", code)(requireShim, mod, mod.exports, React);
    cache.set(abs, mod.exports);
    return mod.exports;
  };
  const exported = load(entry);
  const Component = exported.AnswerSheet || exported.default;
  assert.equal(
    typeof Component,
    "function",
    entry + " exported no component, so this render proved nothing"
  );
  const markup = renderToStaticMarkup(React.createElement(Component));
  assert.ok(
    markup.length > minChars,
    entry + " rendered " + markup.length + " characters — that is not the surface"
  );
  return markup;
}

/** The one-file form the fixture proof uses: source text, rendered at its own path. */
function renderedMarkup(source, filePath) {
  return renderSurface(filePath, { overrides: new Map([[path.resolve(filePath), source]]) });
}

/** AnswerSheet.jsx as a reduced-motion visitor gets it: the whole passage, at once. */
function reducedMotionSheetSource() {
  const raw = readFileSync(SHEET_PATH, "utf8");
  const TYPED = "const [instant, setInstant] = useState(false);";
  assert.ok(
    raw.includes(TYPED),
    "AnswerSheet.jsx no longer holds its reduced-motion flag in " + TYPED + ". This "
      + "render proof needs the state a reduced-motion visitor sees; find the new flag "
      + "and point at it, do not drop the proof."
  );
  return raw.replace(TYPED, "const [instant, setInstant] = useState(true);");
}

const ALL_ENGINE_LABELS = Object.values(ENGINE_LABELS);

/**
 * The scan pipeline for each guarded file, as it stands NOW and as it stood
 * BEFORE R6.4.9, so a payload can be shown to have been a false green rather
 * than merely asserted to have been one.
 *
 * page.js keeps its ENGINE_NOTE cut in BOTH columns: R2.10.6 shipped that, and
 * the only things R6.4.9 changed are the stripper and the decoder. Leaving the
 * cut out of the "before" column would credit this task with R2.10.6's fix.
 */
const SCAN_PIPELINE = {
  [SHEET_REL]: {
    before: (src) => NAIVE_STRIPPER(src),
    now: (src) => renderableText(withoutComments(src)),
  },
  [PAGE_REL]: {
    before: (src) => NAIVE_STRIPPER(withoutEngineNoteDictionary(src, ALL_ENGINE_LABELS)),
    now: (src) => renderableText(withoutComments(withoutEngineNoteDictionary(src, ALL_ENGINE_LABELS))),
  },
};

test("PROOF — the payloads this guard catches are payloads the browser renders", () => {
  const OPEN = "/" + "*";
  const CLOSE = "*" + "/";
  const BS = String.fromCharCode(92);
  const AP = String.fromCharCode(39);
  const DQ = String.fromCharCode(34);

  const cleanSheet = reducedMotionSheetSource();
  const cleanPage = readFileSync(PAGE_PATH, "utf8");
  const cleanOf = { [SHEET_REL]: cleanSheet, [PAGE_REL]: cleanPage };
  // page.js pulls the sheet in, so it gets the reduced-motion source too —
  // otherwise the typed passage renders empty inside the page and a payload in
  // that passage could not be seen from here.
  const overridesFor = (rel, source) => (rel === PAGE_REL
    ? new Map([[PAGE_PATH, source], [SHEET_PATH, cleanSheet]])
    : new Map([[SHEET_PATH, source]]));
  const pathOf = { [SHEET_REL]: SHEET_PATH, [PAGE_REL]: PAGE_PATH };

  // The baseline, per surface: it must neither render nor scan as naming the
  // token, or a payload cannot be told from the file it was spliced into.
  const sheetBaseline = renderSurface(SHEET_PATH, { overrides: overridesFor(SHEET_REL, cleanSheet) });
  assert.ok(
    sheetBaseline.includes("Clinical outcome analytics"),
    "the reduced-motion render must contain the whole passage, or the payload "
      + "assertions below are reading an empty sheet"
  );
  const pageBaseline = renderSurface(PAGE_PATH, { overrides: overridesFor(PAGE_REL, cleanPage), minChars: 5000 });
  assert.ok(
    pageBaseline.includes("Clinical outcome analytics"),
    "the landing page must render the sheet's whole passage, or a payload spliced "
      + "into the sheet is invisible from the page's own render"
  );

  const payloads = [
    {
      rel: SHEET_REL,
      token: "ChatGPT",
      why: "a slash-star run inside a SHEET string — finding C11, first half",
      find: " is cited more often, particularly",
      put: " is cited more often" + OPEN + " ChatGPT: and the click that never "
        + "happens is what it costs you " + CLOSE + ", particularly",
      // The rendered prose keeps the comment characters, because they were never
      // a comment: React writes the string out character for character.
      renders: " is cited more often" + OPEN + " ChatGPT:",
    },
    {
      rel: SHEET_REL,
      token: "ChatGPT",
      why: "a hex escape in a SHEET string — finding C11, second half",
      find: "{ t: 'Clinical",
      put: "{ t: '" + BS + "x43hatGPT ranks it first. Clinical",
      renders: "ChatGPT ranks it first.",
      // This payload's hiding mechanism is the ESCAPE, not a comment run, so its
      // control is the same sentence spelled in plain characters.
      controlPut: "{ t: 'ChatGPT ranks it first. Clinical",
    },
    /**
     * R6.4.9 ROUND TWO — THE QUOTE-PHASE SHIFT, both surfaces.
     *
     * This is the payload that beat the first round of this fix at 24/24 green,
     * canary and both render proofs included. Three chips on ONE line: the
     * apostrophe in "Brightwave's" is JSX prose, but the lexer reads it as a
     * string delimiter and pairs it with the apostrophe that OPENS the real
     * string in the middle chip — so the real string's contents land in code
     * position and the comment run inside them is stripped. The apostrophe in
     * "NorthPeak's" pairs with the one that closed that string, so the line ends
     * in code and nothing refuses.
     *
     * Written as one line on purpose: the phase shift is a per-line effect, and
     * breaking it across lines is what makes the honest version of this code
     * safe. Its plain-spelling control is in the loop below.
     */
    {
      rel: SHEET_REL,
      token: "Perplexity",
      why: "an apostrophe in JSX prose shifting quote phase — AnswerSheet.jsx",
      find: "<span className=" + DQ + "chip chip--you" + DQ + ">You · mentioned</span>",
      put: "<span className=" + DQ + "chip chip--you" + DQ + ">Brightwave" + AP + "s mention</span>"
        + "<span className=" + DQ + "chip" + DQ + ">{" + AP + " cited " + OPEN + " Perplexity "
        + CLOSE + " first" + AP + "}</span>"
        + "<span className=" + DQ + "chip" + DQ + ">NorthPeak" + AP + "s pick</span>",
      renders: " cited " + OPEN + " Perplexity " + CLOSE + " first",
    },
    {
      rel: PAGE_REL,
      token: "ChatGPT",
      why: "an apostrophe in JSX prose shifting quote phase — page.js, which had no "
        + "render baseline at all until this round",
      find: "<span className=" + DQ + "chip chip--warn" + DQ + " style={{ marginLeft: "
        + AP + "auto" + AP + " }}>Rival first</span>",
      put: "<span className=" + DQ + "chip chip--warn" + DQ + " style={{ marginLeft: "
        + AP + "auto" + AP + " }}>Brightwave" + AP + "s first</span>"
        + "<span className=" + DQ + "chip" + DQ + ">{" + AP + " cited " + OPEN + " ChatGPT "
        + CLOSE + " first" + AP + "}</span>"
        + "<span className=" + DQ + "chip" + DQ + ">NorthPeak" + AP + "s pick</span>",
      renders: " cited " + OPEN + " ChatGPT " + CLOSE + " first",
    },
  ];

  for (const { rel, token, why, find, put, renders, controlPut } of payloads) {
    const clean = cleanOf[rel];
    const { before, now } = SCAN_PIPELINE[rel];
    assert.ok(
      !before(clean).includes(token) && !now(clean).includes(token),
      why + ": " + rel + " as shipped already scans as naming " + token + ", so a "
        + "payload cannot be told from the baseline. Fix that finding first."
    );
    assert.ok(clean.includes(find), why + ": the splice point " + find + " is gone from " + rel);
    const payloaded = clean.replace(find, put);
    assert.notEqual(payloaded, clean, why + ": the splice changed nothing");

    // 1. THE BROWSER PRINTS IT.
    const markup = renderSurface(pathOf[rel], {
      overrides: overridesFor(rel, payloaded),
      minChars: rel === PAGE_REL ? 5000 : 200,
    });
    assert.ok(
      markup.includes(renders),
      why + ": the payload did not reach the DOM, so this proves nothing. Expected "
        + JSON.stringify(renders) + " in the rendered markup of " + rel + "."
    );
    assert.ok(markup.includes(token), why + ": the rendered markup does not name " + token);

    // 2. THE SCAN THAT SHIPPED READ IT CLEAN. This is the false green itself.
    assert.equal(
      before(payloaded).includes(token),
      false,
      why + ": the pre-R6.4.9 scan now catches this payload, so it has stopped being "
        + "the bug. Replace the payload with one that still evades it — do not delete it."
    );

    // 3. AND THE SCAN AS IT STANDS FAILS ON IT.
    assert.equal(
      now(payloaded).includes(token),
      true,
      why + ": " + rel + " renders " + token + " and the current scan still cannot see it"
    );

    // 4. THE CONTROL. The same name in the same place, with ONLY the hiding
    //    mechanism removed — the comment markers, or the escape spelling. The
    //    scan must catch it. If the control were ALSO invisible, the payload
    //    would be proving something about the surrounding markup rather than
    //    about the mechanism, which is the whole of this task.
    const control = clean.replace(
      find,
      controlPut ?? put.split(OPEN).join("").split(CLOSE).join("")
    );
    assert.notEqual(control, payloaded, why + ": the control is the payload");
    assert.equal(
      now(control).includes(token),
      true,
      why + ": the plain-spelling control is invisible to the current scan too, so "
        + "the payload is not isolating the comment run"
    );
  }

  // The escape half is the DECODER's, not the lexer's: the stripper alone,
  // however exact, reads source bytes and the bytes spell nothing.
  const escaped = cleanSheet.replace("{ t: 'Clinical", "{ t: '" + BS + "x43hatGPT ranks it first. Clinical");
  assert.ok(
    !withoutComments(escaped).includes("ChatGPT"),
    "if the lexer alone now sees a hex escape, renderableText has stopped being the "
      + "thing that closes the second half of C11 and this test is mis-attributing"
  );
});

/**
 * R6.4.9 round two — THE RENDER BASELINE, widened, and why it has to be.
 *
 * The JSX-text blind spot (blind spot 1 on withoutComments) is still open: a
 * slash-star run in JSX text with no quote character on its line is stripped from
 * the scanned copy, and React renders it. The first round DOCUMENTED that and
 * then covered it with nothing — the render proof above asked one question of one
 * file: is the hard-coded token "ChatGPT" absent from AnswerSheet.jsx's markup.
 * A documented limitation with no check behind it is a comment, not a guard.
 *
 * So this is the check behind it. For every deployment config, render BOTH
 * guarded surfaces and require that every label in ENGINE_LABELS that this
 * config does not deploy is absent from the markup — in its raw spelling and in
 * its decoded one, so an entity or a non-breaking space cannot smuggle it past.
 * A name hidden in JSX text is still a name in the DOM, so it fails here even
 * while the source scan is blind to it.
 *
 * And the deployed label must be PRESENT, or an empty render would pass every
 * clause in this test by saying nothing at all.
 */
test("PROOF — no surface renders an engine label its deployment does not probe, under any config", () => {
  const reducedSheet = reducedMotionSheetSource();
  const CONFIGS = ["aio", "chatgpt", "perplexity", "aio,perplexity", "perplexity,chatgpt"];
  // Every known label has to be OFF-deployment in at least one config here, or
  // a label exists that this test never checks for absence and the coverage
  // claim in withoutComments' docblock is false. Asserted at the bottom.
  const checkedAbsent = new Set();

  for (const configured of CONFIGS) {
    const env = { NEXT_PUBLIC_ENGINES: configured, ENGINES: configured };
    const deployed = deployedEngineLabels(env);
    const notDeployed = ALL_ENGINE_LABELS.filter((l) => !deployed.includes(l));
    assert.ok(
      notDeployed.length > 0,
      "NEXT_PUBLIC_ENGINES=" + configured + " deploys every known engine, so it "
        + "cannot show that a surface follows the deployment. Every config in this "
        + "list must leave at least one label off."
    );

    const surfaces = [
      [SHEET_REL, SHEET_PATH, 200],
      [PAGE_REL, PAGE_PATH, 5000],
    ];
    for (const [rel, abs, minChars] of surfaces) {
      const markup = renderSurface(abs, {
        env,
        overrides: new Map([[SHEET_PATH, reducedSheet]]),
        minChars,
      });
      assert.ok(
        markup.includes("Clinical outcome analytics"),
        rel + " under NEXT_PUBLIC_ENGINES=" + configured + " rendered without the "
          + "sheet's passage, so this render is reading an empty surface"
      );
      assert.ok(
        markup.includes(deployed[0]),
        rel + " under NEXT_PUBLIC_ENGINES=" + configured + " names no engine at all. "
          + "An empty render passes the clause below by saying nothing."
      );
      const decoded = renderableText(markup);
      for (const label of notDeployed) {
        assert.ok(
          !markup.includes(label) && !decoded.includes(label),
          rel + " renders " + JSON.stringify(label) + " under NEXT_PUBLIC_ENGINES="
            + configured + ", which does not probe it. This is the DOM, not a source "
            + "scan: the name is on the page whatever the scan above thinks."
        );
        checkedAbsent.add(label);
      }
    }
  }

  assert.deepEqual(
    [...checkedAbsent].sort(),
    [...ALL_ENGINE_LABELS].sort(),
    "a known engine label is never checked for absence by any config in this test, "
      + "so it could be typed into either surface's JSX text and nothing here would "
      + "see it. Add a config that leaves it off."
  );
});

test("PROOF — the committed fixtures render the payload their provenance block claims", async () => {
  const OPEN = "/" + "*";
  const NBSP = String.fromCharCode(160);
  const dir = path.join(REPO, "src/lib/fixtures/landingHonesty");

  // FIXTURE ONE. The comment sequence is inside a string, so React writes it
  // out verbatim — opener and all. The provenance block records this markup;
  // this is the assertion that keeps the record honest.
  const one = path.join(dir, "comment-inside-a-string.jsx.txt");
  const markupOne = renderedMarkup(await read("src/lib/fixtures/landingHonesty/comment-inside-a-string.jsx.txt"), one);
  assert.ok(
    markupOne.includes("<span> is cited more often" + OPEN + " ChatGPT:"),
    "the fixture's own provenance block quotes this span; it must be what renders"
  );
  assert.ok(
    !NAIVE_STRIPPER(await read("src/lib/fixtures/landingHonesty/comment-inside-a-string.jsx.txt")).includes("ChatGPT"),
    "and the scan it was written against must still read it clean"
  );

  // FIXTURE TWO. Three labels, six spellings, none of them the label's own
  // bytes. The markup carries "Google AI Overview" TWICE in plain characters
  // and a third time with non-breaking spaces, which is a label to every reader
  // and to no includes() — so the decoder has to be what finds the third.
  const two = path.join(dir, "escaped-engine-name.jsx.txt");
  const markupTwo = renderedMarkup(await read("src/lib/fixtures/landingHonesty/escaped-engine-name.jsx.txt"), two);
  for (const label of ["ChatGPT", "Perplexity", "Google AI Overview"]) {
    assert.ok(renderableText(markupTwo).includes(label), "the fixture must render " + label);
  }
  assert.ok(markupTwo.includes(NBSP), "the non-breaking-space spelling must survive into the markup");
  // FIXTURE THREE. R6.4.9 round two: the comment markers survive into the DOM
  // because they were never a comment — the lexer only thought they were, having
  // been pushed one quote out of phase by an apostrophe in JSX prose.
  const CLOSE = "*" + "/";
  const three = path.join(dir, "quote-phase-shift.jsx.txt");
  const markupThree = renderedMarkup(await read("src/lib/fixtures/landingHonesty/quote-phase-shift.jsx.txt"), three);
  assert.ok(
    markupThree.includes(" cited " + OPEN + " Perplexity " + CLOSE + " first"),
    "the fixture's provenance block quotes this span; it must be what renders"
  );
  assert.ok(
    !NAIVE_STRIPPER(await read("src/lib/fixtures/landingHonesty/quote-phase-shift.jsx.txt")).includes("Perplexity"),
    "and the scan it was written against must still read it clean"
  );

  const plain = markupTwo.split("Google AI Overview").length - 1;
  const decoded = renderableText(markupTwo).split("Google AI Overview").length - 1;
  assert.equal(plain, 2, "two of the three spellings render as plain characters");
  assert.equal(
    decoded,
    3,
    "and the third reads as the label only once the non-breaking spaces are decoded — "
      + "that gap is the second half of C11, measured rather than described"
  );
});

/**
 * R6.4.9 — the anti-vacuity check.
 *
 * Every clause in this file ends in includes() over a string that some tool
 * produced. If that tool ever skips a span, every clause reads clean over the
 * part it never saw and the suite reports 17 green. The only way to know a scan
 * covered a file is to put something in the file it must find, on every line,
 * and check that it found it.
 *
 * So: inject an engine name at the end of every line of every guarded file, run
 * the REAL pipeline, and require that each injection is either seen or REFUSED.
 * Silence is the only failure. A line that goes quiet is a line the guard does
 * not read, and the only acceptable reason for that is that the line is inside
 * a comment — checked below against a deliberately over-approximate map of the
 * raw text, so a skipped span of ordinary code cannot hide behind it.
 */
test("CANARY — the engine-label scan reads every line of every guarded file", () => {
  const labels = Object.values(ENGINE_LABELS);
  const TOKEN = "ChatGPT";

  // The pipeline the child runs, in this process so it can be pointed at a
  // mutant. Kept in step with the child by the assertions in the escape test.
  const scanned = (rel, text) => renderableText(
    rel === "src/app/page.js"
      ? withoutComments(withoutEngineNoteDictionary(text, labels))
      : withoutComments(text)
  );
  // Seen, or refused out loud. Only a clean, silent, engine-free reading counts
  // as a blind spot — which is exactly the shape of every finding in this file.
  const reads = (rel, text) => {
    try {
      return scanned(rel, text).includes(TOKEN);
    } catch {
      return true;
    }
  };

  /**
   * An OVER-APPROXIMATE map of which lines end inside a comment, computed from
   * the raw text with no idea which quote it is inside. Being wrong in that
   * direction is the point: it claims "comment" wherever a comment could
   * possibly be, so it is useless for stripping and exactly right as an alibi
   * list. A line that goes quiet and is NOT in here is a span the scan skipped
   * for a reason nobody can point at.
   */
  const endsInsideAComment = (text) => {
    const covered = new Set();
    let inBlock = false;
    text.split("\n").forEach((line, idx) => {
      let lineComment = false;
      for (let k = 0; k < line.length; k += 1) {
        if (inBlock) {
          if (line.startsWith("*/", k)) {
            inBlock = false;
            k += 1;
          }
          continue;
        }
        if (line.startsWith("/*", k)) {
          inBlock = true;
          k += 1;
          continue;
        }
        if (line.startsWith("//", k)) {
          lineComment = true;
          break;
        }
      }
      if (inBlock || lineComment) covered.add(idx + 1);
    });
    return covered;
  };

  /**
   * Lines that must NEVER go quiet, identified by CONTENT so they survive every
   * renumbering. Each is a place the page renders a string verbatim, which is
   * where all three findings on this surface lived.
   */
  const MUST_READ = {
    "src/components/landing/AnswerSheet.jsx": [
      // every segment of the typed passage: this is the text the sheet writes
      // into the DOM one character at a time, and where R6.4.9's payload sat
      [/^\s*\{ t: '/, 5],
      // the chip that names the engine
      [/className="chip">\{SHEET_ENGINE\}/, 1],
    ],
    "src/app/page.js": [
      // the slide bodies: quoted prose the page renders verbatim
      [/^\s*body: '/, 4],
      // and the evidence card's chip, the literal R2.10.6 found
      [/className="chip">\{SAMPLE_CARD_ENGINE\}/, 1],
    ],
  };

  assert.ok(
    LITERAL_SCAN_FILES.length >= 2,
    "the canary walks the same list the scan does; a list of one is how the "
      + "second sample card went unread for two rounds"
  );

  for (const [rel, abs] of LITERAL_SCAN_FILES) {
    const raw = readFileSync(abs, "utf8");
    const lines = raw.split("\n");
    assert.ok(lines.length > 40, rel + " is only " + lines.length + " lines — the canary is reading the wrong file");
    assert.ok(
      !reads(rel, raw),
      rel + " already scans as naming " + TOKEN + ", so the canary cannot tell an "
        + "injection from the baseline. Fix that finding before trusting this one."
    );

    const quiet = [];
    for (let i = 0; i < lines.length; i += 1) {
      const mutant = lines.slice();
      mutant[i] += TOKEN;
      const text = mutant.join("\n");
      assert.notEqual(text, raw, "the canary must actually mutate the file at line " + (i + 1));
      if (!reads(rel, text)) quiet.push(i + 1);
    }

    const alibi = endsInsideAComment(raw);
    const unexplained = quiet.filter((n) => !alibi.has(n));
    assert.deepEqual(
      unexplained.map((n) => n + ": " + lines[n - 1].trim().slice(0, 60)),
      [],
      rel + " — the scan silently loses an engine name on these lines, and none of "
        + "them is inside a comment. That is a span of ordinary source the guard "
        + "never reads, which is how it certifies what it never saw."
    );
    assert.ok(
      quiet.length * 2 < lines.length,
      rel + " — " + quiet.length + " of " + lines.length + " lines swallow an injected "
        + "engine name. A scan that cannot see half a file is not a scan."
    );

    for (const [pattern, atLeast] of MUST_READ[rel]) {
      const hits = [];
      lines.forEach((line, idx) => {
        if (pattern.test(line)) hits.push(idx + 1);
      });
      assert.ok(
        hits.length >= atLeast,
        rel + " no longer has " + atLeast + " line(s) matching " + pattern + ". The "
          + "canary's anchors are content-matched on purpose; if the code moved, "
          + "move the anchor, do not drop it."
      );
      for (const n of hits) {
        assert.ok(
          !quiet.includes(n),
          rel + ":" + n + " renders a string verbatim and the scan loses an engine "
            + "name appended to it: " + lines[n - 1].trim().slice(0, 70)
        );
        // and again with the token INSIDE the line's first quoted span, which is
        // where a payload would actually be written.
        const q = lines[n - 1].search(/['"]/);
        if (q >= 0) {
          const inside = lines.slice();
          inside[n - 1] = lines[n - 1].slice(0, q + 1) + TOKEN + lines[n - 1].slice(q + 1);
          assert.ok(
            reads(rel, inside.join("\n")),
            rel + ":" + n + " — an engine name written INSIDE this line's quoted span "
              + "is invisible to the scan, which is finding C11 exactly"
          );
        }
      }
    }
  }

  // Vacuity, the other way round: a file that resolves to nothing must not read
  // as clean. page.js is refused outright, because its exemption cannot find the
  // dictionary it exists to exempt.
  assert.throws(
    () => scanned("src/app/page.js", ""),
    /no longer declares ENGINE_NOTE/,
    "an emptied page.js must stop the guard, not pass it"
  );
});
