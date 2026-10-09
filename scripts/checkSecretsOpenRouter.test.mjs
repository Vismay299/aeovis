import test from "node:test";
import assert from "node:assert/strict";
import { VENDOR_CHECKS } from "./check-secrets.mjs";

test("check:secrets validates both model engines through the shared OpenRouter key", async () => {
  const names = [
    "LLM_API_KEY",
    "OPENROUTER_API_KEY",
    "LLM_BASE_URL",
    "OPENROUTER_BASE_URL",
    "OPENROUTER_OPENAI_MODEL",
    "OPENROUTER_PERPLEXITY_MODEL",
    "OPENAI_MODEL",
    "PERPLEXITY_MODEL",
    "OPENAI_API_KEY",
    "PERPLEXITY_API_KEY",
  ];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const originalFetch = globalThis.fetch;
  process.env.LLM_API_KEY = "shared-openrouter-test-key";
  process.env.LLM_BASE_URL = "https://openrouter.ai/api/v1";
  process.env.OPENROUTER_OPENAI_MODEL = "openai/gpt-6-luna";
  process.env.OPENROUTER_PERPLEXITY_MODEL = "perplexity/sonar";
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_BASE_URL;
  delete process.env.OPENAI_MODEL;
  delete process.env.PERPLEXITY_MODEL;
  delete process.env.OPENAI_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;

  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };

  try {
    const openai = await VENDOR_CHECKS.openai();
    const perplexity = await VENDOR_CHECKS.perplexity();

    assert.equal(openai.verdict, "PASS");
    assert.equal(perplexity.verdict, "PASS");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map((request) => request.url), [
      "https://openrouter.ai/api/v1/chat/completions",
      "https://openrouter.ai/api/v1/chat/completions",
    ]);
    assert.deepEqual(requests.map((request) => request.headers.Authorization), [
      "Bearer shared-openrouter-test-key",
      "Bearer shared-openrouter-test-key",
    ]);
    assert.deepEqual(requests.map((request) => request.body.model), [
      "openai/gpt-6-luna",
      "perplexity/sonar",
    ]);
    assert.deepEqual(requests.map((request) => request.body.max_tokens), [16, 16]);
  } finally {
    globalThis.fetch = originalFetch;
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
});
