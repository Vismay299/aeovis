import test from 'node:test';
import assert from 'node:assert/strict';
import { probeGoogleAiOverview } from './serp.js';

test('probeGoogleAiOverview - mock parsing correctness with text_blocks', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return {
      ok: true,
      json: async () => ({
        ai_overview: {
          text_blocks: [
            { text: "Acme CRM is highly rated." },
            { text: "It is built for small businesses." }
          ],
          references: [
            { title: "Acme Pricing", link: "https://acme.io/pricing?ref=google" },
            { title: "CRM Review", link: "https://reviews.com/acme-crm/" }
          ]
        }
      })
    };
  };

  process.env.SERPAPI_KEY = "mock-key";

  const result = await probeGoogleAiOverview("best crm");
  assert.equal(result.text, "Acme CRM is highly rated.\nIt is built for small businesses.");
  assert.equal(result.model_used, "google-ai-overview");
  assert.deepEqual(result.citations, [
    "https://acme.io/pricing",
    "https://reviews.com/acme-crm"
  ]);

  globalThis.fetch = originalFetch;
  delete process.env.SERPAPI_KEY;
});

test('probeGoogleAiOverview - mock deferred page_token loading', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;

  globalThis.fetch = async (url) => {
    callCount++;
    if (callCount === 1) {
      // First call returns page_token
      return {
        ok: true,
        json: async () => ({
          ai_overview_deferred: {
            token: "deferred_token_xyz"
          }
        })
      };
    } else {
      // Second call returns follow-up overview
      assert.ok(url.includes("page_token=deferred_token_xyz"));
      assert.ok(url.includes("engine=google_ai_overview"));
      return {
        ok: true,
        json: async () => ({
          ai_overview: {
            text_blocks: [{ text: "Deferred content loaded successfully." }],
            references: [{ title: "Deferred link", link: "https://deferred.com/" }]
          }
        })
      };
    }
  };

  process.env.SERPAPI_KEY = "mock-key";

  const result = await probeGoogleAiOverview("best crm");
  assert.equal(result.text, "Deferred content loaded successfully.");
  assert.equal(result.model_used, "google-ai-overview");
  assert.deepEqual(result.citations, ["https://deferred.com"]);

  globalThis.fetch = originalFetch;
  delete process.env.SERPAPI_KEY;
});
