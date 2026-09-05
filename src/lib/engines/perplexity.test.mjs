import test from "node:test";
import assert from "node:assert/strict";
import {
  probePerplexity,
  isPerplexityConfigured,
  CITATIONS_STATE,
  CITATIONS_STATE_REASON,
  hasUnverifiedCitations,
} from "./perplexity.js";

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
  // Nothing was asked, so the empty list is not a finding of "no citations".
  assert.equal(result.citations_state, CITATIONS_STATE.UNVERIFIED);
  assert.equal(result.citations_state_reason, CITATIONS_STATE_REASON.NOT_CONFIGURED);
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
  assert.equal(result.citations_state, CITATIONS_STATE.VERIFIED);
  assert.equal(result.citations_state_reason, null);

  globalThis.fetch = originalFetch;
  delete process.env.PERPLEXITY_API_KEY;
});

test("probePerplexity search fails → answer-only with UNVERIFIED citations", async () => {
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
  // R2.2.2 — the whole point: this [] must not read as "we looked and there
  // were none". The answer leg is still a real measurement, so the row lives.
  assert.equal(result.citations_state, CITATIONS_STATE.UNVERIFIED);
  assert.equal(result.citations_state_reason, CITATIONS_STATE_REASON.SEARCH_LEG_FAILED);
  assert.match(
    result.citations_state_detail || "",
    /500/,
    "the vendor's own failure text is kept as prose detail"
  );
  assert.equal(hasUnverifiedCitations(result), true);

  globalThis.fetch = originalFetch;
  delete process.env.PERPLEXITY_API_KEY;
});

test("probePerplexity distinguishes a genuine zero from an unverifiable one", async () => {
  const originalFetch = globalThis.fetch;
  process.env.PERPLEXITY_API_KEY = "pplx-test";

  const answerOk = {
    ok: true,
    json: async () => ({ choices: [{ message: { content: "HubSpot is great." } }], usage: {} }),
  };

  // Leg 2 answers 200 with an empty result set: we asked, there were none.
  globalThis.fetch = async (url) => {
    if (url.includes("/chat/completions")) return answerOk;
    if (url.includes("/search")) return { ok: true, json: async () => ({ results: [] }) };
    return { ok: false, status: 404, text: async () => "Not found" };
  };
  const measuredZero = await probePerplexity("best crm for small business");

  // Leg 2 never answers: we could not ask.
  globalThis.fetch = async (url) => {
    if (url.includes("/chat/completions")) return answerOk;
    if (url.includes("/search")) return { ok: false, status: 503, text: async () => "Unavailable" };
    return { ok: false, status: 404, text: async () => "Not found" };
  };
  const unverifiable = await probePerplexity("best crm for small business");

  assert.equal(measuredZero.citations.length, 0);
  assert.equal(unverifiable.citations.length, 0);
  assert.equal(measuredZero.error, null);
  assert.equal(unverifiable.error, null);
  assert.notEqual(
    measuredZero.citations_state,
    unverifiable.citations_state,
    "a measured zero and an unaskable citation leg must not be the same value"
  );
  assert.equal(measuredZero.citations_state, CITATIONS_STATE.VERIFIED);
  assert.equal(unverifiable.citations_state, CITATIONS_STATE.UNVERIFIED);

  globalThis.fetch = originalFetch;
  delete process.env.PERPLEXITY_API_KEY;
});

test("hasUnverifiedCitations drops only unverified rows from a citation-share denominator", () => {
  const rows = [
    { engine: "perplexity", brand_cited: true, citations_state: CITATIONS_STATE.VERIFIED },
    { engine: "perplexity", brand_cited: false, citations_state: CITATIONS_STATE.VERIFIED },
    { engine: "perplexity", brand_cited: false, citations_state: CITATIONS_STATE.UNVERIFIED },
    { engine: "aio", brand_cited: false }, // single-leg engine: carries no state
  ];

  const denominator = rows.filter((r) => !hasUnverifiedCitations(r));
  assert.equal(denominator.length, 3, "the unverified row is excluded, nothing else is");
  assert.equal(
    denominator.filter((r) => r.brand_cited).length / denominator.length,
    1 / 3,
    "an outage on the citation leg must not deflate the share as a confirmed zero"
  );

  // No guessing on absent fields, and no crash on a missing row.
  assert.equal(hasUnverifiedCitations({ engine: "aio" }), false);
  assert.equal(hasUnverifiedCitations(null), false);
  assert.equal(hasUnverifiedCitations(undefined), false);
});

test("the citations_state vocabulary is frozen", () => {
  assert.ok(Object.isFrozen(CITATIONS_STATE));
  assert.ok(Object.isFrozen(CITATIONS_STATE_REASON));
  assert.deepEqual(Object.values(CITATIONS_STATE).sort(), ["unverified", "verified"]);
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
  assert.equal(result.citations_state, CITATIONS_STATE.UNVERIFIED);
  assert.equal(result.citations_state_reason, CITATIONS_STATE_REASON.SEARCH_LEG_FAILED);

  globalThis.fetch = originalFetch;
  delete process.env.PERPLEXITY_API_KEY;
});

test("probePerplexity answer fails but search survives → citations stay VERIFIED", async () => {
  const originalFetch = globalThis.fetch;
  process.env.PERPLEXITY_API_KEY = "pplx-test";

  globalThis.fetch = async (url) => {
    if (url.includes("/chat/completions")) {
      return { ok: false, status: 401, text: async () => "Unauthorized" };
    }
    if (url.includes("/search")) {
      return {
        ok: true,
        json: async () => ({ results: [{ url: "https://www.hubspot.com/crm", title: "HubSpot" }] }),
      };
    }
    return { ok: false, status: 404, text: async () => "Not found" };
  };

  const result = await probePerplexity("best crm for small business");
  assert.equal(result.text, "");
  assert.ok(result.error, "the answer leg's failure is still the row's error");
  assert.equal(result.citations.length, 1);
  assert.equal(
    result.citations_state,
    CITATIONS_STATE.VERIFIED,
    "the citation leg answered, so its list is a measurement regardless of the answer leg"
  );
  assert.equal(result.citations_state_reason, null);

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
