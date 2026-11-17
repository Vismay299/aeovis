import test from "node:test";
import assert from "node:assert/strict";
import { probeChatGpt, isChatGptConfigured, COST_STATE, getOpenAiModel } from "./openai.js";
import { MODEL_PRICES_ENV, TOOL_FEES_ENV, resetUnpricedAlerts } from "../llmPricing.js";

test("isChatGptConfigured returns false when no key", () => {
  const names = ["OPENAI_API_KEY", "LLM_API_KEY", "OPENROUTER_API_KEY", "LLM_BASE_URL", "OPENROUTER_BASE_URL"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    assert.equal(isChatGptConfigured(), false);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("isChatGptConfigured returns true when key is set", () => {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test";
  assert.equal(isChatGptConfigured(), true);
  if (old) process.env.OPENAI_API_KEY = old;
});

test("probeChatGpt returns error when no API key", async () => {
  const names = ["OPENAI_API_KEY", "LLM_API_KEY", "OPENROUTER_API_KEY", "LLM_BASE_URL", "OPENROUTER_BASE_URL"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    const result = await probeChatGpt("best crm for small business");
    assert.equal(result.text, "");
    assert.equal(result.citations.length, 0);
    assert.ok(result.error);
  } finally {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});

test("ChatGPT adapter uses the shared OpenRouter key and configured model", async () => {
  const originalFetch = globalThis.fetch;
  const names = ["OPENAI_API_KEY", "LLM_API_KEY", "OPENROUTER_API_KEY", "LLM_BASE_URL", "OPENROUTER_BASE_URL", "OPENROUTER_OPENAI_MODEL"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  process.env.LLM_API_KEY = "shared-openrouter-test-key";
  process.env.LLM_BASE_URL = "https://openrouter.ai/api/v1";
  process.env.OPENROUTER_OPENAI_MODEL = "openai/gpt-6-luna";
  globalThis.fetch = async (url, init) => {
    assert.equal(url, "https://openrouter.ai/api/v1/chat/completions");
    assert.equal(init.headers.Authorization, "Bearer shared-openrouter-test-key");
    const body = JSON.parse(init.body);
    assert.equal(body.model, "openai/gpt-6-luna");
    assert.equal(body.tools[0].type, "openrouter:web_search");
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "A grounded answer.", annotations: [
          { type: "url_citation", url: "https://example.com/source", title: "Example source" },
        ] } }],
        usage: { cost: 0.0001, prompt_tokens: 12, completion_tokens: 5 },
      }),
    };
  };
  try {
    const result = await probeChatGpt("question");
    assert.equal(result.text, "A grounded answer.");
    assert.deepEqual(result.citations, ["https://example.com/source"]);
    assert.equal(result.cost, 0.0001);
    assert.equal(isChatGptConfigured(), true);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
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
    assert.equal(result.error, "OPENAI_API_KEY or shared OpenRouter LLM_API_KEY not set");
    assert.equal(stats.cost, 0);
    assert.equal(stats.cost_unmeasured_calls, 1);
  });
});

/**
 * R2.2.13 — the retry policy, counted in CALLS.
 *
 * This adapter carried the same dead guard R2.2.10 removed from
 * perplexity.js: `if (status === 429 || status >= 500) { ...retry... }` and
 * then `throw`, inside a try whose own catch retried unconditionally. Measured
 * on this file before the fix: a 401 took 3 calls and 3013ms, identical in
 * count and timing to a real outage.
 *
 * Every assertion below counts ACTUAL invocations of the injected fetch stub.
 * A log line is not evidence that a call did not happen; a call count is.
 * Restore the old `throw err` under a dead status check and the `= 1` counts
 * go to 3 — the assertion that fails is on the number, not on any string.
 */

const MAX_ATTEMPTS = 3; // MAX_RETRIES(2) + the first try
const ONE_BACKOFF_MS = 1000; // the first sleep the old code paid on a 401

/**
 * Replace fetch with a counter over a per-attempt responder.
 *
 * Restores the REAL fetch captured at import time rather than "whatever was
 * installed a moment ago": a test that stubs twice would otherwise hand the
 * next test a stale stub, and a leaked stub is exactly how a call-count
 * assertion stops meaning anything.
 */
const REAL_FETCH = globalThis.fetch;

function countingFetch(t, respond) {
  const calls = { n: 0 };
  globalThis.fetch = async () => {
    calls.n++;
    return respond(calls.n);
  };
  t.after(() => {
    globalThis.fetch = REAL_FETCH;
  });
  return calls;
}

const httpFail = (status) => () => ({
  ok: false,
  status,
  text: async () => `upstream said ${status}`,
});

const answerOk = () => ({
  ok: true,
  json: async () => ({
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "An answer.", annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 5 },
  }),
});

/** The real key is never needed: every call below is stubbed. */
function useKey(t) {
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-EXAMPLE-NOT-A-REAL-KEY";
  t.after(() => {
    if (old === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = old;
  });
}

test("R2.2.13 — a 401 costs exactly ONE call and no backoff", async (t) => {
  useKey(t);
  const calls = countingFetch(t, httpFail(401));

  const startedAt = Date.now();
  const result = await probeChatGpt("best crm for small business");
  const elapsed = Date.now() - startedAt;

  assert.equal(calls.n, 1, "a revoked key is not a reason to ask twice more");
  assert.ok(
    elapsed < ONE_BACKOFF_MS,
    `a permanent failure must not sleep; took ${elapsed}ms (old code: ~3013ms)`
  );
  // Failing fast is not failing quietly: the refusal still surfaces, typed.
  assert.match(result.error || "", /401/);
  assert.equal(result.cost, null);
  assert.equal(result.cost_state, COST_STATE.PROBE_FAILED);
  assert.equal(result.text, "");
});

test("R2.2.13 — 403 and the other 4xx refusals also stop on the first response", async (t) => {
  useKey(t);
  for (const status of [400, 403, 404, 422]) {
    const calls = countingFetch(t, httpFail(status));
    const result = await probeChatGpt("q");
    assert.equal(calls.n, 1, `HTTP ${status} must not be retried`);
    assert.match(result.error || "", new RegExp(String(status)));
  }
});

test("R2.2.13 — 429, 5xx and transport failures still take the FULL budget", async (t) => {
  useKey(t);
  // Two statuses, not the whole transient list: each one costs a real ~3s of
  // backoff here. The rest of the table is covered without sleeping by the
  // classifier test at the bottom of this file.
  for (const status of [429, 503]) {
    const calls = countingFetch(t, httpFail(status));
    await probeChatGpt("q");
    assert.equal(calls.n, MAX_ATTEMPTS, `HTTP ${status} deserves the whole attempt budget`);
  }

  // Transport noise carries no status at all, and the default is to retry it:
  // giving up on a failure we cannot read throws away a recoverable measurement.
  const dropped = countingFetch(t, () => {
    throw new TypeError("fetch failed");
  });
  const result = await probeChatGpt("q");
  assert.equal(dropped.n, MAX_ATTEMPTS, "a severed connection is retried, not classified as refusal");
  assert.match(result.error || "", /fetch failed/);
});

test("R2.2.13 — a transient failure that later succeeds still returns the answer", async (t) => {
  useKey(t);
  const calls = countingFetch(t, (n) => (n === 1 ? httpFail(503)() : answerOk()));

  const result = await probeChatGpt("q");

  assert.equal(calls.n, 2, "one retry was enough");
  assert.equal(result.text, "An answer.");
  assert.equal(result.error, null);
});

test("R2.2.13 — the failure line reports calls it COUNTED, not the retry constant", async (t) => {
  useKey(t);
  const realError = console.error;
  const logged = [];
  console.error = (...a) => logged.push(a.join(" "));
  t.after(() => {
    console.error = realError;
  });

  countingFetch(t, httpFail(401));
  const refused = await probeChatGpt("q");
  assert.match(logged.at(-1) || "", /after 1 call\b/);
  assert.match(logged.at(-1) || "", /permanent/);
  assert.match(refused.cost_state_detail || "", /after 1 call\b/);

  logged.length = 0;
  countingFetch(t, httpFail(500));
  const exhausted = await probeChatGpt("q");
  assert.match(logged.at(-1) || "", /after 3 calls\b/);
  assert.match(exhausted.cost_state_detail || "", /after 3 calls\b/);
});

test("R2.2.13 — the classification is perplexity.js's, not a second copy", async () => {
  const shared = await import("./httpFailureKind.js");
  const perplexity = await import("./perplexity.js");

  assert.equal(
    perplexity.classifyHttpStatus,
    shared.classifyHttpStatus,
    "perplexity.js must re-export the shared classifier, not redeclare it"
  );
  assert.equal(perplexity.FAILURE_KIND, shared.FAILURE_KIND);
  assert.equal(perplexity.failureKindOf, shared.failureKindOf);
  assert.equal(perplexity.isRetryableFailure, shared.isRetryableFailure);

  // And the policy itself, asserted here too so deleting perplexity.test.mjs
  // cannot leave the OpenAI adapter's retry rule unspecified.
  for (const status of [400, 401, 403, 404, 422]) {
    assert.equal(shared.classifyHttpStatus(status), shared.FAILURE_KIND.PERMANENT);
  }
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(shared.classifyHttpStatus(status), shared.FAILURE_KIND.TRANSIENT);
  }
  assert.equal(shared.classifyHttpStatus(undefined), shared.FAILURE_KIND.TRANSIENT);
  assert.equal(shared.classifyHttpStatus("nonsense"), shared.FAILURE_KIND.TRANSIENT);
});
