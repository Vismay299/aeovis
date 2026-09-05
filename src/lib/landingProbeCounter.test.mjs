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
 *
 * If a real counter is ever wanted here it reads a count query, and when that
 * query cannot answer, the surface renders an em dash and a state chip — never a
 * zero, which is a reading, and never a seed, which is a lie.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
 * It REFUSES what it cannot parse rather than guessing: if the walk ends inside
 * a string or a comment the file is rejected, which is how a regex literal
 * holding an odd quote (the shape that would desynchronise this) surfaces as a
 * failure instead of as silence.
 */
export function codeOnly(src, label = "source") {
  let out = "";
  let i = 0;
  let mode = "code";
  let quote = "";
  // Depth of `${` interpolations, so a template inside a template is tracked.
  const templates = [];

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];

    if (mode === "code") {
      if (ch === "/" && next === "/") { mode = "line"; i += 2; continue; }
      if (ch === "/" && next === "*") { mode = "block"; i += 2; continue; }
      if (ch === '"' || ch === "'") { mode = "quoted"; quote = ch; out += " "; i += 1; continue; }
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
      if (ch === "\\") { i += 2; continue; }
      if (ch === quote) { mode = "code"; quote = ""; }
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

/**
 * The four shapes a manufactured number arrives in. Every one of them fires on
 * the module this task is named after; each is proven load-bearing on its own
 * below, so a rule cannot rot into decoration behind the other three.
 */
const RULES = [
  {
    id: "random",
    re: /Math\s*\.\s*random/,
    why: "a number drawn from Math.random is not a measurement of anything",
  },
  {
    id: "timer",
    re: /setInterval\s*\(/,
    why: "a number that grows on a clock is counting seconds, not probes",
  },
  {
    id: "self-increment",
    re: /set(?!Timeout\b|Interval\b)[A-Z]\w*\s*\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\s*[+-]/,
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
];

function fabrications(src, label = "source") {
  const code = codeOnly(src, label);
  return RULES.filter((rule) => rule.re.test(code)).map((rule) => rule.id);
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
    ["export const BASE = 37720;", "seed"],
    ["export const Strip = () => <p>37,720 probes run</p>;", "grouped-total"],
  ];
  for (const [snippet, id] of cases) {
    assert.deepEqual(fabrications(snippet, id), [id], `rule "${id}" did not fire alone`);
  }
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
