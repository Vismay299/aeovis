import test from "node:test";
import assert from "node:assert/strict";
import { robustJsonParse, generateContent, getOpenRouterModel } from "./openrouter.js";
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

test("generateContent - missing key throws LlmUnavailableError, never { text: '' }", async () => {
  await withEnv("OPENROUTER_API_KEY", undefined, async () => {
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
    await withEnv("OPENROUTER_API_KEY", "test-key", async () => {
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
    await withEnv("OPENROUTER_API_KEY", "test-key", async () => {
      const res = await generateContent("hello", {}, 0);
      assert.equal(res.text, "");
      assert.equal(res.model_used, getOpenRouterModel());
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("llmJson - propagates LlmUnavailableError instead of returning null", async () => {
  // null means "the model answered unusably"; the throw means "no model was
  // reached". A caller must be able to tell those apart.
  await withEnv("OPENROUTER_API_KEY", undefined, async () => {
    const caught = await llmJson("hello").catch((e) => e);
    assert.ok(isLlmUnavailable(caught), `expected the error to propagate, got ${caught}`);
  });
});

test("llmJson - still returns null when the model answers with unparseable prose", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ choices: [{ message: { content: "sorry, I cannot help" } }] });
  try {
    await withEnv("OPENROUTER_API_KEY", "test-key", async () => {
      assert.equal(await llmJson("hello", {}, 0), null);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
