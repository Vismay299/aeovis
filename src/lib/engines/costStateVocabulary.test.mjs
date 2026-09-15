/**
 * R3.6.5 — the three COST_STATE copies must not drift.
 *
 * The vocabulary ("measured" vs. four ways of not having measured) is declared
 * three times: src/lib/engines/openai.js (R3.6.6, the original), src/lib/gemini.js
 * and src/lib/engines/perplexity.js (both R3.6.5). It is duplicated rather than
 * shared because its natural home, src/lib/llmPricing.js, was owned by another
 * task while R3.6.5 was built.
 *
 * Duplicated constants drift, and a drifted one is invisible: a row tagged
 * "unpriced" by one engine and "not_priced" by another silently splits every
 * dashboard filter that groups on it. So the copies are pinned to each other
 * here until one of them is hoisted, at which point this file collapses to an
 * import check.
 *
 * No vendor calls: this reads exported constants only.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { COST_STATE as OPENAI_COST_STATE } from "./openai.js";
import { COST_STATE as PERPLEXITY_COST_STATE } from "./perplexity.js";
import { COST_STATE as GEMINI_LIB_COST_STATE } from "../gemini.js";
import { COST_STATE as GEMINI_ADAPTER_COST_STATE } from "./gemini.js";

test("all three COST_STATE declarations are the same vocabulary", () => {
  assert.deepEqual(
    GEMINI_LIB_COST_STATE,
    OPENAI_COST_STATE,
    "src/lib/gemini.js's COST_STATE has drifted from src/lib/engines/openai.js's"
  );
  assert.deepEqual(
    PERPLEXITY_COST_STATE,
    OPENAI_COST_STATE,
    "src/lib/engines/perplexity.js's COST_STATE has drifted from src/lib/engines/openai.js's"
  );
});

test("the gemini adapter re-exports the library's copy rather than making a fourth", () => {
  assert.equal(
    GEMINI_ADAPTER_COST_STATE,
    GEMINI_LIB_COST_STATE,
    "src/lib/engines/gemini.js must re-export src/lib/gemini.js's COST_STATE, not redeclare it"
  );
});

test("every COST_STATE is frozen and names exactly one measured state", () => {
  for (const [name, states] of [
    ["openai", OPENAI_COST_STATE],
    ["gemini", GEMINI_LIB_COST_STATE],
    ["perplexity", PERPLEXITY_COST_STATE],
  ]) {
    assert.ok(Object.isFrozen(states), `${name}: COST_STATE must be frozen`);
    assert.equal(states.MEASURED, "measured", `${name}: the measured state is the only priced one`);
    assert.deepEqual(
      Object.values(states).sort(),
      ["measured", "not_configured", "probe_failed", "unmeasured_tokens", "unpriced"],
      `${name}: the four non-measured states are what keep a skip from reading as a $0`
    );
  }
});
