import test from "node:test";
import assert from "node:assert/strict";
import { probePerplexity, isPerplexityConfigured } from "./perplexity.js";

test("isPerplexityConfigured returns false when no key", () => {
  const old = process.env.PERPLEXITY_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  assert.equal(isPerplexityConfigured(), false);
  if (old) process.env.PERPLEXITY_API_KEY = old;
});

test("isPerplexityConfigured returns true when key is set", () => {
  const old = process.env.PERPLEXITY_API_KEY;
  process.env.PERPLEXITY_API_KEY = "pplx-test";
  assert.equal(isPerplexityConfigured(), true);
  if (old) process.env.PERPLEXITY_API_KEY = old;
});

test("probePerplexity returns error when no API key", async () => {
  const old = process.env.PERPLEXITY_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  const result = await probePerplexity("best crm for small business");
  assert.equal(result.text, "");
  assert.equal(result.citations.length, 0);
  assert.ok(result.error);
  if (old) process.env.PERPLEXITY_API_KEY = old;
});

test("probePerplexity answer + search both OK", async () => {
  const originalFetch = globalThis.fetch;
  process.env.PERPLEXITY_API_KEY = "pplx-test";

  globalThis.fetch = async (url) => {
    if (url.includes("/chat/completions")) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "HubSpot and Zoho are top CRM options." } }],
          usage: { prompt_tokens: 50, completion_tokens: 30, total_cost: 0.005 },
        }),
      };
    }
    if (url.includes("/search")) {
      return {
        ok: true,
        json: async () => ({
          results: [
            { url: "https://www.hubspot.com/crm", title: "HubSpot CRM" },
            { url: "https://www.zoho.com/crm/", title: "Zoho CRM" },
          ],
        }),
      };
    }
    return { ok: false, status: 404, text: async () => "Not found" };
  };

  const result = await probePerplexity("best crm for small business");
  assert.equal(result.text, "HubSpot and Zoho are top CRM options.");
  assert.equal(result.citations.length, 2);
  assert.ok(result.citations.includes("https://www.hubspot.com/crm"));
  assert.ok(result.citations.includes("https://www.zoho.com/crm"));
  assert.equal(result.references.length, 2);
  assert.ok(result.cost >= 0.005);
  assert.equal(result.error, null);

  globalThis.fetch = originalFetch;
  delete process.env.PERPLEXITY_API_KEY;
});

test("probePerplexity search fails → answer-only with empty citations", async () => {
  const originalFetch = globalThis.fetch;
  process.env.PERPLEXITY_API_KEY = "pplx-test";

  globalThis.fetch = async (url) => {
    if (url.includes("/chat/completions")) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "HubSpot is great." } }],
          usage: { total_tokens: 80 },
        }),
      };
    }
    if (url.includes("/search")) {
      return { ok: false, status: 500, text: async () => "Internal error" };
    }
    return { ok: false, status: 404, text: async () => "Not found" };
  };

  const result = await probePerplexity("best crm for small business");
  assert.equal(result.text, "HubSpot is great.");
  assert.equal(result.citations.length, 0);
  assert.equal(result.references.length, 0);
  assert.equal(result.error, null, "search failure must not propagate as a probe error");

  globalThis.fetch = originalFetch;
  delete process.env.PERPLEXITY_API_KEY;
});

test("probePerplexity answer fails → { error }", async () => {
  const originalFetch = globalThis.fetch;
  process.env.PERPLEXITY_API_KEY = "pplx-test";

  let searchCalled = false;
  globalThis.fetch = async (url) => {
    if (url.includes("/chat/completions")) {
      return { ok: false, status: 401, text: async () => "Unauthorized" };
    }
    if (url.includes("/search")) {
      searchCalled = true;
      return { ok: false, status: 500, text: async () => "Internal error" };
    }
    return { ok: false, status: 404, text: async () => "Not found" };
  };

  const result = await probePerplexity("best crm for small business");
  assert.equal(result.text, "");
  assert.ok(result.error);
  assert.ok(searchCalled, "search call still fires even when answer is expected to fail");

  globalThis.fetch = originalFetch;
  delete process.env.PERPLEXITY_API_KEY;
});

test("probePerplexity tracks cost in options.stats", async () => {
  const originalFetch = globalThis.fetch;
  process.env.PERPLEXITY_API_KEY = "pplx-test";

  globalThis.fetch = async (url) => {
    if (url.includes("/chat/completions")) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Answer." } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
      };
    }
    if (url.includes("/search")) {
      return {
        ok: true,
        json: async () => ({ results: [] }),
      };
    }
    return { ok: false, status: 404, text: async () => "Not found" };
  };

  const stats = { cost: 0, tokens: 0 };
  await probePerplexity("some query", { stats });
  assert.ok(stats.cost > 0);
  assert.equal(stats.tokens, 15);

  globalThis.fetch = originalFetch;
  delete process.env.PERPLEXITY_API_KEY;
});

test("probePerplexity retries on 429", async () => {
  const originalFetch = globalThis.fetch;
  process.env.PERPLEXITY_API_KEY = "pplx-test";

  let answerCalls = 0;
  globalThis.fetch = async (url) => {
    if (url.includes("/chat/completions")) {
      answerCalls++;
      if (answerCalls < 3) {
        return { ok: false, status: 429, text: async () => "Rate limited" };
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Success." } }],
          usage: {},
        }),
      };
    }
    if (url.includes("/search")) {
      return {
        ok: true,
        json: async () => ({ results: [{ url: "https://example.com", title: "Example" }] }),
      };
    }
    return { ok: false, status: 404, text: async () => "Not found" };
  };

  const result = await probePerplexity("some query");
  assert.equal(result.text, "Success.");
  assert.equal(result.error, null);
  assert.equal(answerCalls, 3);

  globalThis.fetch = originalFetch;
  delete process.env.PERPLEXITY_API_KEY;
});
