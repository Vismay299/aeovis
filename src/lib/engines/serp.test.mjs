import test from 'node:test';
import assert from 'node:assert/strict';
import { probeGoogleAiOverview, extractTextFromBlocks } from './serp.js';

test('extractTextFromBlocks - nested list, snippets, tables, and expandable formats', () => {
  const blocks = [
    { snippet: "Here is the first paragraph." },
    {
      snippet: "Key features include:",
      list: [
        { snippet: "Feature A" },
        { snippet: "Feature B" }
      ]
    },
    {
      text_blocks: [
        { snippet: "Nested text snippet." }
      ]
    },
    {
      header: "Expandable Section Title",
      content: [
        { snippet: "Expandable inner text." }
      ]
    },
    {
      table: {
        headers: ["Plan", "Price"],
        rows: [
          ["Basic", "$10"],
          ["Pro", "$30"]
        ]
      }
    }
  ];

  const result = extractTextFromBlocks(blocks);
  assert.equal(
    result,
    "Here is the first paragraph.\nKey features include:\n- Feature A\n- Feature B\nNested text snippet.\nExpandable Section Title\nExpandable inner text.\nPlan | Price\nBasic | $10\nPro | $30"
  );
});

test('probeGoogleAiOverview - mock parsing correctness with text_blocks', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return {
      ok: true,
      json: async () => ({
        ai_overview: {
          text_blocks: [
            { snippet: "Acme CRM is highly rated." },
            { snippet: "It is built for small businesses." }
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
  assert.equal(result.model_used, "google_ai_overview");
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
      return {
        ok: true,
        json: async () => ({
          ai_overview_deferred: {
            token: "deferred_token_xyz"
          }
        })
      };
    } else {
      assert.ok(url.includes("page_token=deferred_token_xyz"));
      assert.ok(url.includes("engine=google_ai_overview"));
      return {
        ok: true,
        json: async () => ({
          ai_overview: {
            text_blocks: [{ snippet: "Deferred content loaded successfully." }],
            references: [{ title: "Deferred link", link: "https://deferred.com/" }]
          }
        })
      };
    }
  };

  process.env.SERPAPI_KEY = "mock-key";

  const result = await probeGoogleAiOverview("best crm");
  assert.equal(result.text, "Deferred content loaded successfully.");
  assert.equal(result.model_used, "google_ai_overview");
  assert.deepEqual(result.citations, ["https://deferred.com"]);
  // Cost should include double charge: 0.01 + 0.01 = 0.02
  assert.equal(result.cost, 0.02);

  globalThis.fetch = originalFetch;
  delete process.env.SERPAPI_KEY;
});
