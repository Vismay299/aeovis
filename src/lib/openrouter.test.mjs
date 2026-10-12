import test from "node:test";
import assert from "node:assert/strict";
import { robustJsonParse, generateContent, getLlmModel } from "./openrouter.js";
import { getLlmBaseUrl, getLlmProvider, resetLlmConfigWarnings } from "./llmConfig.js";
import { llmJson } from "./llm.js";
import { isLlmUnavailable } from "./llmErrors.js";
import { isUnpricedModel, resetUnpricedAlerts } from "./llmPricing.js";

test("robustJsonParse - clean JSON array", () => {
  const result = robustJsonParse('[{"text":"a"},{"text":"b"}]');
  assert.deepEqual(result, [{ text: "a" }, { text: "b" }]);
});

test("robustJsonParse - clean JSON object", () => {
  const result = robustJsonParse('{"name":"Acme","domain":"acme.io"}');
  assert.deepEqual(result, { name: "Acme", domain: "acme.io" });
});

test("robustJsonParse - code-fenced JSON", () => {
  const result = robustJsonParse('```json\n[{"text":"a"}]\n```');
  assert.deepEqual(result, [{ text: "a" }]);
});

test("robustJsonParse - JSON embedded in prose", () => {
  const result = robustJsonParse(
    'Sure, here are the results:\n[{"text":"best crm"},{"text":"top tools"}]\nHope that helps!'
  );
  assert.deepEqual(result, [{ text: "best crm" }, { text: "top tools" }]);
});

test("robustJsonParse - prose-wrapped object with nested braces", () => {
  const result = robustJsonParse(
    'Here you go: {"name":"Acme","meta":{"score":1}} — let me know if you need more.'
  );
  assert.deepEqual(result, { name: "Acme", meta: { score: 1 } });
});

test("robustJsonParse - truncated JSON with no balanced structure returns null", () => {
  const result = robustJsonParse('[{"text":"a"');
  assert.equal(result, null);
});

test("robustJsonParse - garbage / non-JSON returns null", () => {
  assert.equal(robustJsonParse("not json at all"), null);
  assert.equal(robustJsonParse(""), null);
  assert.equal(robustJsonParse(null), null);
  assert.equal(robustJsonParse(undefined), null);
});

// ---------------------------------------------------------------------------
// R0.3.1 — the LLM-unavailable contract.
//
// These are the tests that would have caught B6/A8. Before this change both
// paths below returned { text: "", model_used: "" }, indistinguishable from
// "the model replied with nothing" — which is how a total outage became a
// Share of Voice donut reading a confident 100%.
// ---------------------------------------------------------------------------

async function withEnv(key, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, key);
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (had) process.env[key] = prev;
    else delete process.env[key];
  }
}

/** Same as withEnv, for several vars at once. */
async function withEnvs(vars, fn) {
  const names = Object.keys(vars);
  if (!names.length) return fn();
  const [head, ...rest] = names;
  return withEnv(head, vars[head], () =>
    withEnvs(Object.fromEntries(rest.map((n) => [n, vars[n]])), fn)
  );
}

const NO_KEYS = { LLM_API_KEY: undefined, OPENROUTER_API_KEY: undefined };
/** Canonical key, and no base URL of either spelling, so the default gateway applies. */
const KEYED = {
  LLM_API_KEY: "test-key",
  OPENROUTER_API_KEY: undefined,
  LLM_BASE_URL: undefined,
  OPENROUTER_BASE_URL: undefined,
  // R3.6.1: cleared so an operator's real price declarations in the ambient
  // environment cannot make an unpriced-model test pass by accident.
  LLM_MODEL_PRICES: undefined,
};

test("generateContent - missing key throws LlmUnavailableError, never { text: '' }", async () => {
  await withEnvs(NO_KEYS, async () => {
    const caught = await generateContent("hello").catch((e) => e);
    assert.ok(isLlmUnavailable(caught), `expected LlmUnavailableError, got ${caught}`);
    assert.equal(caught.reason, "missing_key");
    assert.equal(caught.provider, "openrouter");
    // The regression itself: the old contract resolved with this shape.
    assert.notEqual(caught?.text, "");
  });
});

test("generateContent - exhausted retries throws LlmUnavailableError with the transport cause", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("upstream exploded", { status: 503 });
  };
  try {
    await withEnvs(KEYED, async () => {
      const caught = await generateContent("hello", {}, 0).catch((e) => e);
      assert.ok(isLlmUnavailable(caught), `expected LlmUnavailableError, got ${caught}`);
      assert.equal(caught.reason, "exhausted_retries");
      assert.equal(caught.provider, "openrouter");
      assert.match(caught.message, /503/);
      assert.equal(calls, 1, "retries=0 means exactly one attempt");
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("generateContent - a genuinely empty model answer still RESOLVES with text:'' (not the error)", async () => {
  // The distinction the whole task rests on: the model answering with nothing
  // is a real (poor) answer and must stay resolvable, so only unreachability
  // throws.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ choices: [{ message: { content: "" } }], usage: { total_tokens: 3 } });
  try {
    await withEnvs(KEYED, async () => {
      const res = await generateContent("hello", {}, 0);
      assert.equal(res.text, "");
      assert.equal(res.model_used, getLlmModel());
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("llmJson - propagates LlmUnavailableError instead of returning null", async () => {
  // null means "the model answered unusably"; the throw means "no model was
  // reached". A caller must be able to tell those apart.
  await withEnvs(NO_KEYS, async () => {
    const caught = await llmJson("hello").catch((e) => e);
    assert.ok(isLlmUnavailable(caught), `expected the error to propagate, got ${caught}`);
  });
});

test("llmJson - still returns null when the model answers with unparseable prose", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ choices: [{ message: { content: "sorry, I cannot help" } }] });
  try {
    await withEnvs(KEYED, async () => {
      assert.equal(await llmJson("hello", {}, 0), null);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---------------------------------------------------------------------------
// R5.1.1 (findings C4/S19) — provider-neutral config, and the per-gateway
// request quirks that must survive the rename.
//
// The deployed base URL was Xiaomi MiMo while every var was named OPENROUTER_*.
// The names are now LLM_*; OPENROUTER_* stays readable so a live deployment
// does not break on deploy. What must NOT change is the wire format: MiMo
// takes max_completion_tokens and needs thinking disabled, and only OpenRouter
// is asked for `usage.include`.
// ---------------------------------------------------------------------------

/** Runs generateContent against a stub gateway and returns the request body sent. */
async function captureRequest(envVars, options = {}) {
  const realFetch = globalThis.fetch;
  let captured = null;
  let url = null;
  globalThis.fetch = async (u, init) => {
    url = u;
    captured = JSON.parse(init.body);
    // A realistic OpenAI-compatible usage block, with the prompt/completion
    // breakdown. `{ total_tokens: 1 }` alone is NOT a breakdown — input and
    // output bill at different rates, so splitting a bare total would be a
    // guess — and R3.6.1 makes a priced model with no reported breakdown a
    // loud refusal, which would fail these request-SHAPE tests for the wrong
    // reason. The refusal has its own tests below.
    return Response.json({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
    });
  };
  try {
    await withEnvs({ ...KEYED, ...envVars }, () => generateContent("hello", options, 0));
  } finally {
    globalThis.fetch = realFetch;
  }
  return { body: captured, url };
}

test("config - LLM_* are canonical and OPENROUTER_* is only a fallback", async () => {
  await withEnvs(
    {
      LLM_BASE_URL: "https://canonical.example/v1",
      OPENROUTER_BASE_URL: "https://legacy.example/v1",
      LLM_MODEL: "canonical/model",
      OPENROUTER_MODEL: "legacy/model",
    },
    () => {
      assert.equal(getLlmBaseUrl(), "https://canonical.example/v1");
      assert.equal(getLlmModel(), "canonical/model");
    }
  );
});

test("config - a deployment on the deprecated names keeps working, and is warned ONCE", async () => {
  const realWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    resetLlmConfigWarnings();
    await withEnvs(
      {
        LLM_BASE_URL: undefined,
        LLM_MODEL: undefined,
        OPENROUTER_BASE_URL: "https://api.xiaomimimo.com/v1/",
        OPENROUTER_MODEL: "MiMo-VL-7B-RL",
      },
      () => {
        assert.equal(getLlmBaseUrl(), "https://api.xiaomimimo.com/v1", "trailing slash stripped");
        assert.equal(getLlmModel(), "MiMo-VL-7B-RL");
        // Read again: the deployment still works, but does not shout twice.
        assert.equal(getLlmBaseUrl(), "https://api.xiaomimimo.com/v1");
      }
    );
  } finally {
    console.warn = realWarn;
  }
  const baseWarnings = warnings.filter((w) => w.includes("OPENROUTER_BASE_URL"));
  assert.equal(baseWarnings.length, 1, `expected exactly one deprecation warning, got ${warnings.length}`);
  assert.match(baseWarnings[0], /DEPRECATED/);
  assert.match(baseWarnings[0], /LLM_BASE_URL/, "the warning must name the replacement");
});

test("config - the deprecated OPENROUTER_API_KEY alone still reaches the gateway", async () => {
  resetLlmConfigWarnings();
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const { body } = await captureRequest({ LLM_API_KEY: undefined, OPENROUTER_API_KEY: "legacy-key" });
    assert.ok(body, "the request must have been sent, not refused");
  } finally {
    console.warn = realWarn;
  }
});

test("provider is derived from the base URL, not from a vendor-named variable", () => {
  assert.equal(getLlmProvider("https://openrouter.ai/api/v1"), "openrouter");
  assert.equal(getLlmProvider("https://api.xiaomimimo.com/v1"), "mimo");
  assert.equal(getLlmProvider("https://some-gateway.example/v1"), "custom");
});

test("MiMo keeps max_completion_tokens, thinking-disable, and NO usage.include", async () => {
  resetLlmConfigWarnings();
  const { body, url } = await captureRequest(
    {
      LLM_BASE_URL: "https://api.xiaomimimo.com/v1",
      LLM_MODEL: "MiMo-VL-7B-RL",
      // R3.6.1: MiMo does not echo usage.cost and no built-in rate claims to
      // know its price, so the pre-flight gate refuses the id outright. This
      // test is about request SHAPE, so it declares a rate to get past the
      // gate — see "an unpriced model id is refused BEFORE the request" below
      // for the refusal itself.
      LLM_MODEL_PRICES: '{"MiMo-VL-7B-RL":{"input":0.3,"output":1.2}}',
    },
    { max_tokens: 128 }
  );
  assert.equal(url, "https://api.xiaomimimo.com/v1/chat/completions");
  assert.equal(body.max_completion_tokens, 128, "MiMo rejects max_tokens");
  assert.equal(body.max_tokens, undefined);
  assert.deepEqual(body.thinking, { type: "disabled" }, "reasoning traces break robustJsonParse");
  assert.equal(body.usage, undefined, "usage.include is an OpenRouter extension");
});

test("OpenRouter keeps max_tokens and asks for real cost on a PAID model only", async () => {
  const paid = await captureRequest(
    {
      LLM_BASE_URL: "https://openrouter.ai/api/v1",
      LLM_MODEL: "z-ai/glm-5.2",
      // R3.6.1: this stub gateway asks for usage.include and then answers
      // without a `cost` field, which is now a loud refusal rather than a
      // silent $0. Declared here so the request-SHAPE assertions below are
      // still reachable; the refusal has its own test further down.
      LLM_MODEL_PRICES: '{"z-ai/glm-5.2":1.19}',
    },
    { max_tokens: 128 }
  );
  assert.equal(paid.body.max_tokens, 128);
  assert.equal(paid.body.max_completion_tokens, undefined);
  assert.equal(paid.body.thinking, undefined, "thinking-disable is a MiMo quirk, not a portable field");
  assert.deepEqual(paid.body.usage, { include: true }, "cost cap needs real spend, not a guess");

  const free = await captureRequest(
    { LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_MODEL: "z-ai/glm-5.2:free" },
    { max_tokens: 128 }
  );
  assert.equal(free.body.usage, undefined, "a :free model costs 0 and needs no cost echo");
});

test("an unknown OpenAI-compatible gateway gets the portable request shape only", async () => {
  const { body } = await captureRequest(
    {
      LLM_BASE_URL: "https://some-gateway.example/v1",
      LLM_MODEL: "some/model",
      // As above: a `custom` gateway reports no cost either, so the id needs a
      // declared rate before the request-shape assertions can be reached.
      LLM_MODEL_PRICES: '{"some/model":1}',
    },
    { max_tokens: 64 }
  );
  assert.equal(body.max_tokens, 64);
  assert.equal(body.thinking, undefined);
  assert.equal(body.usage, undefined);
});

// ---------------------------------------------------------------------------
// R3.6.1 (findings C4/S18) — the price table fails loud on an unknown model id.
//
// The line these replace was:
//     const cost = model.endsWith(":free") ? 0 : Number(data?.usage?.cost) || 0;
// `Number(undefined) || 0` is 0, and only OpenRouter echoes usage.cost. Every
// paid completion on MiMo — the gateway this deployment actually talks to —
// was therefore recorded as free, and the content pipeline's per-item cost cap
// was comparing a budget against a constant zero. Standing rule 3: an unpriced
// model id fails loud, never $0.
// ---------------------------------------------------------------------------

/** Runs generateContent against a gateway stub returning `payload`. */
async function priced(envVars, payload, options = {}, retries = 0) {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json(payload);
  };
  try {
    const out = await withEnvs({ ...KEYED, ...envVars }, () =>
      generateContent("hello", options, retries).catch((e) => e)
    );
    return { out, calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const OPENROUTER = { LLM_BASE_URL: "https://openrouter.ai/api/v1" };
const MIMO = { LLM_BASE_URL: "https://api.xiaomimimo.com/v1" };
const OK = (usage) => ({ choices: [{ message: { content: "ok" } }], usage });

test("pricing - an unpriced model id is refused BEFORE the request is sent, and alerts", async () => {
  resetUnpricedAlerts();
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  let res;
  try {
    res = await priced({ ...MIMO, LLM_MODEL: "MiMo-VL-7B-RL" }, OK({ total_tokens: 10 }));
  } finally {
    console.error = realError;
  }
  assert.ok(isUnpricedModel(res.out), `expected UnpricedModelError, got ${res.out}`);
  assert.equal(res.out.reason, "unpriced_model");
  assert.equal(res.out.model, "MiMo-VL-7B-RL");
  assert.equal(res.out.provider, "mimo");
  // The point of the pre-flight gate: no tokens were spent on a call whose
  // cost could never have been recorded.
  assert.equal(res.calls, 0, "the request must not be sent at all");
  // "throws AND alerts" — a monitor keys on this string.
  assert.equal(errors.length, 1, `expected one alert, got ${errors.length}`);
  assert.match(errors[0], /\[llm-price\] UNPRICED MODEL/);
  assert.match(errors[0], /MiMo-VL-7B-RL/);
  assert.match(errors[0], /LLM_MODEL_PRICES/, "the alert must name the remedy");
});

test("pricing - the refusal is never laundered into $0, an empty answer, or an outage", async () => {
  resetUnpricedAlerts();
  const realError = console.error;
  console.error = () => {};
  let res;
  try {
    // retries=2: a pricing refusal must not be retried and relabelled
    // "exhausted_retries", which is how it would lose its cause.
    res = await priced({ ...MIMO, LLM_MODEL: "MiMo-VL-7B-RL" }, OK({ total_tokens: 10 }), {}, 2);
  } finally {
    console.error = realError;
  }
  assert.ok(isUnpricedModel(res.out));
  assert.equal(isLlmUnavailable(res.out), false, "a pricing refusal is not a transport outage");
  assert.equal(res.out.cost, undefined, "the old contract resolved with a number here");
  assert.equal(res.out.text, undefined);
  assert.equal(res.calls, 0, "and it is not retried");
});

test("pricing - a known model prices from tokens when the gateway echoes no cost", async () => {
  // $3/M in, $15/M out on a gateway that reports no cost at all:
  // 1M in + 1M out = $18, where the old code recorded $0.
  const stats = { cost: 0, tokens: 0 };
  const { out } = await priced(
    { ...MIMO, LLM_MODEL_PRICES: '{"anthropic/claude-sonnet-4.5":{"input":3,"output":15}}' },
    OK({ prompt_tokens: 1000000, completion_tokens: 1000000, total_tokens: 2000000 }),
    { model: "anthropic/claude-sonnet-4.5", stats }
  );
  assert.equal(out.cost, 18);
  assert.equal(out.cost_source, "price_table");
  assert.equal(stats.cost, 18, "the cost cap reads options.stats, so the number must land there");
});

test("pricing - the built-in table alone prices the default paid CONTENT_MODEL", async () => {
  // No LLM_MODEL_PRICES at all: the id ships priced, because it is the one
  // model this repo pays for by default (src/lib/llm.js getContentModel).
  const { out } = await priced(
    MIMO,
    OK({ prompt_tokens: 200000, completion_tokens: 100000, total_tokens: 300000 }),
    { model: "anthropic/claude-sonnet-4.5" }
  );
  assert.equal(out.cost_source, "price_table");
  assert.equal(Number(out.cost.toFixed(6)), 2.1); // 0.2*3 + 0.1*15
});

test("pricing - real spend echoed by OpenRouter wins over the table, labelled 'gateway'", async () => {
  const { out } = await priced(
    { ...OPENROUTER, LLM_MODEL_PRICES: '{"anthropic/claude-sonnet-4.5":{"input":3,"output":15}}' },
    OK({ prompt_tokens: 1000000, completion_tokens: 1000000, cost: 0.42 }),
    { model: "anthropic/claude-sonnet-4.5" }
  );
  assert.equal(out.cost, 0.42, "actual spend beats an estimate");
  assert.equal(out.cost_source, "gateway");
});

test("pricing - a gateway-reported 0.0 is a MEASUREMENT, not an absent field", async () => {
  // `Number(0) || 0` and `Number(undefined) || 0` were the same value; they are
  // no longer the same claim. This one is a real zero (promo credit, cached
  // prompt) and keeps the authoritative source.
  const { out } = await priced(OPENROUTER, OK({ prompt_tokens: 10, completion_tokens: 10, cost: 0 }), {
    model: "z-ai/glm-5.2",
  });
  assert.equal(out.cost, 0);
  assert.equal(out.cost_source, "gateway");
});

test("pricing - OpenRouter promising cost and not delivering it throws, never $0", async () => {
  // The pre-flight gate lets an unknown OpenRouter id through because
  // usage.include is supposed to answer for it. When the echo does not arrive,
  // the refusal happens after the fact rather than inventing a zero.
  resetUnpricedAlerts();
  const realError = console.error;
  console.error = () => {};
  let res;
  try {
    res = await priced(
      OPENROUTER,
      OK({ prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 }),
      { model: "z-ai/glm-5.2" },
      2
    );
  } finally {
    console.error = realError;
  }
  assert.ok(isUnpricedModel(res.out), `expected UnpricedModelError, got ${res.out}`);
  assert.equal(res.out.provider, "openrouter");
  assert.equal(res.calls, 1, "a pricing refusal is not retried");
});

test("pricing - a REPORTED zero on a priced model is a measured zero, not an unknown", async () => {
  // The distinction this whole task rests on. A model we can price that
  // consumed nothing costs 0 — and must resolve, with a named source, rather
  // than be mistaken for a model nothing can price.
  const zero = await priced(
    MIMO,
    OK({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }),
    { model: "anthropic/claude-sonnet-4.5" }
  );
  assert.equal(isUnpricedModel(zero.out), false, `zero usage must not throw, got ${zero.out}`);
  assert.equal(zero.out.cost, 0);
  assert.equal(zero.out.cost_source, "price_table");

  // One side reported is still a measurement: 1M prompt tokens x $3, and a
  // completion side the gateway explicitly called 0.
  const half = await priced(MIMO, OK({ prompt_tokens: 1000000, completion_tokens: 0 }), {
    model: "anthropic/claude-sonnet-4.5",
  });
  assert.equal(isUnpricedModel(half.out), false, `a reported 0 must not throw, got ${half.out}`);
  assert.equal(half.out.cost, 3);
  assert.equal(half.out.cost_source, "price_table");
});

test("pricing - a priced model whose gateway reported NO tokens throws, never a $0", async () => {
  // The verifier's real input: LLM_MODEL=anthropic/claude-sonnet-4.5 on MiMo,
  // a 1250-char draft, and no `usage` block at all. This used to resolve to
  // {cost: 0, cost_source: "price_table"} and accumulate a fabricated zero
  // into stats.cost. "Consumed nothing" and "measured nothing" are different
  // facts, so the second one is refused (standing rule 1).
  resetUnpricedAlerts();
  const realError = console.error;
  console.error = () => {};
  const stats = { tokens: 0, cost: 0 };
  let absent;
  try {
    absent = await priced(MIMO, { choices: [{ message: { content: "x".repeat(1250) } }] }, {
      model: "anthropic/claude-sonnet-4.5",
      stats,
    });
  } finally {
    console.error = realError;
  }
  assert.ok(isUnpricedModel(absent.out), `expected UnpricedModelError, got ${absent.out}`);
  assert.equal(absent.out.reason, "unmeasured_tokens", "distinct from an unpriced id");
  assert.equal(absent.out.model, "anthropic/claude-sonnet-4.5");
  assert.equal(absent.out.provider, "mimo");
  // The request DID go out — this one is only knowable after the completion,
  // unlike an unpriced id, which never leaves the process.
  assert.equal(absent.calls, 1, "not retried, and not relabelled exhausted_retries");
  assert.equal(stats.cost, 0, "no fabricated cost was accumulated");
  assert.equal(stats.tokens, 0, "and no fabricated token count either");
});

test("pricing - a ':free' id resolves as free_tier, distinguishably from a priced zero", async () => {
  const { out } = await priced(
    { ...MIMO, LLM_MODEL: "google/gemma-4-31b-it:free" },
    OK({ prompt_tokens: 500, completion_tokens: 500, total_tokens: 1000 })
  );
  assert.equal(out.model_used, "google/gemma-4-31b-it:free");
  assert.equal(out.cost, 0);
  assert.equal(out.cost_source, "free_tier", "free is a priced 0, not an unpriced one");
});

test("pricing - the alert does not flood, but the throw happens every time", async () => {
  resetUnpricedAlerts();
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  try {
    for (let i = 0; i < 3; i++) {
      const res = await priced({ ...MIMO, LLM_MODEL: "MiMo-VL-7B-RL" }, OK({}));
      assert.ok(isUnpricedModel(res.out), `call ${i} must still throw`);
    }
  } finally {
    console.error = realError;
  }
  assert.equal(errors.length, 1, "three refusals, one alert line — the throw is the per-call signal");
});

// ---------------------------------------------------------------------------
// R3.6.7 — a permanent refusal costs one call and says what it was.
//
// The guard that stood at src/lib/openrouter.js:100 read
//   `const retryable = res.status === 429 || res.status >= 500;`
// and then threw for everything else — into this loop's own catch, which
// backed off and went round again for any error at all. Measured before the
// fix: a 401 cost 3 calls and 4546ms, and then surfaced as
// LlmUnavailableError{reason:"exhausted_retries"}. Both halves were wrong, and
// the second was worse: `reason` is the field callers branch on (promptSource
// propagates it verbatim to the operator), so a revoked key read as a vendor
// outage.
//
// Everything below counts calls to an injected fetch stub. No log strings, no
// real network. The key is a placeholder — a 401 is produced by the stub, not
// by sending a bad credential anywhere.
// ---------------------------------------------------------------------------

const PLACEHOLDER_KEY = { ...KEYED, LLM_API_KEY: "sk-EXAMPLE-NOT-A-REAL-KEY" };

/**
 * Run generateContent against a counting stub.
 * @param {(n: number) => Response | Promise<Response>} respond called per attempt
 */
async function counted(respond, { retries = 0, envVars = {} } = {}) {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return respond(calls);
  };
  const startedAt = Date.now();
  try {
    const out = await withEnvs({ ...PLACEHOLDER_KEY, ...envVars }, () =>
      generateContent("hello", {}, retries).catch((e) => e)
    );
    return { out, calls, elapsedMs: Date.now() - startedAt };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const status = (code, body = "refused") => () => new Response(body, { status: code });

test("retry - a 401 costs exactly ONE call, even with a retry budget of two", async () => {
  const { out, calls, elapsedMs } = await counted(status(401, "No auth credentials found"), {
    retries: 2,
  });
  // THE regression. This was 3 before R3.6.7.
  assert.equal(calls, 1, "a revoked key does not become valid on the second try");
  assert.ok(isLlmUnavailable(out), `expected LlmUnavailableError, got ${out}`);
  // And it must not have spent the two backoffs (1500ms + 3000ms) getting there.
  assert.ok(elapsedMs < 1000, `a refused call must not sleep; took ${elapsedMs}ms`);
});

test("retry - a 401 reports itself as an auth failure, NOT as exhausted_retries", async () => {
  const { out } = await counted(status(401), { retries: 2 });
  assert.equal(out.reason, "auth_failed", "the one field a caller branches on");
  assert.notEqual(out.reason, "exhausted_retries", "a revoked key is not a vendor outage");
  assert.equal(out.status, 401);
  assert.equal(out.provider, "openrouter");
  // Pins the SINGLE-CALL wording specifically. "on the first call" and "not
  // retried" are only true when the refusal was the first response, so this
  // assertion names the whole clause together with the count it belongs to —
  // a bare /not retried/ here is what let the mixed-sequence message below
  // contradict itself unnoticed.
  assert.match(
    out.message,
    /on the first call \(1 attempt, not retried/,
    "one call, and the message says so in the same breath as the count"
  );
  assert.doesNotMatch(out.message, /3 attempts/, "and must not claim calls it never made");
  assert.doesNotMatch(out.message, /attempt 1 of/, "a first-call refusal is not an nth attempt");
});

test("retry - a 403 is auth_failed too; other permanent 4xx are permanent_error", async () => {
  const forbidden = await counted(status(403), { retries: 2 });
  assert.equal(forbidden.calls, 1);
  assert.equal(forbidden.out.reason, "auth_failed");

  for (const code of [400, 404, 422]) {
    const { out, calls } = await counted(status(code), { retries: 2 });
    assert.equal(calls, 1, `HTTP ${code} is a refusal, not flakiness`);
    assert.equal(out.reason, "permanent_error", `HTTP ${code}`);
    assert.equal(out.status, code);
  }
});

test("retry - a 429 still spends the whole budget and stays exhausted_retries", async () => {
  const { out, calls } = await counted(status(429, "slow down"), { retries: 1 });
  assert.equal(calls, 2, "a rate limit is exactly the case backoff exists for");
  assert.equal(out.reason, "exhausted_retries");
  assert.match(out.message, /2 attempts/);
});

test("retry - a 5xx still spends the whole budget", async () => {
  const { out, calls } = await counted(status(503, "upstream exploded"), { retries: 1 });
  assert.equal(calls, 2);
  assert.equal(out.reason, "exhausted_retries");
  assert.match(out.message, /503/);
});

test("retry - a transport failure has no status to read, so it stays retryable", async () => {
  // The deliberate asymmetry inherited from httpFailureKind.js: a failure we
  // cannot classify defaults to TRANSIENT, because giving up early throws away
  // a measurement we might have got.
  const { out, calls } = await counted(
    () => {
      throw Object.assign(new Error("fetch failed"), { name: "TypeError" });
    },
    { retries: 1 }
  );
  assert.equal(calls, 2, "an unclassifiable failure keeps its retries");
  assert.equal(out.reason, "exhausted_retries");
});

test("retry - an AbortError (the request timeout) is still retried", async () => {
  // The old code had a dedicated isAbort branch that waited and continued.
  // It was byte-for-byte the generic retry beneath it, so it is gone — this
  // pins that its behaviour did not go with it.
  const { out, calls } = await counted(
    () => {
      throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    },
    { retries: 1 }
  );
  assert.equal(calls, 2, "a timeout is the canonical transient failure");
  assert.equal(out.reason, "exhausted_retries");
});

test("retry - a 401 after a transient 500 stops immediately and says it was call TWO", async () => {
  // Mixed sequence: the classification is per-response, not per-run. The 500
  // buys a retry; the 401 that follows ends it on the spot.
  const { out, calls } = await counted(
    (n) => new Response("x", { status: n === 1 ? 500 : 401 }),
    { retries: 2 }
  );
  assert.equal(calls, 2, "one retry earned by the 500, then stop — not 3");
  assert.equal(out.reason, "auth_failed", "the LAST verdict decides the label");
  assert.equal(out.status, 401);
  // The message has to survive this sequence too. It used to read "on the first
  // call (2 attempts, not retried)" — two attempts, one of them a retry,
  // described as neither. An operator reading that cannot tell a revoked key
  // from a key revoked mid-run, which is the whole reason attempts is counted.
  assert.match(
    out.message,
    /on attempt 2 of 3, after 1 transient failure that earned a retry \(2 attempts;/,
    "the prose must report the attempt it actually refused on"
  );
  assert.doesNotMatch(
    out.message,
    /on the first call/,
    "the 401 arrived on the SECOND call; saying otherwise contradicts the count beside it"
  );
  assert.doesNotMatch(
    out.message,
    /\(2 attempts, not retried/,
    "counted two attempts and claimed none were retried in the same sentence"
  );
  // Still says the refusal itself was not retried — true here, and the reason a
  // reader knows no backoff followed the 401.
  assert.match(out.message, /the refusal itself was not retried/);
});

test("retry - two transient 500s before a 403 report all three attempts, plural", async () => {
  // Guards the plural/singular seam in the conditional clause, and the case
  // where the refusal lands on the LAST attempt of the budget.
  const { out, calls } = await counted((n) => new Response("x", { status: n < 3 ? 500 : 403 }), {
    retries: 2,
  });
  assert.equal(calls, 3);
  assert.equal(out.reason, "auth_failed");
  assert.match(out.message, /on attempt 3 of 3, after 2 transient failures that earned a retry/);
  assert.doesNotMatch(out.message, /on the first call/);
});

test("retry - every permanent status obeys the SHARED classifier, one call each", async () => {
  const { classifyHttpStatus, FAILURE_KIND } = await import("./engines/httpFailureKind.js");
  for (const code of [400, 401, 402, 403, 404, 409, 422, 451]) {
    assert.equal(classifyHttpStatus(code), FAILURE_KIND.PERMANENT, `fixture: ${code}`);
    const { calls } = await counted(status(code), { retries: 2 });
    assert.equal(calls, 1, `HTTP ${code} is classified permanent, so it must cost one call`);
  }
});

test("retry - 408 and 425 are retried, which a private `429 || >=500` rule could not do", async () => {
  // The decisive evidence that openrouter.js reads the shared vocabulary rather
  // than a fourth private copy of it: the guard that used to live here would
  // have called both of these permanent and stopped after one call.
  const { classifyHttpStatus, FAILURE_KIND } = await import("./engines/httpFailureKind.js");
  for (const code of [408, 425]) {
    assert.equal(classifyHttpStatus(code), FAILURE_KIND.TRANSIENT, `fixture: ${code}`);
    const { calls, out } = await counted(status(code), { retries: 1 });
    assert.equal(calls, 2, `HTTP ${code} is classified transient, so it keeps its budget`);
    assert.equal(out.reason, "exhausted_retries");
  }
});

// Sonar rejects json_object. Text mode plus JSON parsing/retries preserves
// arbitrary object and array contracts without sending unsupported schemas.
for (const [shape, result] of [
  ["object", { ok: true, result: { nested: "caller data" } }],
  ["array", [{ text: "best tile brands" }, { text: "best wall tiles" }]],
]) {
  test(`Sonar JSON mode uses a supported request format and preserves a caller ${shape}`, async () => {
    const realFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      // The original unsupported json_object request must fail this fake.
      if (body.response_format?.type !== "text") {
        return Response.json({ error: { message: "invalid response format" } }, { status: 400 });
      }
      assert.match(body.messages.at(-1).content, /Return ONLY the requested valid JSON object or array/);
      return Response.json({
        choices: [{ message: { content: JSON.stringify(result) } }],
        usage: { cost: 0.001, total_tokens: 20 },
      });
    };
    try {
      await withEnvs({ ...KEYED, LLM_MODEL: "perplexity/sonar" }, async () => {
        const stats = {};
        assert.deepEqual(await llmJson("Return requested JSON", { stats }, 0), result);
        assert.equal(stats.cost, 0.001, "format compatibility must preserve metered spend");
        assert.equal(calls, 1, "valid JSON output needs no retry");
      });
    } finally {
      globalThis.fetch = realFetch;
    }
  });
}

test("Sonar malformed JSON retries and returns null without manufacturing data", async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({
      choices: [{ message: { content: "not JSON" } }], usage: { cost: 0.001 },
    });
  };
  try {
    await withEnvs({ ...KEYED, LLM_MODEL: "perplexity/sonar" }, async () => {
      assert.equal(await llmJson("Return JSON", {}, 1), null);
      assert.equal(calls, 2);
    });
  } finally { globalThis.fetch = realFetch; }
});

for (const model of ["google/gemini-3.8-flash", "openai/gpt-6-luna"]) {
  test(`${model} retains the existing JSON request and response format`, async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.response_format, { type: "json_object" });
      assert.equal(body.messages.at(-1).content, "Return JSON");
      return Response.json({ choices: [{ message: { content: '{"ok":true}' } }], usage: { cost: 0.001 } });
    };
    try {
      await withEnvs({ ...KEYED, LLM_MODEL: model }, async () => {
        assert.deepEqual(await llmJson("Return JSON", {}, 0), { ok: true });
      });
    } finally { globalThis.fetch = realFetch; }
  });
}

test("Sonar text mode neither wraps the prompt nor unwraps the answer", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.response_format, undefined);
    assert.equal(body.messages.at(-1).content, "hello");
    return Response.json({ choices: [{ message: { content: '{"result":{"ok":true}}' } }], usage: { cost: 0.001 } });
  };
  try {
    await withEnvs(KEYED, async () => {
      const r = await generateContent("hello", { model: "perplexity/sonar" }, 0);
      assert.equal(r.text, '{"result":{"ok":true}}');
    });
  } finally { globalThis.fetch = realFetch; }
});

// Regressions for content workers killed while awaiting streamed bodies/retries.
test("completion timeout remains active after headers until the body finishes", { timeout: 1000 }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, { signal }) => ({
    ok: true,
    json: () => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  });
  try {
    await withEnvs(KEYED, async () => {
      await assert.rejects(generateContent("test", { timeout: 20 }, 0),
        (error) => isLlmUnavailable(error) && error.cause?.name === "AbortError");
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("a shared deadline stops retries before a backoff can exceed the worker budget", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response("busy", { status: 503 }); };
  try {
    await withEnvs(KEYED, async () => {
      await assert.rejects(generateContent("test", { deadlineMs: Date.now() + 100 }),
        (error) => isLlmUnavailable(error) && error.reason === "deadline_exceeded");
      assert.equal(calls, 1);
    });
  } finally { globalThis.fetch = originalFetch; }
});

test("an expired deadline never starts another paid request", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("request must not start"); };
  try {
    await withEnvs(KEYED, async () => {
      await assert.rejects(generateContent("test", { deadlineMs: Date.now() - 1 }),
        (error) => isLlmUnavailable(error) && error.reason === "deadline_exceeded");
    });
  } finally { globalThis.fetch = originalFetch; }
});

// ---------------------------------------------------------------------------
// Reasoning effort. google/gemini-3.8-flash reasons by default and refuses
// `reasoning.enabled:false`; on the prompt-gen call it spent ~7,000 hidden
// tokens and 64-100s against a 25s timeout, so every customer scan aborted at
// sourcing with "exhausted_retries ... This operation was aborted".
// ---------------------------------------------------------------------------

test("OpenRouter sends reasoning effort only when a caller asks for it", async () => {
  const env = { LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_MODEL: "z-ai/glm-5.2:free" };
  const asked = await captureRequest(env, { reasoningEffort: "minimal" });
  assert.deepEqual(asked.body.reasoning, { effort: "minimal" });
  const plain = await captureRequest(env, {});
  assert.equal(plain.body.reasoning, undefined);
});

test("MiMo never receives the OpenRouter reasoning field", async () => {
  resetLlmConfigWarnings();
  const { body } = await captureRequest(
    {
      LLM_BASE_URL: "https://api.xiaomimimo.com/v1",
      LLM_MODEL: "MiMo-VL-7B-RL",
      LLM_MODEL_PRICES: '{"MiMo-VL-7B-RL":{"input":0.3,"output":1.2}}',
    },
    { reasoningEffort: "minimal" }
  );
  assert.equal(body.reasoning, undefined);
  assert.deepEqual(body.thinking, { type: "disabled" });
});

test("llmJson (prompt-gen, extraction) asks for minimal reasoning", async () => {
  const realFetch = globalThis.fetch;
  let body = null;
  globalThis.fetch = async (_u, init) => {
    body = JSON.parse(init.body);
    return Response.json({
      choices: [{ message: { content: "[]" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  };
  try {
    await withEnvs(
      { ...KEYED, LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_MODEL: "z-ai/glm-5.2:free" },
      () => llmJson("hello", {}, 0)
    );
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(body.reasoning, { effort: "minimal" });
});
