/**
 * R3.6.5 — no Gemini call may report a cost nobody measured.
 *
 * THE THREE THINGS THAT SHIPPED, reproduced against the pre-fix code by driving
 * the adapter with a stubbed globalThis.fetch:
 *
 *   1. src/shared/engines/gemini.js:24 `cost: res.cost || 0.0`
 *      A response with no `usageMetadata` at all came back as
 *      `{ text: "answer", cost: 0 }` — "Google did not say what this consumed"
 *      recorded in the same field, with the same type, as "this consumed
 *      nothing".
 *
 *   2. src/shared/gemini.js's pricing arithmetic
 *      `(promptTokens * 0.075 + candidatesTokens * 0.30) / 1e6`, hard-coded,
 *      applied to whichever of FIVE ladder rungs answered. 1000 in + 1000 out on
 *      gemini-2.5-flash-lite was banked as $0.000375 and added to stats.cost.
 *      Those rates are the list price of no id in MODEL_FALLBACKS; the flash and
 *      flash-lite tiers differ several-fold and were billed identically.
 *
 *   3. src/shared/engines/gemini.js:29's swallow
 *      Worse than the anchor reads. generateContent did not THROW on a dead
 *      ladder, it RETURNED `{ text: "", model_used: "" }`, so the catch never
 *      ran: a total outage surfaced as
 *      `{ text: "", model_used: "gemini", cost: 0, tokens: 0 }` — a free,
 *      successful, empty answer from a model called "gemini".
 *
 * Every test here stubs globalThis.fetch. No live Gemini call is made and the
 * only key value used is a literal test string.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { probeGemini, COST_STATE } from "./gemini.js";
import { resetUnpricedAlerts } from "../llmPricing.js";

const TEST_KEY = "test-key-never-sent-anywhere";

function geminiBody({ text = "an answer", usageMetadata } = {}) {
  const body = {
    candidates: [
      { content: { parts: [{ text }], role: "model" }, finishReason: "STOP", index: 0 },
    ],
  };
  if (usageMetadata) body.usageMetadata = usageMetadata;
  return body;
}

/** Runs `fn` with a stubbed fetch and a restored environment afterwards. */
async function withGemini({ fetch: fetchImpl, env = {} }, fn) {
  const originalFetch = globalThis.fetch;
  const saved = {};
  const keys = ["GEMINI_API_KEY", "LLM_MODEL_PRICES", "LLM_TOOL_FEES"];
  for (const k of keys) saved[k] = process.env[k];
  process.env.GEMINI_API_KEY = TEST_KEY;
  for (const k of keys) {
    if (k in env) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
  }
  globalThis.fetch = fetchImpl;
  resetUnpricedAlerts();
  try {
    return await fn();
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetUnpricedAlerts();
  }
}

const respond = (body) => async () =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

// ---------------------------------------------------------------------------
// Site 1: an unreported cost
// ---------------------------------------------------------------------------

test("a Gemini answer with NO usageMetadata reports cost null, not a measured $0", async () => {
  await withGemini({ fetch: respond(geminiBody()), env: { LLM_MODEL_PRICES: undefined } }, async () => {
    const stats = { cost: 0, tokens: 0 };
    const res = await probeGemini("hi", { stats }, 0);

    assert.equal(res.text, "an answer", "the answer itself is still returned");
    assert.equal(res.cost, null, "an unreported cost must be null — `res.cost || 0.0` banked it as $0");
    assert.notEqual(res.cost, 0, "0 and null are different facts here");
    assert.equal(res.cost_source, null);
    assert.notEqual(res.cost_state, COST_STATE.MEASURED);
    assert.equal(stats.cost, 0, "nothing may accrue to the spend total");
    assert.equal(stats.cost_unmeasured_calls, 1, "but the call must be COUNTED as unmeasured");
  });
});

test("a priced model that Gemini reports no tokens for is unmeasured_tokens, not $0", async () => {
  await withGemini(
    {
      fetch: respond(geminiBody()),
      env: { LLM_MODEL_PRICES: JSON.stringify({ "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 } }) },
    },
    async () => {
      const res = await probeGemini("hi", {}, 0);
      assert.equal(res.cost, null);
      assert.equal(
        res.cost_state,
        COST_STATE.UNMEASURED_TOKENS,
        "a rate with no meter cannot produce a cost; it must say so, not multiply by zero"
      );
      assert.match(res.cost_state_detail || "", /no token counts/i);
    }
  );
});

// ---------------------------------------------------------------------------
// Site 2: the hard-coded rate that belonged to no model in the ladder
// ---------------------------------------------------------------------------

test("an unpriced ladder rung refuses to price rather than inheriting a hard-coded rate", async () => {
  await withGemini(
    {
      fetch: respond(
        geminiBody({
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1000, totalTokenCount: 2000 },
        })
      ),
      env: { LLM_MODEL_PRICES: undefined },
    },
    async () => {
      const stats = { cost: 0 };
      const res = await probeGemini("hi", { stats }, 0);

      assert.equal(res.model_used, "gemini-2.5-flash-lite");
      assert.equal(res.tokens, 2000, "tokens were reported, so tokens are still measured");
      assert.equal(
        res.cost,
        null,
        "the old code returned 0.000375 here from rates hard-coded for no id in the ladder"
      );
      assert.equal(res.cost_state, COST_STATE.UNPRICED);
      assert.match(res.cost_state_detail || "", /gemini-2\.5-flash-lite/, "the message names the id it cannot price");
      assert.match(res.cost_state_detail || "", /LLM_MODEL_PRICES/, "and the env var that fixes it");
      assert.equal(stats.cost, 0, "an unpriced call must not move the spend total at all");
      assert.equal(stats.cost_unmeasured_calls, 1);
    }
  );
});

test("a DECLARED rate prices the rung that actually answered, from the price table", async () => {
  await withGemini(
    {
      fetch: respond(
        geminiBody({
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1000, totalTokenCount: 2000 },
        })
      ),
      env: { LLM_MODEL_PRICES: JSON.stringify({ "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 } }) },
    },
    async () => {
      const stats = { cost: 0, tokens: 0 };
      const res = await probeGemini("hi", { stats }, 0);

      // 1000/1e6 * 0.1 + 1000/1e6 * 0.4
      assert.ok(Math.abs(res.cost - 0.0005) < 1e-12, `expected 0.0005, got ${res.cost}`);
      assert.equal(res.cost_source, "price_table");
      assert.equal(res.cost_state, COST_STATE.MEASURED);
      assert.ok(Math.abs(stats.cost - 0.0005) < 1e-12, "a measured cost DOES accrue");
      assert.equal(stats.cost_unmeasured_calls, undefined, "and is not counted as unmeasured");
    }
  );
});

test("the rate is keyed on the rung that answered — a rate for a DIFFERENT rung does not price this one", async () => {
  await withGemini(
    {
      fetch: respond(
        geminiBody({
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1000, totalTokenCount: 2000 },
        })
      ),
      // A rate for the fourth rung only. The first rung answers.
      env: { LLM_MODEL_PRICES: JSON.stringify({ "gemini-2.5-flash": { input: 0.3, output: 2.5 } }) },
    },
    async () => {
      const res = await probeGemini("hi", {}, 0);
      assert.equal(res.model_used, "gemini-2.5-flash-lite");
      assert.equal(
        res.cost,
        null,
        "flash's rate must not be applied to flash-lite: one table row per id, never a nearby one"
      );
      assert.equal(res.cost_state, COST_STATE.UNPRICED);
    }
  );
});

test("a genuinely free ladder rung is a MEASURED zero, distinguishable from an unpriced one", async () => {
  await withGemini(
    {
      fetch: respond(
        geminiBody({
          usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1000, totalTokenCount: 2000 },
        })
      ),
      env: { LLM_MODEL_PRICES: JSON.stringify({ "gemini-2.5-flash-lite": 0 }) },
    },
    async () => {
      const res = await probeGemini("hi", {}, 0);
      assert.equal(res.cost, 0, "a declared rate of zero is a measurement of zero");
      assert.equal(res.cost_state, COST_STATE.MEASURED);
      assert.equal(res.cost_source, "price_table");
    }
  );
});

// ---------------------------------------------------------------------------
// Site 3: the failure that read as a free success
// ---------------------------------------------------------------------------

test("a dead model ladder is loud: cost null, an error, and no plausible model id", async () => {
  await withGemini(
    {
      fetch: async () => {
        throw new TypeError("connect ECONNREFUSED");
      },
    },
    async () => {
      const stats = { cost: 0 };
      const res = await probeGemini("hi", { stats }, 0);

      assert.equal(res.text, "");
      assert.equal(res.cost, null, "the pre-fix adapter returned cost: 0 for a total outage");
      assert.equal(res.cost_state, COST_STATE.PROBE_FAILED);
      assert.ok(res.error, "a failure must carry an error — the old exit returned error-free");
      assert.equal(
        res.model_used,
        null,
        'the old `res.model_used || "gemini"` dressed a dead ladder up as a model named "gemini"'
      );
      assert.equal(stats.cost, 0);
      assert.equal(stats.cost_unmeasured_calls, 1, "a failed probe is counted, not silently dropped");
    }
  );
});

test("a missing GEMINI_API_KEY is a not_configured absence, not a free call", async () => {
  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  try {
    const stats = { cost: 0 };
    const res = await probeGemini("hi", { stats }, 0);
    assert.equal(res.cost, null, "nothing was called, so nothing was spent OR measured");
    assert.equal(res.cost_state, COST_STATE.NOT_CONFIGURED);
    assert.ok(res.error, "a skip is not a success");
    assert.equal(stats.cost, 0);
    assert.equal(stats.cost_unmeasured_calls, 1);
  } finally {
    if (saved === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = saved;
  }
});

test("the four ways of having no cost are four DIFFERENT states, not one shared zero", async () => {
  const states = new Set();

  const saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  states.add((await probeGemini("hi", {}, 0)).cost_state);
  if (saved === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = saved;

  await withGemini(
    { fetch: async () => { throw new TypeError("connect ECONNREFUSED"); } },
    async () => states.add((await probeGemini("hi", {}, 0)).cost_state)
  );
  await withGemini(
    { fetch: respond(geminiBody()), env: { LLM_MODEL_PRICES: undefined } },
    async () => states.add((await probeGemini("hi", {}, 0)).cost_state)
  );
  await withGemini(
    {
      fetch: respond(geminiBody()),
      env: { LLM_MODEL_PRICES: JSON.stringify({ "gemini-2.5-flash-lite": 1 }) },
    },
    async () => states.add((await probeGemini("hi", {}, 0)).cost_state)
  );

  assert.deepEqual(
    [...states].sort(),
    ["not_configured", "probe_failed", "unmeasured_tokens", "unpriced"],
    "all four collapsed to cost: 0 before R3.6.5 — the whole point is that they no longer do"
  );
});
