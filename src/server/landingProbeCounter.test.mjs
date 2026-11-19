/**
 * R2.10.2 — THE LANDING PAGE CLAIMS NO LIFETIME TOTAL, AND CANNOT START AGAIN
 * WITHOUT SOMETHING REAL BEHIND IT.
 *
 * WHAT THE LEDGER SAID, AND WHAT IS ACTUALLY THERE. The finding (C11, still
 * flagged in PRODUCT.md's "Evidence on Hand") is that the landing probe counter
 * is simulated. It WAS: src/components/landing/ProbeCounter.jsx seeded a number
 * at a typed 37720 and added a random 1-3 to it every 2.2 seconds, rendered
 * under the label "Probes run" in a stats strip (src/app/page.js at ca1d000).
 * It measured nothing — the increment was Math.random, so two tabs open side by
 * side disagreed about how much work the product had ever done. That module was
 * DELETED on 2026-08-16 in 5111219, the design-system port, along with the whole
 * stats strip, and nothing replaced it. So the counter does not reproduce on
 * current source: the page makes no aggregate claim at all, and the served HTML
 * carries no such number.
 *
 * WHY A GUARD AND NOT NOTHING. The simulation was removed as a side effect of a
 * redesign, not because anyone decided the claim was dishonest, and the docs
 * still describe it as present. A number like that comes back the moment someone
 * wants the page to look busier, and it comes back the same way: a seed and a
 * timer, because there is nothing real to count yet. This file is the line. It
 * does not assert that a counter is absent — a page is allowed to count things —
 * it asserts that no number on this surface may be MANUFACTURED: not from
 * randomness, not from a clock, not from a typed seed.
 *
 * WHAT THIS GUARD DOES NOT DO, stated rather than implied:
 *   - It reads source, not the rendered DOM. There is no browser, jsdom or JSX
 *     transform in this tree (see landingHonesty.test.mjs, which scans text for
 *     the same reason).
 *   - It scans the landing page and its own component directory. A fabricated
 *     counter smuggled in from another directory is caught only by the
 *     component-name check below, which is a name check and evadable by
 *     renaming. The pattern rules are the load-bearing half; the name check is
 *     the cheap hop that catches the exact historical shape.
 *   - A SMALL fabricated number (a typed "412 probes this week") trips no rule.
 *     Typed totals are caught two ways only: five digits or more, or digits
 *     grouped by commas the way a total is written for a reader. That is a
 *     floor, not a proof.
 *   - It is a quote-aware character walk, NOT a parser, and it does NOT refuse
 *     everything it cannot parse. An earlier version of this header claimed it
 *     did. That claim was false, and this bullet is long because of it. The one
 *     shape the walk cannot tell apart from a string is an APOSTROPHE IN JSX
 *     TEXT: `doesn't` opens what looks like a string, it runs to the next
 *     apostrophe, and any code between the two is deleted unread — which is a
 *     scan reporting green over the very thing it exists to catch. Where that
 *     span crosses a line break the walk now THROWS, because a JavaScript
 *     single- or double-quoted string cannot hold an unescaped newline; that is
 *     language semantics, not a heuristic, and it covers the multi-line JSX case
 *     that made this guard blind in review. It also covers two apostrophes on
 *     ONE line (R2.10.7): prose apostrophes adjacent to word characters and
 *     same-line single-quoted spans enclosing fabrication rule matches THROW,
 *     naming the line. So: write a contraction in landing copy as &rsquo; or
 *     inside a template literal, never as a bare `'`.
 *   - The self-increment rule reads a bounded, brace-balanced window of a block
 *     body, so a body nested more than one level deep can hide the `+` from it.
 *   - The timer rule takes a bare `setInterval`, but a `setTimeout` only when it
 *     is PAIRED with a self-incrementing state updater — because a rescheduling
 *     `setTimeout` on its own is how AnswerSheet.jsx types out a fixed passage,
 *     and that number is an index into prose, not a claim. The gap that leaves:
 *     a counter that grows a plain local (`n += 1; setWritten(n)`) on a
 *     `setTimeout` is not the pair and is not caught, though a five-digit seed
 *     or a comma-grouped render of it still is.
 *
 * If a real counter is ever wanted here it reads a count query, and when that
 * query cannot answer, the surface renders an em dash and a state chip — never a
 * zero, which is a reading, and never a seed, which is a lie.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LANDING_DIR = "src/components/landing";
const PAGE = "src/app/page.js";

/**
 * Comments and string contents removed, so the rules below read CODE.
 *
 * Why it must know which quote it is inside: stripping `//` naively would eat
 * everything after an "https://" in an href and hide whatever code shared that
 * line — an under-scan, the one direction a guard must never fail in. Template
 * literals keep their `${...}` expressions, because that is code that renders.
 *
 * WHAT IT REFUSES, exactly — it does not refuse everything it cannot parse, and
 * saying otherwise is how this file failed review once already:
 *   1. The walk reaching end of file still inside a string, template or comment.
 *      A regex literal holding an odd quote desynchronises the walk this way and
 *      surfaces as a failure instead of as silence.
 *   2. An unescaped newline while inside a '…' or "…" string. A JavaScript
 *      quoted string literal cannot contain one, so the opening quote was not a
 *      string quote — in this directory it is an apostrophe in JSX prose, and
 *      everything after it up to the next apostrophe would have been deleted
 *      unread. (A `\` line continuation is escaped and still legal, and template
 *      literals span lines legitimately, so neither is refused.)
 *   3. Prose apostrophes adjacent to word characters on the same line, or
 *      same-line single-quoted spans enclosing code matching fabrication rules.
 *      These THROW, closing the residual blind spot (R2.10.7).
 */

/**
 * `setCount((c) => c + inc)`, and the same lie with a block body,
 * `setCount((c) => { ... c + 1 ... })`. The block alternative walks a
 * brace-balanced body (one level of nesting deep) looking for the updater's own
 * parameter being added to, so it cannot run past the arrow's closing brace and
 * accuse an unrelated `c +` further down the file. Named because the timer rule
 * reads it too.
 */
const SELF_INCREMENT =
  /set(?!Timeout\b|Interval\b)[A-Z]\w*\s*\(\s*\(?\s*(\w+)\s*\)?\s*=>\s*(?:\{(?:[^{}]|\{[^{}]*\})*?)?\b\1\s*[+-]/;

/**
 * `x ?? 0`, `x || 0`, and the assigning forms. R2.7.9.
 *
 * The historical shapes above all MAKE UP a number out of nothing. This one is
 * quieter and was found live on this surface: EngineRail.jsx read
 * `const perEngine = total ?? (engines[0]?.asked ?? 0)` and rendered "The same 0
 * questions go to each" whenever the figure was absent. It was masked, not
 * harmless — page.js passes `total` on every render today, so the fabricated
 * zero waited on one caller changing its mind. A zero is a reading; substituting
 * one for a measurement nobody took is standing rule 5 broken on the first
 * surface a prospect sees.
 *
 * The lookahead is what keeps `?? 0.5` and `?? 0.9` — real opacities and
 * fractions — out of the accusation; only a bare zero is the lie.
 *
 * IT IS BLUNT ON PURPOSE. It cannot tell a rendered metric from an internal
 * index, so a legitimate `?? 0` on this surface trips it too. That is the price
 * of the rule and the escape is not an exemption list: write the branch out, and
 * let the absent case say it is absent. Nothing on the landing surface needed
 * the shape when this rule landed.
 *
 * What it does NOT catch, stated rather than implied: `x === undefined ? 0 : x`
 * and `Number(x) || 0` spelled across two statements are the same lie in
 * different words and pass this rule.
 *
 * R2.7.11 NOTE ON TERNARY-TO-ZERO:
 * Ternary-to-zero cannot be caught blindly by regex without accusing legitimate
 * UI styling and geometry across React components (e.g. `style={{ margin: active ? 0 : 8 }}`,
 * `delay: i === 0 ? 0 : 100`, SVG offsets, and array bounds).
 * R2.7.11 removed the ternary-to-zero from src/app/page.js:125-127 so an absent
 * engine reading passes absent (`undefined`) rather than 0. The mechanical invariant
 * is enforced below by driving the page-level builder with an empty engine set and
 * proving no digit or fabricated measured zero ("none asked") reaches EngineRail.
 */
const ZERO_FALLBACK = /(?:\?\?|\|\|)=?\s*-?0(?:\.0+)?(?![\d.])/;

/**
 * The six shapes a manufactured number arrives in. The first four all fire on
 * the module this task is named after; each is proven load-bearing on its own
 * below, so a rule cannot rot into decoration behind the others.
 */
const RULES = [
  {
    id: "random",
    re: /Math\s*\.\s*random/,
    why: "a number drawn from Math.random is not a measurement of anything",
  },
  {
    id: "timer",
    /*
     * TWO SHAPES, because setInterval is not the only spelling.
     *
     * A bare `setInterval` on this surface is enough on its own: it is a clock
     * that keeps firing forever, which is what the deleted ProbeCounter used and
     * what nothing here has any honest use for.
     *
     * A `setTimeout` is NOT enough on its own, and widening the rule to a bare
     * `setTimeout(` was tried and rejected in R2.10.2's second round: it accuses
     * src/components/landing/AnswerSheet.jsx, whose typewriter reveal reschedules
     * itself to type out a FIXED passage. That timer's number is an index bounded
     * by the length of prose already on the page and is never rendered as a
     * figure, so it manufactures nothing — the rule would have been wrong, not
     * the file. What makes a `setTimeout` the historical bug respelled is the
     * PAIR: a rescheduling timer plus state that adds to itself, which is a total
     * with no source. Both halves in one file, and this fires.
     */
    test: (code) =>
      /setInterval\s*\(/.test(code)
      || (/setTimeout\s*\(/.test(code) && SELF_INCREMENT.test(code)),
    why: "a number that grows on a clock is counting seconds, not probes",
  },
  {
    id: "self-increment",
    re: SELF_INCREMENT,
    why: "state that adds to itself is a number inventing its own history",
  },
  {
    id: "seed",
    re: /\b\d{5,}\b/,
    why:
      "a five-digit literal on a marketing surface is a seed; durations and SVG "
      + "geometry here are four digits at most",
  },
  {
    // The rendered shape of the old one was toLocaleString()'s "37,720", and a
    // typed "37,720 probes run" in JSX text is the same claim with the animation
    // removed. Digits grouped by commas are how a big total is written for a
    // reader; nothing else on this page needs that punctuation.
    id: "grouped-total",
    re: /\b\d{1,3}(?:,\d{3})+\b/,
    why: "a comma-grouped total typed into the page is a measurement nobody took",
  },
  {
    id: "zero-fallback",
    re: ZERO_FALLBACK,
    why:
      "?? 0 or || 0 substitutes a reading for a measurement nobody took; write the "
      + "absent branch and render an em dash plus a state (standing rule 5)",
  },
];

/** A rule is a regex or, where one pattern is not enough, a predicate. */
const fires = (rule, code) => (rule.test ? rule.test(code) : rule.re.test(code));

export function codeOnly(src, label = "source") {
  let out = "";
  let i = 0;
  let mode = "code";
  let quote = "";
  // Where the current quote opened, so the refusal can name the line.
  let quoteAt = 0;
  let quotedSpan = "";
  const lineOf = (idx) => src.slice(0, idx).split("\n").length;
  // Depth of `${` interpolations, so a template inside a template is tracked.
  const templates = [];

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (mode === "code") {
      if (ch === "/" && next === "/") { mode = "line"; i += 2; continue; }
      if (ch === "/" && next === "*") { mode = "block"; i += 2; continue; }
      if (ch === '"') {
        mode = "quoted";
        quote = ch;
        quoteAt = i;
        quotedSpan = "";
        out += " ";
        i += 1;
        continue;
      }
      if (ch === "'") {
        if (i > 0 && /[a-zA-Z0-9]/.test(src[i - 1])) {
          throw new Error(
            `landingProbeCounter: could not read ${label} — the ' on line `
            + `${lineOf(i)} was read as an apostrophe in prose (preceded by a word character), `
            + "not a string delimiter. A same-line apostrophe pair swallows code unread. "
            + "Write it as &rsquo; or in a template literal; do not let this scan go quiet.",
          );
        }
        mode = "quoted";
        quote = ch;
        quoteAt = i;
        quotedSpan = "";
        out += " ";
        i += 1;
        continue;
      }
      if (ch === "`") { mode = "template"; templates.push(0); out += " "; i += 1; continue; }
      if (ch === "}" && templates.length > 0 && templates[templates.length - 1] > 0) {
        templates[templates.length - 1] -= 1;
        mode = "template";
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }

    if (mode === "line") {
      if (ch === "\n") { mode = "code"; out += "\n"; }
      i += 1;
      continue;
    }

    if (mode === "block") {
      if (ch === "*" && next === "/") { mode = "code"; i += 2; continue; }
      if (ch === "\n") out += "\n";
      i += 1;
      continue;
    }

    if (mode === "quoted") {
      // A `\` escapes the next character, including a legal line continuation.
      if (ch === "\\") {
        quotedSpan += ch + (next || "");
        i += 2;
        continue;
      }
      if (ch === "\n") {
        // Language semantics, not a heuristic: a JS single- or double-quoted
        // string cannot contain an unescaped newline. So this quote never opened
        // a string, and everything since it has been swallowed unread.
        throw new Error(
          `landingProbeCounter: could not read ${label} — the ${quote} on line `
          + `${lineOf(quoteAt)} was read as a string quote, but the line ended before it `
          + `closed (line ${lineOf(i)}). A JavaScript string cannot span a line unescaped, `
          + "so that quote is prose — an apostrophe in JSX copy is the usual cause — and "
          + "every character after it would have been deleted before the rules ran. "
          + "Write it as &rsquo; or in a template literal; do not let this scan go quiet.",
        );
      }
      if (ch === quote) {
        if (quote === "'") {
          if (i + 1 < src.length && /[a-zA-Z0-9]/.test(src[i + 1])) {
            throw new Error(
              `landingProbeCounter: could not read ${label} — the ' on line `
              + `${lineOf(i)} was read as an apostrophe in prose (followed by a word character), `
              + "not a string delimiter. A same-line apostrophe pair swallows code unread. "
              + "Write it as &rsquo; or in a template literal; do not let this scan go quiet.",
            );
          }
          if (RULES.some((r) => fires(r, quotedSpan))) {
            throw new Error(
              `landingProbeCounter: could not read ${label} — the ' on line `
              + `${lineOf(quoteAt)} closed on line ${lineOf(i)}, but the quoted span `
              + "contained code matching fabrication rules. "
              + "Write contractions as &rsquo; or in a template literal; do not let this scan go quiet.",
            );
          }
        }
        mode = "code";
        quote = "";
      } else {
        quotedSpan += ch;
      }
      i += 1;
      continue;
    }

    // template
    if (ch === "\\") { i += 2; continue; }
    if (ch === "$" && next === "{") {
      templates[templates.length - 1] += 1;
      mode = "code";
      out += " ";
      i += 2;
      continue;
    }
    if (ch === "`") { mode = "code"; templates.pop(); i += 1; continue; }
    if (ch === "\n") out += "\n";
    i += 1;
  }

  if (mode !== "code" || templates.length > 0) {
    throw new Error(
      `landingProbeCounter: could not read ${label} — the scan ended inside a `
      + `${mode === "code" ? "template" : mode}, so something in that file is a shape this `
      + "scanner cannot tell apart from a string. Teach it before shipping the shape.",
    );
  }
  return out;
}

function fabrications(src, label = "source") {
  const code = codeOnly(src, label);
  return RULES.filter((rule) => fires(rule, code)).map((rule) => rule.id);
}

/** page.js plus every component the landing directory holds, discovered, not typed. */
function landingSurface() {
  const dir = path.join(REPO, LANDING_DIR);
  const files = readdirSync(dir)
    .filter((f) => /\.jsx?$/.test(f) && !f.includes(".test."))
    .map((f) => `${LANDING_DIR}/${f}`);
  return [PAGE, ...files];
}

const read = (rel) => readFileSync(path.join(REPO, rel), "utf8");

/**
 * The module this task is about, exactly as it stood at ca1d000, kept here as a
 * fixture so the guard is provably aimed at the thing it was written for. It is
 * a string; nothing imports or renders it.
 */
const DELETED_PROBE_COUNTER = [
  '"use client";',
  "",
  'import { useEffect, useState } from "react";',
  "",
  "const BASE = 37720;",
  "",
  "export const ProbeCounter = () => {",
  "  const [count, setCount] = useState(BASE);",
  "",
  "  useEffect(() => {",
  "    const interval = setInterval(() => {",
  "      const inc = Math.floor(Math.random() * 3) + 1;",
  "      setCount((c) => c + inc);",
  "    }, 2200);",
  "    return () => clearInterval(interval);",
  "  }, []);",
  "",
  "  return <div className=\"lp-stat-value\">{count.toLocaleString()}</div>;",
  "};",
].join("\n");

test("GUARD — the landing surface manufactures no number", () => {
  const files = landingSurface();
  // A guard that scans an empty list certifies nothing. The landing page and its
  // components are both required to be there.
  assert.ok(files.includes(PAGE), "the landing page itself must be scanned");
  assert.ok(
    files.length >= 8,
    `expected the landing directory to hold its components; scanned ${files.length} files`,
  );

  for (const rel of files) {
    const src = read(rel);
    const code = codeOnly(src, rel);
    // Desync smoke test: every one of these files exports something. If the
    // stripper had swallowed the file we would be scanning an empty string and
    // reporting green.
    assert.match(code, /\bexport\b/, `${rel}: the scanner returned no code to scan`);

    const found = fabrications(src, rel);
    assert.deepEqual(
      found,
      [],
      `${rel} manufactures a number (${found
        .map((id) => `${id}: ${RULES.find((r) => r.id === id).why}`)
        .join("; ")})`,
    );
  }
});

test("GUARD — the guard flags the counter it was written for", () => {
  const found = fabrications(DELETED_PROBE_COUNTER, "ProbeCounter fixture");
  assert.deepEqual(
    found.sort(),
    ["random", "seed", "self-increment", "timer"].sort(),
    "the deleted ProbeCounter must trip every rule; if it does not, the rules have rotted",
  );
});

test("each rule is load-bearing on its own", () => {
  const cases = [
    ["const jitter = Math.random() * 3;\nexport default jitter;", "random"],
    ["export const t = setInterval(tick, 1000);", "timer"],
    ["export function f() { setCount((c) => c + inc); }", "self-increment"],
    // Block body, not just the concise arrow: same lie, one pair of braces on.
    [
      "export function f() { setCount((c) => { const n = c + inc; return n; }); }",
      "self-increment",
    ],
    ["export const BASE = 37720;", "seed"],
    ["export const Strip = () => <p>37,720 probes run</p>;", "grouped-total"],
    ["export const n = total ?? 0;", "zero-fallback"],
    ["export const n = total || 0;", "zero-fallback"],
  ];
  for (const [snippet, id] of cases) {
    assert.deepEqual(fabrications(snippet, id), [id], `rule "${id}" did not fire alone`);
  }
});

test("the timer rule's setTimeout half fires on the pair, and only on the pair", () => {
  // A rescheduling timer with nothing growing behind it is an animation, which
  // is what AnswerSheet.jsx does; it manufactures no number and must stay clean.
  assert.deepEqual(
    fabrications("export const t = setTimeout(step, 2200);", "timeout alone"),
    [],
    "a bare setTimeout must not be an accusation on its own — see the rule's note",
  );
  // Add the self-increment and it is the deleted counter with different words.
  assert.deepEqual(
    fabrications(
      "export function f() { setCount((c) => c + 1); setTimeout(f, 2200); }",
      "timeout pair",
    ),
    ["timer", "self-increment"],
    "a rescheduling timer plus state that adds to itself is a total with no source",
  );
});

/**
 * The deleted module respelled as a self-rescheduling setTimeout, which is how
 * the same lie comes back once `setInterval` is the only word anyone greps for.
 * It has no seed and no comma grouping, so it leans entirely on the two rules
 * widened in R2.10.2's second round.
 */
const RESPELLED_PROBE_COUNTER = [
  '"use client";',
  "",
  'import { useEffect, useState } from "react";',
  "",
  "export const ProbesRun = () => {",
  "  const [count, setCount] = useState(9000);",
  "",
  "  useEffect(() => {",
  "    let timer;",
  "    const tick = () => {",
  "      setCount((c) => { return c + 1; });",
  "      timer = setTimeout(tick, 2200);",
  "    };",
  "    tick();",
  "    return () => clearTimeout(timer);",
  "  }, []);",
  "",
  "  return <div>{count}</div>;",
  "};",
].join("\n");

test("GUARD — the counter respelled on setTimeout with a block body still trips", () => {
  assert.deepEqual(
    fabrications(RESPELLED_PROBE_COUNTER, "respelled fixture").sort(),
    ["self-increment", "timer"],
    "a recursive setTimeout counter is the deleted module with different words",
  );
});

/**
 * The line as it actually stood in src/components/landing/EngineRail.jsx before
 * R2.7.9, kept as a fixture so this rule is provably aimed at the shape it was
 * written for. Rendering it with `total` absent put "The same 0 questions go to
 * each" on the landing page.
 */
const FABRICATED_PER_ENGINE = [
  "export function EngineRail({ engines, total }) {",
  "  const perEngine = total ?? (engines[0]?.asked ?? 0);",
  "  return <p>The same {perEngine} questions go to each.</p>;",
  "}",
].join("\n");

test("GUARD — the zero fallback that shipped on this surface trips, and near misses do not", () => {
  assert.deepEqual(
    fabrications(FABRICATED_PER_ENGINE, "EngineRail fixture"),
    ["zero-fallback"],
    "the pre-R2.7.9 EngineRail line is the shape this rule exists for",
  );

  // Every spelling of the same substitution.
  for (const snippet of [
    "export const a = x ?? 0;",
    "export const a = x || 0;",
    "export const a = x??0;",
    "export const a = x ?? -0;",
    "export const a = x ?? 0.0;",
    "export function f(o) { o.count ??= 0; }",
    "export function f(o) { o.count ||= 0; }",
  ]) {
    assert.deepEqual(
      fabrications(snippet, snippet),
      ["zero-fallback"],
      `the zero fallback must fire on: ${snippet}`,
    );
  }

  // And the things that legitimately end in a digit after ?? or ||, which an
  // over-eager version of this rule would accuse. A fraction is not a count.
  for (const snippet of [
    "export const o = opacity ?? 0.5;",
    "export const o = opacity || 0.85;",
    "export const n = count ?? 1;",
    "export const s = label || 'none';",
    "export const bits = flags | 0x0f;",
  ]) {
    assert.deepEqual(
      fabrications(snippet, snippet),
      [],
      `the zero fallback must NOT fire on: ${snippet}`,
    );
  }

  // Prose about the fixed bug is not the bug. EngineRail.jsx now documents the
  // line it used to hold, and must not be read as still holding it.
  assert.deepEqual(
    fabrications(
      "/* this was `const perEngine = total ?? 0` until R2.7.9 */\nexport const x = 1;",
      "prose",
    ),
    [],
    "a comment quoting the old line is documentation, not a fabrication",
  );
});

test("the scanner reads code, not prose — and a comment cannot hide one either", () => {
  // Prose about the thing is not the thing. page.js documents the deleted
  // counter by name and must not trip its own guard.
  const prose = [
    "// the old counter added Math.random() to itself on a setInterval",
    "/* it was seeded at 37720 and setCount((c) => c + inc) every tick */",
    'export const label = "https://perceev.com — 37720 probes, once claimed";',
  ].join("\n");
  assert.deepEqual(fabrications(prose, "prose"), []);

  // But an expression interpolated into a template literal is code that renders.
  assert.deepEqual(
    fabrications("export const s = `probes: ${Math.random()}`;", "template"), ["random"],
  );

  // A URL cannot swallow the rest of its line.
  assert.deepEqual(
    fabrications('export const a = "https://x.test"; const b = Math.random();', "url"), ["random"],
  );

  // The refusal path: a file that ends inside a string is rejected, not scanned.
  assert.throws(
    () => codeOnly('const broken = "unterminated;', "broken.js"),
    /could not read broken\.js/,
  );
});

/**
 * THE REFUSAL HAS ITS OWN TEETH.
 *
 * This is the defect that failed R2.10.2's first round, kept as a test so it
 * cannot come back. Two ordinary contractions in JSX marketing copy read as a
 * quote pair; the walk deleted everything between them, a live Math.random()
 * inside that span vanished, and the guard reported all green on a file holding
 * the exact thing it exists to catch. Apostrophe parity was even, so neither the
 * end-of-walk refusal nor the "returned no code to scan" smoke test fired.
 *
 * A JS quoted string cannot hold an unescaped newline, so the span crossing a
 * line break is proof the quote was prose. That is now a refusal.
 */
const APOSTROPHE_HAZARD = [
  "export const Hero = () => (",
  "  <section>",
  "    <p>It doesn't lie about what it measured.</p>",
  "    <span>{Math.floor(Math.random() * 3) + 1}</span>",
  "    <p>That's the promise.</p>",
  "  </section>",
  ");",
].join("\n");

test("REFUSAL — an apostrophe pair in JSX copy is rejected, never scanned quietly", () => {
  assert.throws(
    () => codeOnly(APOSTROPHE_HAZARD, "Hero.jsx"),
    (err) => {
      assert.match(err.message, /could not read Hero\.jsx/);
      // It must name the line the bad quote opened on, or the refusal is a
      // shrug rather than a bug report.
      assert.match(err.message, /line 3\b/);
      return true;
    },
  );

  // And the refusal must reach the caller the guard actually uses, rather than
  // being swallowed into a clean-looking empty list.
  assert.throws(() => fabrications(APOSTROPHE_HAZARD, "Hero.jsx"), /could not read Hero\.jsx/);

  // R2.10.7: With the newline refusal removed, the same-line apostrophe pair is
  // now refused by rule 3 of the refusal contract (prose apostrophe check and
  // fabricated content in single-quoted span), closing the residual blind spot.
  const withoutTheRefusal = APOSTROPHE_HAZARD.replace(/\n/g, " ");
  assert.throws(
    () => codeOnly(withoutTheRefusal, "one-line"),
    /could not read one-line/,
    "same-line apostrophe pair must be refused by codeOnly",
  );
  assert.throws(
    () => fabrications(withoutTheRefusal, "one-line"),
    /could not read one-line/,
    "same-line apostrophe pair must be refused by fabrications",
  );
});

/**
 * Committed fixture for R2.10.7: A same-line apostrophe pair concealing a live
 * random call. The guard refuses the file and names the line.
 */
const SAME_LINE_APOSTROPHE_FIXTURE = [
  "export const Hero = () => (",
  "  <p>It doesn't lie: {Math.random()} that's all.</p>",
  ");",
].join("\n");

test("REFUSAL — a same-line apostrophe pair concealing Math.random() is rejected (R2.10.7)", () => {
  assert.throws(
    () => codeOnly(SAME_LINE_APOSTROPHE_FIXTURE, "SameLineHero.jsx"),
    (err) => {
      assert.match(err.message, /could not read SameLineHero\.jsx/);
      assert.match(err.message, /line 2\b/);
      return true;
    },
  );
  assert.throws(
    () => fabrications(SAME_LINE_APOSTROPHE_FIXTURE, "SameLineHero.jsx"),
    /could not read SameLineHero\.jsx/,
  );
});

test("REFUSAL — the things that legitimately span lines are not refused", () => {
  // Template literals may hold newlines, and their interpolations stay code.
  assert.deepEqual(
    fabrications("export const s = `probes:\n  ${Math.random()}`;", "template"),
    ["random"],
  );
  // A backslash line continuation inside a quoted string is legal JS.
  assert.deepEqual(fabrications('export const s = "one \\\n two";', "continuation"), []);
  // A double-quoted string holding an apostrophe is a string, not a hazard.
  assert.deepEqual(fabrications("export const s = \"it doesn't lie\";\n", "quoted"), []);
});

test("GUARD — the landing page renders no counter component, and the simulated one is gone", () => {
  assert.equal(
    existsSync(path.join(REPO, LANDING_DIR, "ProbeCounter.jsx")),
    false,
    "ProbeCounter.jsx was deleted in 5111219; a file back under that name is the simulation back",
  );

  const code = codeOnly(read(PAGE), PAGE);
  const named = code.match(/\b\w*(?:Counter|Ticker|Tally|Odometer)\b/g) ?? [];
  assert.deepEqual(
    named,
    [],
    `the landing page references ${named.join(", ")}; a running total on this page has to `
      + "read a real count, and render an em dash with a state chip when it cannot",
  );

  // The label the fabricated number wore. Its absence is what "the simulation is
  // deleted" means at the rendered layer. Read off the stripped code, not the
  // raw file: page.js documents the deleted strip by name, and a page that
  // explains why a claim is gone must not be read as making it.
  assert.doesNotMatch(code, /Probes run/i);
});

async function loadJsx(filePath, requireShim = () => ({})) {
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
  factory(requireShim, moduleRecord, moduleRecord.exports, React);
  return moduleRecord.exports;
}

test("R2.7.11 ACCEPT — driving the page-level builder with no engines passes absent and renders not-measured, never a digit or fabricated zero", async () => {
  const pageSource = await readFile(path.join(REPO, PAGE), "utf8");
  // 1. Static AST/code check: ensure page.js no longer has ternary-to-zero or zero-coalesce for PER_ENGINE_ASKED
  assert.doesNotMatch(
    pageSource,
    /PER_ENGINE_ASKED\s*=\s*[^;]*\?\s*[^;]*:\s*0\b/,
    "src/app/page.js must not define PER_ENGINE_ASKED via ternary falling back to 0"
  );
  assert.doesNotMatch(
    pageSource,
    /PER_ENGINE_ASKED\s*=[^;]*(?:\?\?|\|\|)\s*0\b/,
    "src/app/page.js must not define PER_ENGINE_ASKED via ?? 0 or || 0"
  );

  // 2. Load page.js module exports
  const anyNamedExport = new Proxy(
    { __esModule: true },
    {
      get(target, prop) {
        if (prop in target) return target[prop];
        return () => null;
      },
    }
  );

  const pageModule = await loadJsx(path.join(REPO, PAGE), (specifier) => {
    if (specifier === "@/shared/scoring/promptSetSize") return { DEFAULT_UNBRANDED_TARGET: 30 };
    if (specifier === "@/shared/engines/deployedEngines") {
      return {
        ENGINE_LABELS: { aio: "Google AI Overview", chatgpt: "ChatGPT", perplexity: "Perplexity" },
        deployedEngineLabels: () => ["Google AI Overview"],
        deployedEngines: () => ["aio"],
        primaryDeployedEngineLabel: () => "Google AI Overview",
        formatEngineList: (l) => l.join(", "),
      };
    }
    if (specifier === "@/shared/mockData") {
      return {
        SAMPLE_DESTINATIONS: [],
        SAMPLE_RESULT: { engines: { aio: { answered: 30, visible: 15 } } },
      };
    }
    return anyNamedExport;
  });

  const { computePerEngineAsked } = pageModule;
  assert.equal(typeof computePerEngineAsked, "function", "page.js must export computePerEngineAsked");

  // Driving with empty engines returns undefined (absent), NEVER 0
  const emptyEngines = [];
  const asked = computePerEngineAsked(emptyEngines);
  assert.strictEqual(asked, undefined, "computePerEngineAsked([]) must be undefined, never 0");

  // 3. Load EngineRail
  const railModule = await loadJsx(path.join(REPO, LANDING_DIR, "EngineRail.jsx"), (specifier) => {
    if (specifier === "@/components/landing/Reveal") {
      return { Reveal: ({ children, className }) => React.createElement("div", { className }, children) };
    }
    if (specifier === "@/components/perceev/charts/Gauge") {
      return { Gauge: () => null };
    }
    return () => null;
  });
  const { EngineRail, describeRailTotal } = railModule;

  // describeRailTotal unit check
  const described = describeRailTotal({ total: asked, engines: emptyEngines });
  assert.equal(described.measured, false, "empty engines must result in measured: false");
  assert.equal(described.value, "—", "empty engines must result in value: —");
  assert.equal(described.state, "not measured", "empty engines must report not measured state");

  // 4. Render EngineRail with the page-level builder output
  const html = renderToStaticMarkup(
    React.createElement(EngineRail, { engines: emptyEngines, notes: [], total: asked })
  );

  assert.ok(
    html.includes('data-rail-total-state="not measured"'),
    "EngineRail must report data-rail-total-state=\"not measured\""
  );
  assert.ok(html.includes("not measured"), "EngineRail must render 'not measured' tag");
  assert.ok(html.includes("—"), "EngineRail must render em dash for absent total");
  assert.ok(!html.includes("none asked"), "EngineRail must NOT render 'none asked' (which implies measured zero)");

  // Assert no digit reached the question tally
  const tallyMatch = html.match(/class="num"[^>]*>([^<]*)<\/span>/);
  assert.ok(tallyMatch, "rendered rail must contain a num element");
  assert.equal(tallyMatch[1].trim(), "—", "num element must contain em-dash, not a digit");
  assert.doesNotMatch(tallyMatch[1], /\d/, "num element must not contain any digit");

  // 5. TEETH / SABOTAGE PROOF:
  // If a fabricated 0 WERE passed (the bug R2.7.11 fixes), EngineRail WOULD render a digit 0 and 'none asked'
  const fabricatedHtml = renderToStaticMarkup(
    React.createElement(EngineRail, { engines: emptyEngines, notes: [], total: 0 })
  );
  assert.ok(
    fabricatedHtml.includes('data-rail-total-state="none asked"'),
    "teeth: passing 0 triggers the bug by manufacturing 'none asked'"
  );
  const fabricatedTally = fabricatedHtml.match(/class="num"[^>]*>([^<]*)<\/span>/);
  assert.equal(fabricatedTally[1].trim(), "0", "teeth: passing 0 puts digit 0 on the rail");
});
