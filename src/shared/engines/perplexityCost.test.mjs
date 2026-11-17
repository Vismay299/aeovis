/**
 * R3.6.5 — no Perplexity probe may report a cost nobody measured.
 *
 * WHAT SHIPPED, reproduced against the pre-fix code with a stubbed fetch:
 *
 *   - the answer leg ended `?? 0.005`. A completion with no `usage` block —
 *     every completion on a plan that does not itemise spend — reported $0.005
 *     as though Perplexity had said so.
 *   - the search leg returned the literal `cost: 0.005` on every success. Not
 *     even a fallback: /search returns no usage block to fall back FROM, so the
 *     number had nothing behind it at all.
 *   - both legs returned `cost: 0` when they FAILED, so a 401 from a revoked key
 *     was recorded as a successful call that happened to be free.
 *
 *   A probe of an unconfigured-for-billing deployment therefore reported exactly
 *   $0.01 of "spend" per prompt and accumulated it into stats.cost, which becomes
 *   cost_total on the scan row.
 *
 * Every test stubs globalThis.fetch. No live Perplexity call is made and the only
 * key value used is a literal test string.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  probePerplexity,
  COST_STATE,
  getPerplexityModel,
  DEFAULT_PERPLEXITY_MODEL,
  PERPLEXITY_SEARCH_TOOL,
} from "./perplexity.js";
import { resetUnpricedAlerts } from "../llmPricing.js";

const TEST_KEY = "test-key-never-sent-anywhere";
const ENV_KEYS = ["PERPLEXITY_API_KEY", "PERPLEXITY_MODEL", "LLM_MODEL_PRICES", "LLM_TOOL_FEES"];

/**
 * @param {{answer?: object|function, search?: object|function, env?: object}} opts
 */
async function withPerplexity({ answer, search, env = {} }, fn) {
  const originalFetch = globalThis.fetch;
  const saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.PERPLEXITY_API_KEY = TEST_KEY;
  delete process.env.PERPLEXITY_MODEL;
  delete process.env.LLM_MODEL_PRICES;
  delete process.env.LLM_TOOL_FEES;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }

  const calls = { answer: 0, search: 0, bodies: [] };
  globalThis.fetch = async (url, init) => {
    const leg = String(url).includes("/chat/completions") ? "answer" : "search";
    calls[leg] += 1;
    calls.bodies.push({ leg, body: JSON.parse(init.body) });
    const stub = leg === "answer" ? answer : search;
    if (typeof stub === "function") return stub();
    return stub ?? { ok: true, json: async () => ({}) };
  };
  resetUnpricedAlerts();
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetUnpricedAlerts();
  }
}

const answerOk = (usage) => ({
  ok: true,
  json: async () => ({
    choices: [{ message: { content: "HubSpot and Zoho are top CRM options." } }],
    ...(usage ? { usage } : {}),
  }),
});

const searchOk = {
  ok: true,
  json: async () => ({ results: [{ url: "https://www.hubspot.com/crm", title: "HubSpot CRM" }] }),
};

const httpFail = (status) => ({ ok: false, status, text: async () => `HTTP ${status}` });

// ---------------------------------------------------------------------------
// The `?? 0.005` and the flat 0.005
// ---------------------------------------------------------------------------

test("a completion with NO usage block reports cost null — the 0.005 guess is gone", async () => {
  await withPerplexity({ answer: answerOk(null), search: searchOk }, async () => {
    const stats = { cost: 0, tokens: 0 };
    const res = await probePerplexity("best crm for small business", { stats });

    assert.equal(res.text, "HubSpot and Zoho are top CRM options.", "the answer is still measured");
    assert.equal(res.citations.length, 1, "and so are the citations");
    assert.equal(res.cost, null, "a cost nobody reported must be null, not 0.005 and not 0");
    assert.notEqual(res.cost, 0.005, "the hardcoded guess must not survive anywhere");
    assert.equal(res.cost_state, COST_STATE.UNPRICED);
    // Asserted per LEG, not just on the total: a guess reinstated on the answer
    // leg alone would still leave the total null (the search leg is unpriced
    // here too) and would slip past an assertion that only reads `res.cost`.
    assert.match(
      res.cost_state_detail || "",
      /answer: unpriced/,
      "the answer leg itself must report no price — not `?? 0.005` behind a null total"
    );
    assert.doesNotMatch(
      res.cost_state_detail || "",
      /answer: measured/,
      "nothing was reported, so nothing on this leg was measured"
    );
    assert.equal(stats.cost, 0, "stats.cost must not move — this is what became cost_total");
    assert.equal(stats.cost_unmeasured_calls, 1, "the unpriced probe is COUNTED, not ignored");
  });
});

test("a fully successful probe with nothing priced still reports no spend at all", async () => {
  // The exact pre-fix reproduction: both legs 200, no usage anywhere, and the
  // old code reported 0.005 + 0.005 = 0.01 of measured spend per prompt.
  await withPerplexity({ answer: answerOk(null), search: searchOk }, async () => {
    const res = await probePerplexity("q");
    assert.notEqual(res.cost, 0.01, "two invented halves must not sum to an invented total");
    assert.equal(res.cost, null);
    assert.equal(res.error, null, "the probe itself succeeded — only its price is unknown");
  });
});

test("a REPORTED usage.cost.total_cost is kept as gateway spend", async () => {
  await withPerplexity(
    {
      answer: answerOk({ prompt_tokens: 50, completion_tokens: 30, cost: { total_cost: 0.0071 } }),
      search: searchOk,
      env: { LLM_TOOL_FEES: JSON.stringify({ sonar: { search: 0.005 } }) },
    },
    async () => {
      const stats = { cost: 0, tokens: 0 };
      const res = await probePerplexity("q", { stats });
      assert.ok(Math.abs(res.cost - 0.0121) < 1e-12, `expected 0.0071 + 0.005, got ${res.cost}`);
      assert.equal(res.cost_state, COST_STATE.MEASURED);
      assert.equal(res.cost_source, "gateway+tool_price_table");
      assert.ok(Math.abs(stats.cost - 0.0121) < 1e-12, "a measured total DOES accrue");
      assert.equal(stats.tokens, 80);
      assert.equal(stats.cost_unmeasured_calls, undefined);
    }
  );
});

test("a flat usage.total_cost is also a real measurement", async () => {
  await withPerplexity(
    {
      answer: answerOk({ prompt_tokens: 1, completion_tokens: 1, total_cost: 0.002 }),
      search: searchOk,
      env: { LLM_TOOL_FEES: JSON.stringify({ sonar: { search: 0 } }) },
    },
    async () => {
      const res = await probePerplexity("q");
      assert.equal(res.cost, 0.002);
      assert.equal(res.cost_state, COST_STATE.MEASURED);
    }
  );
});

test("a reported cost of exactly 0 is a MEASURED zero, not an unpriced one", async () => {
  await withPerplexity(
    {
      answer: answerOk({ prompt_tokens: 5, completion_tokens: 5, total_cost: 0 }),
      search: searchOk,
      env: { LLM_TOOL_FEES: JSON.stringify({ sonar: { search: 0 } }) },
    },
    async () => {
      const res = await probePerplexity("q");
      assert.equal(res.cost, 0);
      assert.equal(
        res.cost_state,
        COST_STATE.MEASURED,
        "a vendor that says 'this was free' is different from a vendor that says nothing"
      );
    }
  );
});

test("tokens x a declared rate prices the answer leg when no cost is echoed", async () => {
  await withPerplexity(
    {
      answer: answerOk({ prompt_tokens: 1000, completion_tokens: 1000 }),
      search: searchOk,
      env: {
        LLM_MODEL_PRICES: JSON.stringify({ sonar: { input: 1, output: 1 } }),
        LLM_TOOL_FEES: JSON.stringify({ sonar: { search: 0.005 } }),
      },
    },
    async () => {
      const res = await probePerplexity("q");
      assert.ok(Math.abs(res.cost - 0.007) < 1e-12, `expected 0.001 + 0.001 + 0.005, got ${res.cost}`);
      assert.equal(res.cost_source, "price_table+tool_price_table");
      assert.equal(res.cost_state, COST_STATE.MEASURED);
    }
  );
});

test("the /search leg is priced PER CALL from the tool-fee table, never from a literal", async () => {
  await withPerplexity(
    {
      answer: answerOk({ total_cost: 0 }),
      search: searchOk,
      env: { LLM_TOOL_FEES: JSON.stringify({ sonar: { search: 0.0125 } }) },
    },
    async () => {
      const res = await probePerplexity("q");
      assert.equal(res.cost, 0.0125, "the declared fee is used verbatim — no 0.005 anywhere");
      assert.equal(res.cost_state, COST_STATE.MEASURED);
    }
  );
});

test("an answer leg that is priced but a search leg that is not yields NO total", async () => {
  await withPerplexity(
    {
      answer: answerOk({ total_cost: 0.0071 }),
      search: searchOk,
      env: { LLM_TOOL_FEES: undefined },
    },
    async () => {
      const stats = { cost: 0 };
      const res = await probePerplexity("q", { stats });
      assert.equal(
        res.cost,
        null,
        "a partial sum is an understated total wearing the type of an honest one"
      );
      assert.notEqual(res.cost, 0.0071);
      assert.equal(res.cost_state, COST_STATE.UNPRICED);
      assert.match(res.cost_state_detail || "", /answer: measured 0\.0071/, "the measured leg is still named");
      assert.match(res.cost_state_detail || "", /search: unpriced/, "and so is the one that is not");
      assert.equal(stats.cost, 0);
      assert.equal(stats.cost_unmeasured_calls, 1);
    }
  );
});

// ---------------------------------------------------------------------------
// The failures that read as free successes
// ---------------------------------------------------------------------------

test("a 401 on both legs reports cost null, not a measured $0", async () => {
  await withPerplexity({ answer: httpFail(401), search: httpFail(401) }, async () => {
    const stats = { cost: 0 };
    const res = await probePerplexity("q", { stats });
    assert.ok(res.error, "the failure is still surfaced");
    assert.equal(res.cost, null, "the pre-fix code returned cost: 0 here — a refused call, billed as free");
    assert.equal(res.cost_state, COST_STATE.PROBE_FAILED);
    assert.match(res.cost_state_detail || "", /answer: probe_failed/);
    assert.equal(stats.cost, 0);
    assert.equal(stats.cost_unmeasured_calls, 1);
  });
});

test("a dead /search leg alone still voids the TOTAL, while the answer's own price survives in the detail", async () => {
  await withPerplexity(
    {
      answer: answerOk({ total_cost: 0.004 }),
      search: httpFail(500),
      env: { LLM_TOOL_FEES: JSON.stringify({ sonar: { search: 0.005 } }) },
    },
    async () => {
      const res = await probePerplexity("q");
      assert.equal(res.error, null, "a dead search leg is not the probe's error (R2.2.2)");
      assert.equal(res.cost, null, "but it does mean the probe's cost was not fully measured");
      assert.equal(res.cost_state, COST_STATE.PROBE_FAILED);
      assert.match(res.cost_state_detail || "", /answer: measured 0\.004/);
      assert.match(res.cost_state_detail || "", /search: probe_failed/);
    }
  );
});

test("a missing PERPLEXITY_API_KEY is not_configured, not a $0 probe", async () => {
  const saved = process.env.PERPLEXITY_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  try {
    const stats = { cost: 0 };
    const res = await probePerplexity("q", { stats });
    assert.equal(res.cost, null, "nothing was called, so nothing was spent OR measured");
    assert.equal(res.cost_state, COST_STATE.NOT_CONFIGURED);
    assert.equal(stats.cost, 0);
    assert.equal(stats.cost_unmeasured_calls, 1);
  } finally {
    if (saved === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = saved;
  }
});

// ---------------------------------------------------------------------------
// The model id that is priced must be the model id that is sent
// ---------------------------------------------------------------------------

test("getPerplexityModel reads PERPLEXITY_MODEL per call, not at import", () => {
  assert.equal(getPerplexityModel({}), DEFAULT_PERPLEXITY_MODEL);
  assert.equal(getPerplexityModel({ PERPLEXITY_MODEL: "sonar-pro" }), "sonar-pro");
  assert.equal(getPerplexityModel({ PERPLEXITY_MODEL: "  " }), DEFAULT_PERPLEXITY_MODEL);
});

test("the model priced is the model SENT — a rate for the default does not price an override", async () => {
  await withPerplexity(
    {
      answer: answerOk({ prompt_tokens: 1000, completion_tokens: 0 }),
      search: searchOk,
      env: {
        PERPLEXITY_MODEL: "sonar-pro",
        // A rate for the DEFAULT id only.
        LLM_MODEL_PRICES: JSON.stringify({ sonar: { input: 1, output: 1 } }),
        LLM_TOOL_FEES: JSON.stringify({ sonar: { search: 0.005 } }),
      },
    },
    async (calls) => {
      const res = await probePerplexity("q");
      assert.equal(
        calls.bodies.find((b) => b.leg === "answer").body.model,
        "sonar-pro",
        "the override is what goes on the wire"
      );
      assert.equal(
        res.cost,
        null,
        "so sonar's rate must NOT price it — a module-level snapshot would have"
      );
      assert.equal(res.cost_state, COST_STATE.UNPRICED);
      assert.match(res.cost_state_detail || "", /sonar-pro/);
    }
  );
});

test("an override with its own declared rate and fee prices normally", async () => {
  await withPerplexity(
    {
      answer: answerOk({ prompt_tokens: 1000, completion_tokens: 0 }),
      search: searchOk,
      env: {
        PERPLEXITY_MODEL: "sonar-pro",
        LLM_MODEL_PRICES: JSON.stringify({ "sonar-pro": { input: 3, output: 15 } }),
        LLM_TOOL_FEES: JSON.stringify({ "sonar-pro": { [PERPLEXITY_SEARCH_TOOL]: 0.008 } }),
      },
    },
    async () => {
      const res = await probePerplexity("q");
      assert.ok(Math.abs(res.cost - 0.011) < 1e-12, `expected 0.003 + 0.008, got ${res.cost}`);
      assert.equal(res.cost_state, COST_STATE.MEASURED);
    }
  );
});

test("a priced model with no reported tokens is unmeasured_tokens, not a zero-token bill", async () => {
  await withPerplexity(
    {
      answer: answerOk(null),
      search: searchOk,
      env: {
        LLM_MODEL_PRICES: JSON.stringify({ sonar: { input: 1, output: 1 } }),
        LLM_TOOL_FEES: JSON.stringify({ sonar: { search: 0.005 } }),
      },
    },
    async () => {
      const res = await probePerplexity("q");
      assert.equal(res.cost, null);
      assert.equal(res.cost_state, COST_STATE.UNMEASURED_TOKENS);
      assert.match(res.cost_state_detail || "", /answer: unmeasured_tokens/);
    }
  );
});

// ---------------------------------------------------------------------------
// R2.2.10 / R2.2.2 must be untouched by all of the above.
// ---------------------------------------------------------------------------

test("pricing did not disturb the retry policy: a 401 answer leg still costs exactly one call", async () => {
  await withPerplexity({ answer: httpFail(401), search: searchOk }, async (calls) => {
    await probePerplexity("q");
    assert.equal(calls.answer, 1, "a permanent refusal is not retried (R2.2.10)");
  });
});

test("pricing did not disturb citations_state: a dead search leg is still UNVERIFIED", async () => {
  await withPerplexity({ answer: answerOk({ total_cost: 0.001 }), search: httpFail(500) }, async () => {
    const res = await probePerplexity("q");
    assert.equal(res.citations_state, "unverified");
    assert.equal(res.citations_state_reason, "search_leg_failed");
  });
});
