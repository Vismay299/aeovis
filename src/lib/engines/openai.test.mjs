import test from "node:test";
import assert from "node:assert/strict";
import { probeChatGpt, isChatGptConfigured } from "./openai.js";

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
