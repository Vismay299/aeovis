import test from "node:test";
import assert from "node:assert/strict";

import {
  SHARE_STATE,
  NOT_AVAILABLE_LABEL,
  MEASURED_ZERO_LABEL,
  describeShareMetric,
} from "./shareOfVoice.js";

/**
 * describeShareMetric() — the wording half of R2.7.6, kept after R2.7.10.
 *
 * PROVENANCE, so this file's existence is not a mystery. R2.7.6 fixed
 * `src/components/dashboard/ScoreBreakdown.jsx`, which printed a confident "0%"
 * share of voice on every scan (`result.shareOfVoicePct ?? 0`, against a field
 * no pipeline stage persists — R2.7.5). Part of that fix was lifting the
 * "what does a reader see" decision out of the component into this pure
 * function, so the panel and the Overview donut could not drift into two
 * vocabularies about one field. R2.7.10 then established that NO ROUTE ever
 * imported ScoreBreakdown — the component's only consumer was its own test —
 * and retired it. These unit tests moved here, verbatim in substance, rather
 * than being deleted with it: the function is the durable part.
 *
 * DECLARED, not hidden: describeShareMetric() currently has no caller in the
 * rendered app. Donut.jsx answers the same question with its own inline
 * `selfPct == null ? '—' : ...` branch plus a `stateLabel`/`stateDetail` pair,
 * which is the duplication this function was written to end. Unifying them is a
 * change to Donut.jsx and is out of R2.7.10's file scope; it is reported for
 * the controller to file. Until then this is tested, exported and unused, and
 * saying so here is the point — an unused export that looks live is the same
 * class of problem R2.7.10 was filed about.
 *
 * The behaviour under test is the one standing rule 1 and rule 5 demand: a
 * measured zero and a never-computed share must not produce the same output,
 * and nothing may staple a percent sign to a number that does not exist.
 */

test("describeShareMetric never prints a number the resolver did not measure", () => {
  for (const state of [SHARE_STATE.NOT_ASSESSED, SHARE_STATE.UNAVAILABLE]) {
    // A caller handing over a pct alongside a non-measured state is exactly the
    // shape that would resurrect the bug. The state wins.
    const view = describeShareMetric({ state, pct: 0, label: null, detail: null });
    assert.equal(view.value, "—", `${state} must not print a percentage`);
    assert.equal(view.measured, false);
    assert.equal(view.progress, null);
    assert.ok(view.state, "a non-measured share always carries words");
  }
});

test("describeShareMetric marks a measured zero as measured", () => {
  const view = describeShareMetric({ state: SHARE_STATE.MEASURED, pct: 0 });
  assert.equal(view.measured, true);
  assert.equal(view.measuredZero, true);
  assert.equal(view.value, "0.0%");
  assert.equal(view.state, MEASURED_ZERO_LABEL);
  assert.equal(view.progress, 0);
});

test("a measured zero and a never-computed share are distinguishable outputs", () => {
  // The finding, at the level of the function: these two must not be equal.
  const zero = describeShareMetric({ state: SHARE_STATE.MEASURED, pct: 0 });
  const absent = describeShareMetric({
    state: SHARE_STATE.UNAVAILABLE,
    pct: null,
    label: NOT_AVAILABLE_LABEL,
    detail: "No engine in this scan measured a rival roster, so share of voice is undefined for it.",
  });

  assert.notEqual(zero.value, absent.value);
  assert.notEqual(zero.state, absent.state);
  assert.notEqual(zero.measured, absent.measured);
  assert.notEqual(zero.progress, absent.progress);
});

test("describeShareMetric leaves a measured non-zero share unannotated", () => {
  const view = describeShareMetric({ state: SHARE_STATE.MEASURED, pct: 63.2 });
  assert.equal(view.value, "63.2%");
  assert.equal(view.state, null);
  assert.equal(view.measuredZero, false);
});

test("describeShareMetric refuses a non-finite pct even when told it is measured", () => {
  for (const pct of [null, undefined, NaN, Infinity, "40", {}]) {
    const view = describeShareMetric({ state: SHARE_STATE.MEASURED, pct });
    assert.equal(view.measured, false, `pct ${String(pct)} is not a measurement`);
    assert.equal(view.value, "—");
  }
});

test("describeShareMetric names a state it does not recognise instead of swallowing it", () => {
  const view = describeShareMetric({ state: "share_teleported", pct: 12 });
  assert.equal(view.measured, false);
  assert.equal(view.value, "—");
  assert.equal(view.rawState, "share_teleported");
  assert.ok(view.state, "an unknown state still gets human words on screen");
  assert.ok(
    view.detail.includes("share_teleported"),
    "the token must be recoverable from the explanation, not dropped"
  );
  assert.equal(view.reason, "unrecognised_state");
});

test("describeShareMetric survives garbage without inventing a share", () => {
  for (const bad of [null, undefined, 0, "", [], { state: 42 }, { pct: 99 }]) {
    const view = describeShareMetric(bad);
    assert.equal(view.measured, false, `${JSON.stringify(bad)} must not read as measured`);
    assert.equal(view.value, "—");
    assert.ok(view.state);
  }
});

test("the retirement note on shareOfVoice.js is not silently dropped", async () => {
  // R2.7.10's accept requires the close of R2.7.6 to stay honest about what it
  // bought. The note lives in the module doc; deleting it should cost something.
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const source = await readFile(
    fileURLToPath(new URL("./shareOfVoice.js", import.meta.url)),
    "utf8"
  );
  assert.ok(
    source.includes("R2.7.10"),
    "shareOfVoice.js must record that ScoreBreakdown.jsx — describeShareMetric's original " +
      "and only caller, and the file R2.7.6 closed against — was retired"
  );
});
