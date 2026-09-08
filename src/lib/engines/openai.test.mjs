import test from "node:test";
import assert from "node:assert/strict";
import { probeChatGpt, isChatGptConfigured, COST_STATE, getOpenAiModel } from "./openai.js";
import { MODEL_PRICES_ENV, TOOL_FEES_ENV, resetUnpricedAlerts } from "../llmPricing.js";

test("isChatGptConfigured returns false when no key", () => {
  const old = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  assert.equal(isChatGptConfigured(), false);
  if (old) process.env.OPENAI_API_KEY = old;
});

test("isChatGptConfigured returns true when key is set", () => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test";
  assert.equal(isChatGptConfigured(), true);
  if (old) process.env.OPENAI_API_KEY = old;
});

test("probeChatGpt returns error when no API key", async () => {
  const old = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const result = await probeChatGpt("best crm for small business");
  assert.equal(result.text, "");
  assert.equal(result.citations.length, 0);
  assert.ok(result.error);
  if (old) process.env.OPENAI_API_KEY = old;
});

test("probeChatGpt parses response with citations", async () => {
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "sk-test";

  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.model, "gpt-4o-mini");
    assert.ok(body.tools[0].type === "web_search");
    assert.equal(body.input, "best crm for small business");

    return {
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: "HubSpot and Zoho are top CRM options for small businesses.",
                annotations: [
                  { type: "url_citation", url: "https://www.hubspot.com/crm", title: "HubSpot CRM" },
                  { type: "url_citation", url: "https://www.zoho.com/crm/", title: "Zoho CRM" },
                ],
              },
            ],
          },
        ],
        usage: {
          input_tokens: 200,
          output_tokens: 80,
        },
      }),
    };
  };

  const result = await probeChatGpt("best crm for small business");
  assert.equal(result.text, "HubSpot and Zoho are top CRM options for small businesses.");
  assert.deepEqual(result.citations, [
    "https://www.hubspot.com/crm",
    "https://www.zoho.com/crm",
  ]);
  assert.equal(result.references.length, 2);
  assert.equal(result.references[0].href, "https://www.hubspot.com/crm");
  assert.equal(result.references[1].href, "https://www.zoho.com/crm/");
  assert.equal(result.references[0].title, "HubSpot CRM");
  assert.ok(result.cost > 0);
  assert.equal(result.error, null);

  globalThis.fetch = originalFetch;
  delete process.env.OPENAI_API_KEY;
});

test("probeChatGpt handles response with no annotations", async () => {
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "sk-test";

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "I'm not sure about that.", annotations: [] }],
        },
      ],
    }),
  });

  const result = await probeChatGpt("some query");
  assert.equal(result.text, "I'm not sure about that.");
  assert.equal(result.citations.length, 0);
  assert.equal(result.references.length, 0);
  assert.equal(result.error, null);

  globalThis.fetch = originalFetch;
  delete process.env.OPENAI_API_KEY;
});

test("probeChatGpt handles API error", async () => {
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "sk-test";

  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    text: async () => "Unauthorized",
  });

  const result = await probeChatGpt("some query");
  assert.equal(result.text, "");
  assert.equal(result.citations.length, 0);
  assert.ok(result.error);
  assert.ok(result.error.includes("401"));

  globalThis.fetch = originalFetch;
  delete process.env.OPENAI_API_KEY;
});

test("probeChatGpt tracks cost in options.stats", async () => {
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "sk-test";

  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Answer here.", annotations: [] }],
        },
      ],
      usage: { input_tokens: 100, output_tokens: 50 },
    }),
  });

  const stats = { cost: 0, tokens: 0 };
  await probeChatGpt("some query", { stats });
  assert.ok(stats.cost > 0);
  assert.equal(stats.tokens, 150);

  globalThis.fetch = originalFetch;
  delete process.env.OPENAI_API_KEY;
});

test("probeChatGpt retries on 429", async () => {
  const originalFetch = globalThis.fetch;
  process.env.OPENAI_API_KEY = "sk-test";

  let callCount = 0;
  globalThis.fetch = async () => {
    callCount++;
    if (callCount < 3) {
      return { ok: false, status: 429, text: async () => "Rate limited" };
    }
    return {
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Success.", annotations: [] }],
          },
        ],
      }),
    };
  };

  const result = await probeChatGpt("some query");
  assert.equal(result.text, "Success.");
  assert.equal(result.error, null);
  assert.equal(callCount, 3);

  globalThis.fetch = originalFetch;
  delete process.env.OPENAI_API_KEY;
});

/**
 * R3.6.6 — the cost this probe reports is a MEASUREMENT or it is null.
 *
 * The file under test used to open with `let cost = 0.01; // base web_search
 * tool fee` and then add gpt-4o-mini's per-token rates, both hard-coded, while
 * OPENAI_MODEL is env-overridable. Every probe against any other model was
 * therefore priced at gpt-4o-mini's rates and recorded as spend. These tests
 * fail if that constant comes back: restore either hard-coded number and the
 * two "OPENAI_MODEL is overridden" cases below go red, because a hard-coded
 * rate cannot tell which model it is describing.
 */

const COST_ENV_KEYS = ["OPENAI_MODEL", MODEL_PRICES_ENV, TOOL_FEES_ENV, "OPENAI_API_KEY"];

/** Run `fn` with an exact env overlay and a captured console, then restore. */
async function withCostEnv(overrides, fn) {
  const saved = Object.fromEntries(COST_ENV_KEYS.map((k) => [k, process.env[k]]));
  const originalFetch = globalThis.fetch;
  const realError = console.error;
  const realWarn = console.warn;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  console.warn = (...a) => logged.push(a.join(" "));
  resetUnpricedAlerts();
  for (const k of COST_ENV_KEYS) delete process.env[k];
  Object.assign(process.env, overrides);
  try {
    return await fn(logged);
  } finally {
    console.error = realError;
    console.warn = realWarn;
    globalThis.fetch = originalFetch;
    for (const k of COST_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetUnpricedAlerts();
  }
}

/** A fetch that fails the test if it is ever called. */
function fetchThatMustNotRun() {
  globalThis.fetch = async () => {
    assert.fail("the probe spent a request on a model it could not price");
  };
}

/** A 200 carrying one answer, with or without a usage block. */
function fetchAnswering(usage) {
  const seen = { bodies: [] };
  globalThis.fetch = async (_url, init) => {
    seen.bodies.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => ({
        output: [
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "An answer.", annotations: [] }],
          },
        ],
        ...(usage ? { usage } : {}),
      }),
    };
  };
  return seen;
}

test("R3.6.6 — getOpenAiModel reads the id per call, so pricing keys on what is sent", () => {
  assert.equal(getOpenAiModel({}), "gpt-4o-mini");
  assert.equal(getOpenAiModel({ OPENAI_MODEL: "  " }), "gpt-4o-mini");
  assert.equal(getOpenAiModel({ OPENAI_MODEL: "gpt-5-titan" }), "gpt-5-titan");
});

test("R3.6.6 — an unpriced OPENAI_MODEL refuses to probe and reports cost null, never a number", async () => {
  await withCostEnv(
    { OPENAI_API_KEY: "sk-EXAMPLE-NOT-A-REAL-KEY", OPENAI_MODEL: "acme/unpriced-1" },
    async (logged) => {
      fetchThatMustNotRun();
      const stats = { cost: 0, tokens: 0 };
      const result = await probeChatGpt("best crm for small business", { stats });

      // The whole point: not 0, not 0.01, not a gpt-4o-mini extrapolation.
      assert.equal(result.cost, null);
      assert.equal(result.cost_state, COST_STATE.UNPRICED);
      assert.notEqual(result.error, null);
      assert.match(result.error, /acme\/unpriced-1/);
      assert.match(result.error, new RegExp(MODEL_PRICES_ENV));

      // Loud: a greppable operator line, not just a return value.
      assert.ok(
        logged.some((l) => l.includes("UNPRICED MODEL")),
        `expected an [llm-price] UNPRICED MODEL alert, got: ${JSON.stringify(logged)}`
      );
      assert.ok(logged.some((l) => l.includes("REFUSING to probe")));

      // The spend ledger learns nothing was measured, and can tell that apart
      // from a scan that genuinely cost nothing.
      assert.equal(stats.cost, 0);
      assert.equal(stats.cost_unmeasured_calls, 1);
    }
  );
});

test("R3.6.6 — an overridden model is priced at ITS declared rate, not gpt-4o-mini's", async () => {
  await withCostEnv(
    {
      OPENAI_API_KEY: "sk-EXAMPLE-NOT-A-REAL-KEY",
      OPENAI_MODEL: "acme/big",
      [MODEL_PRICES_ENV]: '{"acme/big":{"input":10,"output":20}}',
      [TOOL_FEES_ENV]: '{"acme/big":{"web_search":0.05}}',
    },
    async () => {
      const seen = fetchAnswering({ input_tokens: 1000000, output_tokens: 1000000 });
      const stats = { cost: 0, tokens: 0 };
      const result = await probeChatGpt("q", { stats });

      assert.equal(seen.bodies[0].model, "acme/big");
      // $10 + $20 per million each way, plus one $0.05 web_search call.
      assert.equal(result.cost, 30.05);
      assert.equal(result.cost_state, COST_STATE.MEASURED);
      assert.equal(result.cost_source, "price_table+tool_price_table");
      assert.equal(result.error, null);
      assert.equal(stats.cost, 30.05);
      assert.equal(stats.cost_unmeasured_calls, undefined);

      // The hard-coded rate this task removed would have produced $0.16 for the
      // same completion — a plausible number describing a different model.
      assert.notEqual(result.cost, 0.16);
    }
  );
});

test("R3.6.6 — a priced model with an unpriced tool also refuses; the fee is not silently dropped", async () => {
  await withCostEnv(
    {
      OPENAI_API_KEY: "sk-EXAMPLE-NOT-A-REAL-KEY",
      OPENAI_MODEL: "acme/tokens-only",
      [MODEL_PRICES_ENV]: '{"acme/tokens-only":{"input":1,"output":2}}',
    },
    async () => {
      fetchThatMustNotRun();
      const result = await probeChatGpt("q");
      assert.equal(result.cost, null);
      assert.equal(result.cost_state, COST_STATE.UNPRICED);
      assert.match(result.error, /web_search/);
      assert.match(result.error, new RegExp(TOOL_FEES_ENV));
    }
  );
});

test("R3.6.6 — the default model prices from the table, tool fee included", async () => {
  await withCostEnv({ OPENAI_API_KEY: "sk-EXAMPLE-NOT-A-REAL-KEY" }, async () => {
    const seen = fetchAnswering({ input_tokens: 1000000, output_tokens: 0 });
    const result = await probeChatGpt("q");
    assert.equal(seen.bodies[0].model, "gpt-4o-mini");
    // $0.15 for a million input tokens + $0.01 for the one web_search call.
    assert.ok(Math.abs(result.cost - 0.16) < 1e-12, `got ${result.cost}`);
    assert.equal(result.cost_state, COST_STATE.MEASURED);
  });
});

test("R3.6.6 — a completion with no usage block is unmeasured, not free", async () => {
  await withCostEnv({ OPENAI_API_KEY: "sk-EXAMPLE-NOT-A-REAL-KEY" }, async () => {
    fetchAnswering(null);
    const stats = { cost: 0, tokens: 0 };
    const result = await probeChatGpt("q", { stats });

    // The answer survives — it was paid for — but its price is not invented.
    assert.equal(result.text, "An answer.");
    assert.equal(result.error, null);
    assert.equal(result.cost, null);
    assert.equal(result.cost_state, COST_STATE.UNMEASURED_TOKENS);
    assert.equal(stats.cost, 0);
    assert.equal(stats.cost_unmeasured_calls, 1);
  });
});

test("R3.6.6 — a probe that never completed reports cost null, not $0", async () => {
  await withCostEnv({ OPENAI_API_KEY: "sk-EXAMPLE-NOT-A-REAL-KEY" }, async () => {
    globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => "Unauthorized" });
    const stats = { cost: 0, tokens: 0 };
    const result = await probeChatGpt("q", { stats });
    assert.equal(result.cost, null);
    assert.equal(result.cost_state, COST_STATE.PROBE_FAILED);
    assert.match(result.error, /401/);
    assert.equal(stats.cost, 0);
    assert.equal(stats.cost_unmeasured_calls, 1);
  });
});

test("R3.6.6 — an unconfigured key is 'nothing ran', not a $0 probe", async () => {
  await withCostEnv({}, async () => {
    fetchThatMustNotRun();
    const stats = { cost: 0, tokens: 0 };
    const result = await probeChatGpt("q", { stats });
    assert.equal(result.cost, null);
    assert.equal(result.cost_state, COST_STATE.NOT_CONFIGURED);
    assert.equal(result.error, "OPENAI_API_KEY not set");
    assert.equal(stats.cost, 0);
    assert.equal(stats.cost_unmeasured_calls, 1);
  });
});
