import test from 'node:test';
import assert from 'node:assert/strict';
import { probeGoogleAiOverview } from './serp.js';

test('probeGoogleAiOverview - mock parsing correctness', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return {
      ok: true,
      json: async () => ({
        ai_overview: {
          text: "Acme CRM is highly rated for small businesses.",
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
  assert.equal(result.text, "Acme CRM is highly rated for small businesses.");
  assert.equal(result.model_used, "google-ai-overview");
  assert.deepEqual(result.citations, [
    "https://acme.io/pricing",
    "https://reviews.com/acme-crm"
  ]);

  globalThis.fetch = originalFetch;
  delete process.env.SERPAPI_KEY;
});
