import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  describeScanDataSourceIssue,
  summarizeEngineSlice,
  computeHeadline,
} from "../../lib/scoring/enginePipeline.js";

/**
 * R2.2.6 (finding B3) — the dashboard half of "say which engine degraded".
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE, SAID PLAINLY.
 *
 * This repo has no component-render harness: no jsdom, no testing-library, and
 * `npm run test:scoring` is a bare `node --test` over .test.mjs files. So the
 * banner's TEXT is exercised by RUNNING describeScanDataSourceIssue — that is
 * where every word of it is decided, and enginePipeline.test.mjs drives it from
 * real summarizeEngineSlice output. What this file adds is the other half: a
 * source guard proving DashboardShell.jsx defers to that function instead of
 * typing its own copy, because a decision function nothing renders is a
 * decision nobody sees. Same split R2.7.4 and R2.10.5 used.
 *
 * WHAT THE GUARD PROVES, AFTER R2.2.7.
 *
 * It is a text scan. It cannot prove React mounted the component, that either
 * branch is reachable at runtime, or that the banner is visible on screen.
 * Within the source text it proves four things, and R2.2.7 exists because the
 * first version proved weaker versions of the last two:
 *
 *   1. the import and the call to describeScanDataSourceIssue are still there;
 *   2. each banner element RENDERS {scanHealth.title} and {scanHealth.detail}
 *      inside its own JSX block — not merely that the tokens appear twice
 *      somewhere in the file, and not from inside a comment (see below);
 *   3. the score-suppression condition is still `severity === "critical"`; and
 *   4. THE THREE RENDER GATES READ THAT LOCAL BINDING. The declaration existing
 *      proves nothing on its own: leave it in place, point the gates at
 *      `scanHealth.dataSourceIssue` — which is true for a PARTIAL degradation
 *      too — and the regression is fully restored (score blanked on a partial
 *      read, both banners stacked) with every assertion still green. That was
 *      R2.2.6's verifier's evasion B and it is what test 4 below closes.
 *
 * Every source assertion runs against a COMMENT-STRIPPED copy of the file.
 * Evasion A was to keep `<b>{scanHealth.title}</b>` in a comment, satisfying a
 * count assertion, while rendering a generic literal. A comment renders nothing,
 * so it must not be able to satisfy a guard about what renders.
 *
 * A rename of `dataSourceIssue` or a re-wrap of a gate line WILL trip this file.
 * That is deliberate: the positive regexes failing loudly is the safe direction
 * for a guard whose whole job is that a silent swap stays visible.
 *
 * The remaining hole a text scan cannot close is a binding that is declared
 * correctly and then changed. The `const` pinned in test 3 is what shuts it:
 * with `const` the value cannot be reassigned, so the three gates below can only
 * ever see `severity === "critical"`. If that `const` is ever relaxed to `let`,
 * this file stops proving what it says it proves.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHELL_PATH = path.join(HERE, "DashboardShell.jsx");
const SHELL_RAW = readFileSync(SHELL_PATH, "utf8");

/**
 * Comments out, code in — line numbers preserved so a failure still points at
 * the right line of the real file.
 *
 * `'` is deliberately NOT treated as a string delimiter. This is JSX: the file
 * has apostrophes in rendered prose ("Couldn't load"), and one unpaired one
 * would put the scanner into a phantom string for the rest of the file, where
 * comments would stop being stripped — SILENTLY re-opening evasion A. Every JS
 * string in this component is double-quoted, and if that ever stops being true
 * the failure is over-stripping, which shows up as a red positive assertion
 * rather than as a guard that quietly stopped guarding.
 */
function stripComments(source) {
  let out = "";
  let quote = null;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (quote) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }
    if (c === '"' || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const body = source.slice(i, end === -1 ? source.length : end + 2);
      out += body.replace(/[^\n]/g, ""); // keep the newlines, drop the words
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end; // the newline is copied next pass
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const SHELL = stripComments(SHELL_RAW);

/**
 * The JSX a gate governs: from the `(` the gate opens to its matching `)`.
 * Balanced over the stripped source, skipping double-quoted strings so that
 * `style={{ borderColor: "var(--crit)" }}` cannot unbalance it.
 *
 * Returns null rather than a best guess when the gate is absent or the parens
 * never close — a null block fails its assertion with the gate's own name in
 * the message, instead of silently handing back a slice big enough to make any
 * "contains" assertion pass.
 */
function blockGovernedBy(gate) {
  const at = SHELL.indexOf(gate);
  if (at === -1) return null;
  const open = at + gate.lastIndexOf("(");
  let depth = 0;
  let quote = null;
  for (let i = open; i < SHELL.length; i += 1) {
    const c = SHELL[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "`") {
      quote = c;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return SHELL.slice(open, i + 1);
    }
  }
  return null;
}

const CRITICAL_BANNER_GATE = "{dataSourceIssue && (";
const PARTIAL_BANNER_GATE = '{scanHealth.severity === "partial" && (';

test("R2.2.7 GUARD — the comment stripper keeps the code and drops the comments", () => {
  // Every negative assertion below is of the form "this string is NOT in the
  // source". On an empty string they all pass. So the scanned text has to be
  // shown to still BE the component before any of them means anything.
  assert.ok(
    SHELL.includes("export default function DashboardShell("),
    "the stripped source must still be the component, or every negative below is vacuous"
  );
  assert.ok(
    SHELL.length > SHELL_RAW.length * 0.55,
    `the stripper ate the file: ${SHELL.length} of ${SHELL_RAW.length} chars left`
  );
  assert.equal(
    SHELL.split("\n").length,
    SHELL_RAW.split("\n").length,
    "line numbers must survive stripping so a failure points at the real line"
  );

  // ...and that it actually strips, or evasion A is still open.
  const raw = 'let x = 1; // {scanHealth.title}\nlet y = "keep //this"; /* {scanHealth.title} */\n';
  const stripped = stripComments(raw);
  assert.ok(!stripped.includes("{scanHealth.title}"), "a token in a comment must not survive");
  assert.ok(stripped.includes('"keep //this"'), "a // inside a string is not a comment");
  assert.equal(stripped.split("\n").length, raw.split("\n").length);

  // No un-stripped comment marker anywhere near the two banners. This is the
  // check that the scanner's quote state has not drifted by the time it reaches
  // the part of the file the other tests read: if stripping quietly stopped
  // working there, evasion A is open again and nothing else would say so.
  // Deliberately keyed off the testids, not the gates, so that a broken GATE is
  // reported by the gate test rather than showing up here as well.
  for (const testid of [
    'data-testid="data-source-issue-banner"',
    'data-testid="engine-degraded-banner"',
  ]) {
    const at = SHELL.indexOf(testid);
    assert.notEqual(at, -1, `${testid} is gone from the component`);
    const around = SHELL.slice(at, at + 3000);
    assert.ok(
      !around.includes("/*") && !around.includes("//"),
      `a comment survived stripping around ${testid} — evasion A is open again`
    );
  }
});

test("R2.2.6 GUARD — DashboardShell derives its degradation state from the pipeline", () => {
  assert.match(
    SHELL,
    /import \{ describeScanDataSourceIssue \} from "@\/lib\/scoring\/enginePipeline"/,
    "the component must import the one derivation, not reimplement it"
  );
  assert.match(
    SHELL,
    /const scanHealth = describeScanDataSourceIssue\(result\.perEngineSummaries, \{/,
    "it must be fed the per-engine slices — that is where the engine names live"
  );
  assert.match(
    SHELL,
    /fallbackIssue: result\.dataSourceIssue/,
    "records stored before per-engine slices existed must still raise their banner"
  );
});

test("R2.2.6 GUARD — the banner renders the pipeline's words, not its own", () => {
  assert.match(
    SHELL,
    /data-testid="engine-degraded-banner"/,
    "a text-only degradation needs a banner of its own to appear in"
  );
  assert.match(
    SHELL,
    /scanHealth\.severity === "partial" && \(/,
    "...rendered exactly when one engine dropped out and the index survived"
  );

  // Both banners — the partial one and the critical one — take their headline
  // and their reason from the descriptor. Asserted PER BLOCK, not as a count
  // over the file: R2.2.6's verifier satisfied the count with a copy parked in
  // a comment while the rendered headline was a generic literal (evasion A).
  for (const [name, gate, testid] of [
    ["critical", CRITICAL_BANNER_GATE, 'data-testid="data-source-issue-banner"'],
    ["partial", PARTIAL_BANNER_GATE, 'data-testid="engine-degraded-banner"'],
  ]) {
    const block = blockGovernedBy(gate);
    assert.ok(block, `the ${name} banner's gate \`${gate}\` did not resolve to a JSX block`);
    // The block is the right one, and it is not so over-captured that a token
    // from the other banner could satisfy the two assertions after it.
    assert.ok(block.includes(testid), `the ${name} gate does not govern ${testid}`);
    const otherTestid =
      name === "critical"
        ? 'data-testid="engine-degraded-banner"'
        : 'data-testid="data-source-issue-banner"';
    assert.ok(
      !block.includes(otherTestid),
      `the ${name} block swallowed the other banner — this assertion cannot prove anything`
    );
    assert.ok(
      block.includes("{scanHealth.title}"),
      `the ${name} banner must state which engine degraded, in its own markup`
    );
    assert.ok(
      block.includes("{scanHealth.detail}"),
      `the ${name} banner must carry the reason under the headline`
    );
  }
  // No third, dead copy elsewhere in the file to confuse the next reader.
  assert.equal(
    (SHELL.match(/\{scanHealth\.title\}/g) || []).length,
    2,
    "exactly the two banners render the headline"
  );

  // TEETH: the old fixed headline said nothing about which engine or why. If it
  // comes back as a literal, the banner has gone silent again in the only way
  // that still looks like it is talking.
  assert.ok(
    !SHELL.includes("Data source issue — scan incomplete"),
    "the generic headline must come from describeScanDataSourceIssue, not be typed here"
  );
  assert.ok(
    !SHELL.includes("The engines returned no answer for the majority of tracked queries"),
    "the generic body must come from the descriptor too"
  );
});

test("R2.2.6 GUARD — only 'nothing left to score' suppresses the score", () => {
  assert.match(
    SHELL,
    /const dataSourceIssue = scanHealth\.severity === "critical";/,
    "a partial degradation must annotate the index, not blank a score we do have"
  );
  assert.ok(
    !/const dataSourceIssue = result\.dataSourceIssue;/.test(SHELL),
    "the one-bit record flag cannot decide this on its own any more"
  );
});

test("R2.2.7 GUARD — the three render gates read that binding, not the any-engine bit", () => {
  /**
   * The declaration existing is not the property. `describeScanDataSourceIssue`
   * returns `dataSourceIssue: true` for a PARTIAL degradation as well as a
   * critical one — it means "something degraded", which is the exact question
   * the local binding exists to stop asking. Leave the declaration untouched
   * and point these three gates at `scanHealth.dataSourceIssue` and the whole
   * regression is back: the score blanked because one engine dropped out, the
   * placeholder over the views, and both banners rendered at once.
   *
   * Each assertion pins the gate to the element it governs, so deleting a gate
   * or re-pointing it is a red, not a rename nobody notices.
   */
  // Each gate below is pinned to an element by its testid, so a SECOND element
  // carrying the same testid would let the regex match a decoy while the real
  // one is gated on anything at all.
  for (const testid of [
    'data-testid="data-source-issue-banner"',
    'data-testid="engine-degraded-banner"',
    'data-testid="dashboard-unreliable-placeholder"',
  ]) {
    assert.equal(
      SHELL.split(testid).length - 1,
      1,
      `${testid} must appear exactly once, or the gate assertions can match a decoy`
    );
  }

  assert.match(
    SHELL,
    /\{dataSourceIssue && \(\s*<div\s+className="panel"\s+data-testid="data-source-issue-banner"/,
    "GATE 1: the critical banner must render only when nothing is left to score"
  );
  assert.match(
    SHELL,
    /\{!dataSourceIssue && view === "overview" && \(\s*<div[^>]*>\s*<ScoreBand/,
    "GATE 2: the index is hidden only when nothing is left to score — a partial read still has a real number"
  );
  assert.match(
    SHELL,
    /\{dataSourceIssue && view !== "studio" \? \(\s*<div\s+className="panel"\s+data-testid="dashboard-unreliable-placeholder"/,
    "GATE 3: the views are replaced by the placeholder only when nothing is left to score"
  );

  // TEETH. The descriptor's own boolean is the any-engine bit; reading it
  // anywhere in this component is the regression, whatever the local name.
  assert.ok(
    !SHELL.includes("scanHealth.dataSourceIssue"),
    "scanHealth.dataSourceIssue is true for a partial read too — this screen must branch on severity, never on that bit"
  );
});

test("R2.2.6 GUARD — the per-engine chip marks a degraded engine", () => {
  assert.match(
    SHELL,
    /const degradedEngineKeys = new Set\(scanHealth\.degradedEngines\.map\(\(e\) => e\.engine\)\)/,
    "the chip row needs to know which engines the descriptor condemned"
  );
  assert.match(
    SHELL,
    /degradedEngineKeys\.has\(key\)\s*\?\s*`\$\{engineLabel\(key\)\} \(degraded\)`/,
    "an untrustworthy share_of_ai must not render identically to a counted one"
  );
});

test("R2.2.6 — the strings the guard proves are rendered are non-empty for the real case", () => {
  // The RUN half, kept beside the guard so this file is not only assertions
  // about text. Healthy aio + a perplexity slice answering 6 of 10.
  const answered = (i, visible) => ({
    query: `unbranded prompt ${i}`,
    is_branded_query: false,
    answer_present: true,
    error: null,
    text: "Vendors worth considering include Kajaria and Somany.",
    visible,
    brand_mentioned_in_text: visible,
    brand_cited: false,
    brands: [
      { name: "Italica", is_self: true, mentioned: visible },
      { name: "Kajaria", is_self: false, mentioned: true },
    ],
  });
  const empty = (i) => ({
    query: `unbranded prompt ${i}`,
    is_branded_query: false,
    answer_present: false,
    error: "EMPTY_ANSWER",
    text: "",
    visible: false,
    brands: [],
  });

  const engines = {
    aio: summarizeEngineSlice(
      [
        ...Array.from({ length: 2 }, (_, i) => answered(i, true)),
        ...Array.from({ length: 8 }, (_, i) => answered(100 + i, false)),
      ],
      "aio"
    ),
    perplexity: summarizeEngineSlice(
      [
        ...Array.from({ length: 6 }, (_, i) => answered(200 + i, true)),
        ...Array.from({ length: 4 }, (_, i) => empty(300 + i)),
      ],
      "perplexity"
    ),
  };
  const headline = computeHeadline(Object.values(engines));
  const scanHealth = describeScanDataSourceIssue(engines, {
    enginesCounted: headline.engines_counted,
    fallbackIssue: false,
  });

  assert.equal(scanHealth.severity, "partial", "the partial banner is the one that renders");
  assert.match(scanHealth.title, /Perplexity/);
  assert.match(scanHealth.title, /1 of 2 engines/);
  assert.ok(scanHealth.detail.length > 0);
  // The chip marker's input.
  assert.deepEqual(
    scanHealth.degradedEngines.map((e) => e.engine),
    ["perplexity"],
    "aio keeps a bare chip; perplexity gets the marker"
  );
  // Every row the banner prints must be a real number or an explicit null —
  // never a 0 standing in for a measurement (standing rule 5).
  for (const engine of scanHealth.degradedEngines) {
    assert.ok(
      engine.coverage_pct === null || Number.isFinite(engine.coverage_pct),
      "coverage is a number or an em dash, never an invented zero"
    );
    assert.ok(Number.isFinite(engine.min_coverage_pct));
  }
});
