import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transform } from "sucrase";

import { ENGINE_MEASUREMENT_STATE } from "../../lib/scoring/enginePipeline.js";

/**
 * R2.1.2 — an engine chip may not print a machine token at a customer.
 *
 * THE BUG, found by the R2.7.8 verifier. R2.1.1 froze a four-token engine
 * state vocabulary (`ENGINE_MEASUREMENT_STATE`: measured, measured_zero,
 * not_assessed, failed) and DashboardShell.jsx:548 puts `summary.state` on the
 * chip verbatim. ScoreBand's MEASURED_STATES allowlist contains `measured` but
 * not `measured_zero`, so the chip took the "state this build does not
 * recognise — print it as it arrived" branch and a real scan rendered
 *
 *     AI Overview 0% · measured_zero
 *
 * — a snake_case identifier on the headline panel of a paying customer's
 * dashboard. `not_assessed` did the same on the unmeasured branch.
 *
 * THE FIX, and the choice inside it: the tokens are MAPPED to words, not added
 * to the allowlist. Allowlisting `measured_zero` would have deleted the marker
 * instead of translating it, and a measured zero that renders identically to an
 * ordinary reading is standing rule 1 — a measured zero must look different
 * from "we never got a number". So the chip keeps its marker and the marker is
 * readable.
 *
 * WHAT THIS FILE CANNOT PROVE, said rather than implied: this is
 * `renderToStaticMarkup`. It shows which words and attributes reach the DOM,
 * not that a reader can see them or that the chip row wraps legibly. There is
 * no visual-regression harness in this repo (R6.4.11).
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCORE_BAND_PATH = path.join(HERE, "ScoreBand.jsx");

/** ScoreBand.jsx imports nothing, so the require shim exists only to say so. */
async function loadScoreBand() {
  const source = await readFile(SCORE_BAND_PATH, "utf8");
  const { code } = transform(source, {
    transforms: ["jsx", "imports"],
    jsxPragma: "React.createElement",
    jsxFragmentPragma: "React.Fragment",
    filePath: SCORE_BAND_PATH,
  });
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  const factory = new Function("require", "module", "exports", "React", code);
  factory(
    (specifier) => {
      throw new Error(`ScoreBand.jsx unexpectedly imports "${specifier}"`);
    },
    module,
    module.exports,
    React
  );
  return module.exports;
}

const textOf = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

/** Anything that looks like an identifier rather than English. */
const MACHINE_TOKEN = /\b[a-z0-9]+_[a-z0-9_]+\b/;

test("R2.1.2 ACCEPT — no state token from R2.1.1's frozen vocabulary reaches the screen raw", async () => {
  const { describeEngineChip } = await loadScoreBand();
  const tokens = Object.values(ENGINE_MEASUREMENT_STATE);

  // Teeth: if the vocabulary stops containing an underscored token this test
  // is asserting nothing, and the defect it guards has simply moved.
  assert.ok(
    tokens.some((t) => MACHINE_TOKEN.test(t)),
    "ENGINE_MEASUREMENT_STATE no longer contains a snake_case token — this guard has gone vacuous"
  );

  for (const token of tokens) {
    // Both branches of the formatter: a state can arrive on a chip that has a
    // number (measured_zero does) and on one that does not (not_assessed does).
    for (const value of [0, 42, null]) {
      const chip = describeEngineChip({ label: "AI Overview", value, state: token });
      if (chip.state === null) continue; // suppressed as a normal measurement
      assert.ok(
        !MACHINE_TOKEN.test(chip.state),
        `state "${token}" on a chip with value ${value} rendered as the raw token "${chip.state}"`
      );
    }
  }
});

test("R2.1.2 — a measured zero keeps its number AND a readable marker", async () => {
  const { describeEngineChip } = await loadScoreBand();
  const chip = describeEngineChip({
    label: "AI Overview",
    value: 0,
    state: ENGINE_MEASUREMENT_STATE.MEASURED_ZERO,
    stateReason: "brand_not_visible",
  });

  assert.equal(chip.value, "0%", "a measured zero is a measurement and keeps its percent sign");
  assert.equal(chip.measured, true);
  assert.equal(chip.state, "measured zero");
  assert.equal(
    chip.stateToken,
    "measured_zero",
    "the raw token stays available for the DOM attribute — translating it must not cost machine-readability"
  );

  // It must NOT have been allowlisted into silence.
  assert.notEqual(
    chip.state,
    null,
    "a measured zero with no marker is indistinguishable from an ordinary reading (standing rule 1)"
  );
  const ordinary = describeEngineChip({
    label: "AI Overview",
    value: 40,
    state: ENGINE_MEASUREMENT_STATE.MEASURED,
  });
  assert.equal(ordinary.state, null, "...while an ordinary measurement still carries no noise");
});

test("R2.1.2 — the unmeasured states read as English too", async () => {
  const { describeEngineChip } = await loadScoreBand();

  const notAssessed = describeEngineChip({
    label: "Perplexity",
    value: null,
    state: ENGINE_MEASUREMENT_STATE.NOT_ASSESSED,
    stateReason: "empty_eliciting_pool",
  });
  assert.equal(notAssessed.value, "—");
  assert.equal(notAssessed.state, "not assessed");
  assert.equal(notAssessed.stateToken, "not_assessed");

  const failed = describeEngineChip({
    label: "Perplexity",
    value: null,
    state: ENGINE_MEASUREMENT_STATE.FAILED,
  });
  assert.equal(failed.value, "—");
  assert.equal(failed.state, "reading not trusted");
  assert.equal(failed.stateToken, "failed");
});

test("R2.1.2 — a token this build has never seen still reaches the screen unaltered", async () => {
  const { describeEngineChip } = await loadScoreBand();

  // The pre-existing contract (R2.7.8): an unfamiliar vocabulary must be shown,
  // not swallowed. Generic underscore-stripping would have rewritten it.
  const unknown = describeEngineChip({
    label: "Perplexity",
    value: null,
    state: "engine_unavailable",
  });
  assert.equal(unknown.state, "engine_unavailable", "an unknown token is printed as it arrived");

  // `unavailable` (shareOfVoice.js's SHARE_STATE) is already English and has no
  // mapping entry on purpose — a self-mapping would be a dead line.
  assert.equal(
    describeEngineChip({ label: "X", value: null, state: "unavailable" }).state,
    "unavailable"
  );

  // A state still cannot manufacture a percent sign.
  assert.equal(unknown.value, "—");
});

test("R2.1.2 RENDERED — the headline row shows words, and the DOM keeps the token", async () => {
  const { ScoreBand } = await loadScoreBand();
  const html = renderToStaticMarkup(
    React.createElement(ScoreBand, {
      score: 0,
      engineChips: [
        {
          key: "aio",
          label: "AI Overview",
          value: 0,
          state: ENGINE_MEASUREMENT_STATE.MEASURED_ZERO,
          stateReason: "the answers named vendors on every count, and never this brand",
        },
        {
          key: "pplx",
          label: "Perplexity",
          value: null,
          state: ENGINE_MEASUREMENT_STATE.NOT_ASSESSED,
          stateReason: "no answer named any vendor",
        },
      ],
    })
  );
  const text = textOf(html);

  assert.ok(text.includes("AI Overview 0%"), "the measured zero keeps its number");
  assert.ok(text.includes("measured zero"), "...and says so in words");
  assert.ok(text.includes("Perplexity —"), "the unmeasured engine is an em dash");
  assert.ok(text.includes("not assessed"), "...with a readable state beside it");
  assert.ok(
    !MACHINE_TOKEN.test(text),
    `a machine token reached the rendered text: ${text}`
  );

  // The attribute is what a test or a support engineer keys off, so it keeps
  // the producer's token rather than the translation.
  assert.ok(
    html.includes('data-engine-chip-state="measured_zero"'),
    "the raw state must survive into the DOM attribute"
  );
  assert.ok(html.includes('data-engine-chip-state="not_assessed"'));
  assert.ok(html.includes('data-engine-measured="true"'), "a measured zero is measured");
  assert.ok(html.includes('data-engine-measured="false"'), "...and not-assessed is not");
});
