import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";
import {
  describeScanDataSourceIssue,
  summarizeEngineSlice,
  computeHeadline,
} from "../../shared/scoring/enginePipeline.js";
import * as apiClient from "../../shared/api.js";
import * as formatModule from "../../shared/format.js";
import * as aliasesModule from "../../shared/scoring/aliases.js";
import * as brandKeyModule from "../../shared/scoring/brandKey.js";
import * as aioConstantsModule from "../../shared/scoring/aioConstants.js";
import * as enginePipelineModule from "../../shared/scoring/enginePipeline.js";

/**
 * R2.2.6 (finding B3) — the dashboard half of "say which engine degraded".
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE, SAID PLAINLY.
 *
 * The static source-level half of the banner's proof is below, and the rendered
 * execution half uses the harness at engineSetChangeSurface.test.mjs:136-213
 * (landed 2026-09-05) to compile DashboardShell.jsx with sucrase and render it
 * via react-dom/server. The banner's TEXT is exercised by RUNNING
 * describeScanDataSourceIssue — that is where every word of it is decided, and
 * enginePipeline.test.mjs drives it from real summarizeEngineSlice output.
 * What this file proves is that DashboardShell.jsx defers to that function and
 * actually renders the named degraded engines and visibility index.
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
 *      inside its own JSX block, where RENDERS means the token stands in CHILD
 *      POSITION — between a `>` and a `<` — in text whose comments are stripped
 *      and whose quoted bodies (double, single, backtick) are blanked. Not
 *      merely that the tokens appear twice somewhere in the file; not from
 *      inside a comment; and not from inside an attribute, quoted or not (see
 *      below). It is still source text, not a screen: see the limits at the
 *      bottom;
 *   3. the score-suppression condition is still `severity === "critical"`; and
 *   4. THE THREE RENDER GATES READ THAT LOCAL BINDING. The declaration existing
 *      proves nothing on its own: leave it in place, point the gates at
 *      `scanHealth.dataSourceIssue` — which is true for a PARTIAL degradation
 *      too — and the regression is fully restored (score blanked on a partial
 *      read, both banners stacked) with every assertion still green. That was
 *      R2.2.6's verifier's evasion B and it is what test 4 below closes.
 *
 * Every source assertion runs against a COMMENT-STRIPPED copy of the file, and
 * the two render assertions read a copy of their block with every quoted BODY
 * blanked on top of that. Both steps exist because a
 * "the token is in there somewhere" assertion was satisfied, twice, by text
 * that renders nothing:
 *
 *   - evasion A kept `<b>{scanHealth.title}</b>` in a COMMENT and rendered a
 *     generic literal, satisfying a file-wide count; and
 *   - R2.2.7's second verifier, against the fix for that, gutted both real
 *     renders in the critical banner and parked the tokens in a QUOTED
 *     ATTRIBUTE inside the guarded block —
 *     `<span data-note="{scanHealth.title} {scanHealth.detail}" />`, no comment
 *     marker anywhere — for 7 pass / 0 fail with the banner naming no engine
 *     and giving no reason. Reproduced here before the fix, and the
 *     single-quoted twin `title={'> {scanHealth.title} <'}` was green too until
 *     this pass started treating `'` as a delimiter.
 *
 * "Not in a comment" was never the property; the second bypass is the proof.
 * "In child position, in text that cannot be an attribute value or a string"
 * is the property now asserted, and the limits at the bottom say where even
 * that stops short of "a user saw it".
 *
 * The claim that earns is NARROW, and the first R2.2.7 attempt overclaimed it.
 * It said "a comment renders nothing, so it must not be able to satisfy a guard
 * about what renders" — an aspiration written as a fact. What is actually proven
 * is conditional: the assertions read comment-free text ONLY WHERE the stripper
 * really stripped, and the stripper is a hand-rolled scanner, not a parser. So
 * the first test in this file is the load-bearing one. It proves the stripper's
 * state over the exact text the other tests read, three ways:
 *
 *   - the quote state is BALANCED AT EOF, which catches an unpaired delimiter
 *     leaving a phantom string open for the rest of the file;
 *   - no `"`-delimited span contains a raw newline, because a real double-quoted
 *     JS string literal cannot — a span that does means the scanner is inside a
 *     phantom string and has silently stopped stripping; and
 *   - the stripped text of EACH GOVERNED BLOCK — the same extent, character for
 *     character, that the per-block "contains" assertions read — holds no
 *     surviving `/*` or `//`.
 *
 * That third check is the fix R2.2.7's own verifier extracted from a working
 * bypass. The first attempt checked a FIXED 3000-character window from each
 * testid, while the critical banner's block measures ~3,300 stripped characters
 * — it only has to exceed 3000 for the hole to exist, and it does by ~300, so
 * there was a blind spot INSIDE THE VERY BLOCK BEING GUARDED. The verifier
 * parked the commented copies at testid + 3217 behind a parity-preserving
 * `{'"'} … {'"'}` pair — idiomatic JSX for a literal quote, and a string opener
 * to this scanner — gutted the real renders to a generic `<b>` and a hardcoded
 * reason, and took the suite to 7 pass / 0 fail with the banner naming no engine
 * and giving no reason. Note the parity: an EOF balance check ALONE would not
 * have seen it. Both new checks exist because neither subsumes the other.
 *
 * A rename of `dataSourceIssue` or a re-wrap of a gate line WILL trip this file.
 * That is deliberate: the positive regexes failing loudly is the safe direction
 * for a guard whose whole job is that a silent swap stays visible. So will new
 * prose carrying an apostrophe inside either banner block, because the blanking
 * pass treats `'` as a delimiter: measured, that reds with "an unpaired ' inside
 * the critical block left the blanking pass inside a string", which names the
 * cause. Write the prose with `&apos;` or lift it into the descriptor, where
 * the words belong anyway.
 *
 * WHAT REMAINS UNPROVEN. Said as limits, not as reassurance:
 *
 *   - Reassignment is NOT the open hole the first attempt named it. Test 3 pins
 *     the `const` keyword itself, so `let` — with or without a later write —
 *     fails there. Verified by mutation, both ways.
 *   - RENDERS, above, means "stands in child position in the source text". It
 *     is NOT "appears on screen". A token in child position inside a subtree
 *     that never renders — `{false && <b>{scanHealth.title}</b>}` parked in the
 *     block — satisfies it, and so would a `<span hidden>`.
 *   - AN ENCLOSING CONDITION CAN SUPPRESS A GATE WHOSE EXPRESSION IS UNTOUCHED.
 *     Every gate assertion below reads the gate's own text, so wrapping one in
 *     another condition is invisible here: R2.2.7's verifier wrapped
 *     `{!scanHealth["dataSourceIssue"] && (<>…</>)}` around the ScoreBand gate,
 *     which blanks the index on a partial degradation — the B3 regression this
 *     whole file is named for — at 7 pass / 0 fail.
 *   - THE BRACKET FORM DODGES THE DOTTED-STRING BAN. The teeth at the end of
 *     the gate test ban the literal text `scanHealth.dataSourceIssue`;
 *     `scanHealth["dataSourceIssue"]` reads the same any-engine bit and is not
 *     banned, which is how the wrapper above gets its condition. Banning one
 *     more spelling would not close the class — a string scan cannot enumerate
 *     the ways an expression can be written — so it is recorded here rather
 *     than patched over.
 *   - A text scan cannot see SHADOWING: an inner-scope `dataSourceIssue` between
 *     the declaration and a gate would satisfy every regex here while the gate
 *     reads a different value. Nothing in this file would say so.
 *   - The stripper has no regex-literal state (this component contains none) and
 *     does not treat `'` as a delimiter (see its own docstring for why). The two
 *     flip modes known to exist are now asserted directly; a third nobody has
 *     thought of would still be silent, which is the residual to attack next.
 *   - The text scan alone cannot prove React mounted the component or that the
 *     mounted banner is visible in the browser DOM. The render harness from
 *     engineSetChangeSurface.test.mjs:136-213 executes DashboardShell with
 *     react-dom/server below to prove the behavioral claims directly against
 *     rendered markup.
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
 *
 * That trade has a cost, and R2.2.7's verifier collected it: `{'"'}` is the
 * idiomatic JSX for rendering one literal double-quote, and to this scanner it
 * OPENS a string. A second `{'"'}` closes it, so an attacker can park a
 * parity-preserving pair around a comment and have that comment copied through
 * verbatim. Parity means an end-of-file balance check alone cannot see it. So
 * this returns its scanner state as well as its output, and the self-test below
 * checks BOTH: that the quote state is balanced at EOF (catches the unpaired
 * apostrophe-class flip at its source) and that no `"`-delimited span contains a
 * newline (catches the paired flip — a real double-quoted JS string literal
 * cannot span lines, so a span that does means the scanner is in a phantom
 * string and is no longer stripping anything).
 */
function scanSource(source, { blankQuotedBodies = false } = {}) {
  let out = "";
  let quote = null;
  let quoteOpenedAtLine = -1;
  let spanningQuoteLine = -1; // first `"` span found to contain a raw newline
  let line = 1;
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "\n") line += 1;
    if (quote) {
      if (c === "\\") {
        const pair = c + (next ?? "");
        out += blankQuotedBodies ? pair.replace(/[^\n]/g, " ") : pair;
        if (next === "\n") line += 1;
        i += 2;
        continue;
      }
      if (c === "\n" && quote === '"' && spanningQuoteLine === -1) {
        spanningQuoteLine = quoteOpenedAtLine;
      }
      if (c === quote) {
        quote = null;
        out += c; // the delimiters stay put, so the markup still parses by eye
        i += 1;
        continue;
      }
      // Newlines are never blanked: line numbers and offsets have to survive.
      out += blankQuotedBodies && c !== "\n" ? " " : c;
      i += 1;
      continue;
    }
    // `'` is a delimiter ONLY in blanking mode, and only because that mode runs
    // over an already-comment-stripped block: there, a stray apostrophe can
    // only make it blank too much, which reds a positive assertion. In the
    // comment-stripping mode it would be the silent direction. See the two
    // docstrings above.
    if (c === '"' || c === "`" || (blankQuotedBodies && c === "'")) {
      quote = c;
      quoteOpenedAtLine = line;
      out += c;
      i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const body = source.slice(i, end === -1 ? source.length : end + 2);
      line += (body.match(/\n/g) || []).length;
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
  return { text: out, unterminatedQuote: quote, quoteOpenedAtLine, spanningQuoteLine };
}

const stripComments = (source) => scanSource(source).text;

/**
 * The same scan, one notch stricter: the BODY of every quoted span — double,
 * single or backtick — is replaced by spaces, delimiters and newlines kept so
 * offsets and line numbers do not move.
 *
 * Only the two "this banner renders the descriptor's words" assertions read
 * this. A comment is not the only text that renders nothing, and R2.2.7's
 * second verifier proved it: it gutted both real renders in the critical banner
 * to generic literals and parked the tokens in
 * `<span data-note="{scanHealth.title} {scanHealth.detail}" />` inside the very
 * block being guarded, with no comment marker anywhere, and the file reported
 * 7 pass / 0 fail while the banner named no engine and gave no reason. A quoted
 * attribute value is data, not children; blanking it removes the vehicle.
 *
 * `'` IS a delimiter here, unlike in the comment-stripping pass, because
 * `<span title={'> {scanHealth.title} <'} />` is the same bypass one character
 * away and was measured green without it. The reason the stripper refuses `'`
 * — an unpaired apostrophe in prose flips the scanner and comments silently
 * stop being stripped — does not apply to this pass: it runs over text whose
 * comments are already gone, so a flip here can only blank too much, and too
 * much blanking reds a positive assertion. Loud, not silent. Neither banner
 * block contains an apostrophe today; if prose adds one, the caller's
 * unterminated-delimiter check below names it instead of leaving a puzzling red.
 *
 * Over-blanking is the SAFE failure direction — a positive assertion goes red.
 * Under-blanking is the silent one, so the callers assert that the blanking
 * actually ran over the exact text they read (the testid's own value is inside
 * a double-quoted span, so it must be gone), and the self-test in the first
 * test below pins both directions on a fixture.
 */
const renderedScanOf = (block) => scanSource(block, { blankQuotedBodies: true });
const renderedTextOf = (block) => renderedScanOf(block).text;

const SHELL_SCAN = scanSource(SHELL_RAW);
const SHELL = SHELL_SCAN.text;

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

  // ...and the blanking mode, which the two render assertions depend on, in
  // both directions: it must empty a quoted body (or a token parked in an
  // attribute value passes for a render) and must leave child text alone (or
  // those same assertions go red for no reason and get weakened by the next
  // reader).
  const attrFixture =
    '<span data-note="{scanHealth.title}" />\n' +
    "<span title={'{scanHealth.title}'} />\n" +
    "<span className={`{scanHealth.title}`} />\n" +
    "<b>{scanHealth.title}</b>\n";
  const blanked = renderedTextOf(attrFixture);
  assert.ok(
    !blanked.includes('data-note="{scanHealth.title}"'),
    "a token parked in a double-quoted attribute value must not survive blanking"
  );
  assert.ok(
    !blanked.includes("title={'{scanHealth.title}'}"),
    "...nor in a single-quoted one, which is the same bypass one character away"
  );
  assert.ok(
    !blanked.includes("className={`{scanHealth.title}`}"),
    "...nor in a template literal, which would render the braces and not the value"
  );
  assert.equal(
    (blanked.match(/\{scanHealth\.title\}/g) || []).length,
    1,
    "exactly the one child-text copy in the fixture may survive blanking"
  );
  assert.ok(
    blanked.includes("<b>{scanHealth.title}</b>"),
    "blanking must leave JSX child text alone"
  );
  assert.equal(blanked.length, attrFixture.length, "blanking must not move offsets");

  // THE SCANNER STATE ITSELF. Two ways the quote state can flip into a phantom
  // string where comments stop being stripped, both checked at the source rather
  // than at one downstream symptom:
  //
  //   (a) an unpaired delimiter leaves a string open at EOF; and
  //   (b) a PAIRED flip — `{'"'} … {'"'}`, JSX for a literal double-quote, which
  //       balances and so survives (a). A real double-quoted JS string literal
  //       cannot contain a raw newline, so a `"` span that does is not a string.
  assert.equal(
    SHELL_SCAN.unterminatedQuote,
    null,
    `the ${SHELL_SCAN.unterminatedQuote}-string still open at EOF began at DashboardShell.jsx:${SHELL_SCAN.quoteOpenedAtLine} — note the delimiter that BROKE PARITY is likely earlier than that line, since every opener after it has been mispaired; from wherever it is, the stripper copies comments verbatim`
  );
  assert.equal(
    SHELL_SCAN.spanningQuoteLine,
    -1,
    `a "-delimited span opened at DashboardShell.jsx:${SHELL_SCAN.spanningQuoteLine} runs past the end of its line, so it is not a string literal — the stripper is in a phantom string and has stopped stripping`
  );

  // No un-stripped comment marker anywhere the "contains" assertions can read.
  // This is the check that the scanner's quote state has not drifted by the time
  // it reaches the part of the file the other tests read: if stripping quietly
  // stopped working there, evasion A is open again and nothing else would say so.
  //
  // The window is the FULL EXTENT OF THE GOVERNED BLOCK, deliberately the exact
  // same text `blockGovernedBy` hands the per-block assertions below. R2.2.7's
  // first attempt used a fixed `slice(at, at + 3000)` from each testid; the
  // critical banner's block measures ~3,300 stripped characters, so there was a
  // ~300-character blind spot INSIDE THE VERY BLOCK BEING GUARDED — and note it
  // grows every time the banner does. The verifier parked the commented
  // copies at testid + 3217 behind a `{'"'}` pair and took the suite green with
  // the banner naming no engine. Any window that is not the block's own extent
  // has that hole; this one cannot, by construction.
  //
  // The cost of keying off the GATE rather than the testid — which is what the
  // first attempt was avoiding — is that a broken gate now reds this test too,
  // on top of the gate test that names it. Accepted deliberately: over-reporting
  // is the safe direction, and the alternative is a window that is not the text
  // the assertions read, which is the bug being fixed. Verified by mutation:
  // re-pointing the critical gate goes 4/3 with both tests naming the gate.
  for (const [name, gate, testid] of [
    ["critical", CRITICAL_BANNER_GATE, 'data-testid="data-source-issue-banner"'],
    ["partial", PARTIAL_BANNER_GATE, 'data-testid="engine-degraded-banner"'],
  ]) {
    assert.notEqual(SHELL.indexOf(testid), -1, `${testid} is gone from the component`);
    const block = blockGovernedBy(gate);
    assert.ok(block, `the ${name} banner's gate \`${gate}\` did not resolve to a JSX block`);
    assert.ok(
      block.includes(testid),
      `the ${name} gate does not govern ${testid} — this comment check would be scanning the wrong text`
    );
    assert.ok(
      !block.includes("/*") && !block.includes("//"),
      `a comment survived stripping around ${testid} — evasion A is open again`
    );
  }
});

test("R2.2.6 GUARD — DashboardShell derives its degradation state from the pipeline", () => {
  assert.match(
    SHELL,
    /import \{ describeScanDataSourceIssue \} from "@\/shared\/scoring\/enginePipeline"/,
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
    // WHAT "RENDERS" MEANS HERE, MADE MECHANICAL. `block.includes(token)` was
    // the first R2.2.7 attempt's version of this, and it is satisfied by text
    // that renders nothing: the verifier gutted both real renders to generic
    // literals and added, inside this same block and with no comment marker,
    //   <span data-note="{scanHealth.title} {scanHealth.detail}" />
    // for 7 pass / 0 fail. So the token must appear in JSX CHILD POSITION —
    // between a `>` and a `<` — in text whose comments are stripped AND whose
    // quoted bodies are blanked. Five non-rendering vehicles were measured red
    // against this pair, each alone: the quoted attribute above; the same
    // quoted value SHAPED as `"> {scanHealth.title} <"` to imitate child
    // position, and its single-quoted twin `title={'> … <'}`, which was green
    // until `'` became a delimiter in this pass (blanking kills those two, not
    // the shape check); `aria-label={scanHealth.title}`, an unquoted attribute
    // expression that puts no engine name in the headline (the shape check
    // kills that one, not blanking); and a template literal, which renders the
    // braces rather than the value. Neither half subsumes the other — each was
    // sabotaged alone and the other half let the matching vehicle through.
    const renderedScan = renderedScanOf(block);
    const rendered = renderedScan.text;
    // A delimiter left open means the blanking pass ran off the end of a span
    // and blanked the rest of the block — the two assertions below would then
    // go red for a reason that has nothing to do with the banner. Name it here.
    assert.equal(
      renderedScan.unterminatedQuote,
      null,
      `an unpaired ${renderedScan.unterminatedQuote} inside the ${name} block left the blanking pass inside a string — most likely an apostrophe in new prose, not a broken banner`
    );
    // Under-blanking is the silent direction, so prove blanking ran over THIS
    // text before trusting the two assertions that depend on it: the testid's
    // own value lives inside a double-quoted span and must be gone.
    const testidValue = testid.slice('data-testid="'.length, -1);
    assert.ok(
      rendered.includes('data-testid="') && !rendered.includes(testidValue),
      `quoted bodies were not blanked over the ${name} block — the two assertions after this one would accept a token parked in an attribute value`
    );
    assert.match(
      rendered,
      />\s*\{scanHealth\.title\}\s*</,
      `the ${name} banner must RENDER {scanHealth.title} as its own child text — a comment, a quoted attribute value or an attribute expression names no engine on screen`
    );
    assert.match(
      rendered,
      />\s*\{scanHealth\.detail\}\s*</,
      `the ${name} banner must RENDER {scanHealth.detail} as its own child text — the reason has to be on screen, not in an attribute`
    );
  }
  // No third, dead copy elsewhere in the file to confuse the next reader. This
  // one is a COUNT over the whole component: it proves the absence of extra
  // copies, NOT that either copy renders. That is the per-block pair above.
  assert.equal(
    (SHELL.match(/\{scanHealth\.title\}/g) || []).length,
    2,
    "the headline token must appear exactly twice — once per banner, with no third dead copy elsewhere"
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

// ---------------------------------------------------------------------------
// R2.2.7 — EXECUTION HARNESS & BEHAVIORAL CLAIMS
// Harness derived from engineSetChangeSurface.test.mjs:136-213 and
// scoreBandEngineChips.test.mjs:133-180.
// ---------------------------------------------------------------------------

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

async function loadJsx(filePath, requireShim, ReactImpl) {
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
  factory(requireShim, moduleRecord, moduleRecord.exports, ReactImpl);
  return moduleRecord.exports;
}

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
 * Render the REAL DashboardShell with the REAL ScoreBand, based on
 * engineSetChangeSurface.test.mjs:136-213 and scoreBandEngineChips.test.mjs:133-180.
 */
async function renderDashboardShell(props) {
  const scoreBandModule = { ...(await loadScoreBand()), __esModule: true };

  const patchedReact = { ...React, useEffect: makeUseEffectShim(), __esModule: true };
  patchedReact.default = patchedReact;

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
    ["@/shared/api", apiStub],
    ["@/shared/format", formatModule],
    ["@/shared/scoring/aliases", aliasesModule],
    ["@/shared/scoring/brandKey", brandKeyModule],
    ["@/shared/scoring/aioConstants", aioConstantsModule],
    ["@/shared/scoring/enginePipeline", enginePipelineModule],
  ]);

  const requireShim = (specifier) => {
    if (modules.has(specifier)) return modules.get(specifier);
    if (specifier.startsWith("@/components/") || specifier.startsWith("@/server/") || specifier.startsWith("@/shared/")) {
      return anyNamedExport;
    }
    throw new Error(
      `DashboardShell imports "${specifier}", which this render harness does not resolve.`
    );
  };

  const shellModule = await loadJsx(SHELL_PATH, requireShim, patchedReact);
  const Shell = shellModule.default;
  assert.equal(
    typeof Shell,
    "function",
    "DashboardShell.jsx must still default-export a component for this harness to render"
  );

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

function storedScanRow(engines, { enginesCounted = 1, visibilityIndexPct = 50 } = {}) {
  const summary_stats = {
    visibility_pct: 50,
    mention_rate_pct: 50,
    non_branded_queries: 10,
    non_branded_with_aio: 10,
    visible_non_branded: 2,
    aio_coverage_pct: 100,
    error_rate_pct: 0,
    data_source_issue: enginesCounted === 0,
    insufficient_sample: false,
  };
  return {
    id: "scan-degraded-engine",
    brand: "Acme",
    url: "acme.com",
    scanned_at: "2026-09-01T10:00:00.000Z",
    visibility_pct: 50,
    prompts_tracked: 10,
    prompts_mentioned: 2,
    competitors: [],
    results: [],
    raw_results: {
      results: [],
      summary_stats,
      engines_counted: enginesCounted,
      visibility_index_pct: visibilityIndexPct,
      engines,
      scoring_version: "v7-multi-engine",
      prompt_set_id: "acme.com:v1",
    },
  };
}

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

test("R2.2.7 EXECUTION — the critical banner renders and names the degraded engine", async () => {
  // Proven by execution with react-dom/server (engineSetChangeSurface.test.mjs:136-213):
  // When all engines degrade, the critical banner renders and explicitly names the
  // degraded engines, while ScoreBand and the partial banner are suppressed.
  const criticalEngines = {
    aio: summarizeEngineSlice(
      [...Array.from({ length: 10 }, (_, i) => empty(100 + i))],
      "aio"
    ),
    perplexity: summarizeEngineSlice(
      [
        ...Array.from({ length: 4 }, (_, i) => answered(200 + i, true)),
        ...Array.from({ length: 6 }, (_, i) => empty(300 + i)),
      ],
      "perplexity"
    ),
  };

  const html = await renderDashboardShell({
    scan: storedScanRow(criticalEngines, { enginesCounted: 0, visibilityIndexPct: null }),
  });
  const text = textOf(html);

  assert.ok(
    html.includes('data-testid="data-source-issue-banner"'),
    "critical scan must mount the data-source-issue-banner"
  );
  assert.ok(
    html.includes('data-testid="dashboard-unreliable-placeholder"'),
    "critical scan must mount the placeholder replacing the views"
  );
  assert.ok(
    !html.includes('data-testid="engine-degraded-banner"'),
    "critical scan must not mount the partial-read banner"
  );
  assert.ok(
    !html.includes('data-testid="score-band"'),
    "critical scan must suppress ScoreBand"
  );

  // Behavioral claim 1: the critical banner MUST name the degraded engines.
  assert.match(
    text,
    /Google AI Overview and Perplexity degraded — no engine left to score/,
    "the critical banner headline must name the degraded engines"
  );
  assert.match(
    text,
    /Google AI Overview answered 0 of 10 tracked prompts/,
    "the banner detail must describe why Google AI Overview was condemned"
  );
  assert.match(
    text,
    /Perplexity answered 4 of 10 tracked prompts/,
    "the banner detail must describe why Perplexity was condemned"
  );
});

test("R2.2.7 EXECUTION — partial degradation shows the index number and suppresses placeholder", async () => {
  // Proven by execution with react-dom/server (engineSetChangeSurface.test.mjs:136-213):
  // When one engine degrades in a multi-engine scan, the partial banner renders,
  // the ScoreBand renders the AI Visibility Index number, and the unreliable placeholder
  // is suppressed.
  const partialEngines = {
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

  const html = await renderDashboardShell({
    scan: storedScanRow(partialEngines, { enginesCounted: 1, visibilityIndexPct: 42 }),
  });
  const text = textOf(html);

  assert.ok(
    html.includes('data-testid="engine-degraded-banner"'),
    "partial degradation must mount the engine-degraded-banner"
  );
  assert.ok(
    !html.includes('data-testid="data-source-issue-banner"'),
    "partial degradation must NOT mount the critical banner"
  );
  assert.ok(
    !html.includes('data-testid="dashboard-unreliable-placeholder"'),
    "partial degradation must NOT mount the unreliable placeholder"
  );

  // Behavioral claim 2: partial degradation must show the index number while suppressing placeholder.
  assert.ok(
    html.includes(">42<") && text.includes("42 %"),
    "partial degradation must show the AI Visibility Index number in ScoreBand"
  );
  assert.ok(
    text.includes("AI Visibility Index"),
    "multi-engine scan must label the hero score as AI Visibility Index"
  );
  assert.match(
    text,
    /Perplexity degraded — the index counts 1 of 2 engines/,
    "partial banner must name the degraded engine and count"
  );
});

test("R2.2.6 — the strings the guard proves are rendered are non-empty for the real case", () => {
  // The RUN half, kept beside the guard so this file is not only assertions
  // about text. Healthy aio + a perplexity slice answering 6 of 10.

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
