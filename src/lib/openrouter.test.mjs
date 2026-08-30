import test from "node:test";
import assert from "node:assert/strict";
import { robustJsonParse, generateContent, getLlmModel } from "./openrouter.js";
import { getLlmBaseUrl, getLlmProvider, resetLlmConfigWarnings } from "./llmConfig.js";
import { llmJson } from "./llm.js";
import { isLlmUnavailable } from "./llmErrors.js";

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
    return Response.json({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 1 } });
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
    { LLM_BASE_URL: "https://api.xiaomimimo.com/v1", LLM_MODEL: "MiMo-VL-7B-RL" },
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
    { LLM_BASE_URL: "https://openrouter.ai/api/v1", LLM_MODEL: "z-ai/glm-5.2" },
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
    { LLM_BASE_URL: "https://some-gateway.example/v1", LLM_MODEL: "some/model" },
    { max_tokens: 64 }
  );
  assert.equal(body.max_tokens, 64);
  assert.equal(body.thinking, undefined);
  assert.equal(body.usage, undefined);
});
