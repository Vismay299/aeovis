import test from "node:test";
import assert from "node:assert/strict";
import { resolveEnabledEngines, runMultiEngineScan, summarizeEngineSlice } from "./enginePipeline.js";
import { CITATIONS_STATE, CITATIONS_STATE_REASON } from "../engines/perplexity.js";

/**
 * R2.2.9: probeTextEngine drops measured citations when the answer leg fails.
 *
 * Perplexity uses two independent calls:
 * - /chat/completions (the answer leg)
 * - /search (the citation leg)
 *
 * Before R2.2.9, when /chat/completions failed but /search succeeded,
 * probeTextEngine returned early on `probeResult.error` BEFORE `result.citations`
 * or `result.references` were assigned. This caused genuinely measured citations
 * to be persisted as an empty array `citations: []` despite carrying
 * `citations_state: "verified"`.
 *
 * This test suite drives the production registry probe path (resolveEnabledEngines)
 * and verifies that:
 * 1. An answer-leg failure that still carried a successful citation leg persists
 *    the citations and references it measured.
 * 2. Citations state remains "verified" (since the search leg succeeded).
 * 3. Derived citation metrics (brand_cited, competitors_cited, visible) are evaluated
 *    from the measured references.
 * 4. An answer-leg failure with an empty search result persists as an empty array
 *    with "verified" state (genuine measured zero).
 * 5. Both legs dead carries "unverified" with reason "search_leg_failed".
 * 6. Multi-engine scan preserves citations on persisted rows without corrupting
 *    the slice's visibility denominator.
 */

const ENV = ["ENGINES", "PERPLEXITY_API_KEY", "PERPLEXITY_MODEL"];

function useEnv(t, env) {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  t.after(() => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

const okResponse = (payload) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(payload),
  json: async () => payload,
});

const failResponse = (status) => ({
  ok: false,
  status,
  text: async () => `upstream ${status}`,
  json: async () => ({}),
});

const chatPayload = (text) => ({
  choices: [{ message: { role: "assistant", content: text } }],
  usage: { cost: { total_cost: 0.004 }, prompt_tokens: 10, completion_tokens: 5 },
});

const searchPayloadWithResults = () => ({
  results: [
    { url: "https://acme.io/pricing-guide", title: "Acme Pricing Guide" },
    { url: "https://rival.com/comparison", title: "Rival Comparison" },
    { url: "https://independent-review.example/best-crms", title: "Best CRMs" },
  ],
});

const searchPayloadEmpty = () => ({
  results: [],
});

function mockPerplexityRoutes(t, router) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const isSearch = String(url).includes("/search");
    const query = isSearch ? body.query : body.messages[0].content;
    const route = router(query);

    if (isSearch) {
      if (route === "search_fail") return failResponse(503);
      if (route === "search_empty") return okResponse(searchPayloadEmpty());
      return okResponse(searchPayloadWithResults());
    }

    if (route === "answer_fail") return failResponse(500);
    return okResponse(chatPayload("Acme is an excellent product compared to Rival."));
  };

  t.after(() => {
    globalThis.fetch = original;
  });
}

const BRAND = "Acme";
const SITE = "https://acme.io";
const COMPETITORS = ["Rival"];
const asQuery = (text) => ({ text, topic: "General", source: "test" });

test("R2.2.9 — probeTextEngine preserves measured citations when the answer leg fails", async (t) => {
  useEnv(t, { ENGINES: "perplexity", PERPLEXITY_API_KEY: "TEST-KEY" });

  const PROMPT_ANSWER_FAILS_SEARCH_OK = "answer fails search ok prompt";
  mockPerplexityRoutes(t, (q) => (q === PROMPT_ANSWER_FAILS_SEARCH_OK ? "answer_fail" : "ok"));

  const perplexity = resolveEnabledEngines().find((e) => e.name === "perplexity");
  assert.ok(perplexity, "perplexity engine must resolve from registry");

  const row = await perplexity.probe(
    asQuery(PROMPT_ANSWER_FAILS_SEARCH_OK),
    BRAND,
    [BRAND],
    "acme.io",
    COMPETITORS,
    null
  );

  // 1. Error on answer leg is preserved
  assert.ok(row.error, "row.error must capture answer leg error");
  assert.match(row.error, /HTTP 500/);
  assert.equal(row.answer_present, false, "answer_present is false when answer leg failed");

  // 2. Citations state is verified
  assert.equal(
    row.citations_state,
    CITATIONS_STATE.VERIFIED,
    "search leg succeeded, so citations_state must be 'verified'"
  );
  assert.equal(row.citations_state_reason, null);

  // 3. Citations are NOT dropped (core R2.2.9 bug)
  assert.ok(Array.isArray(row.citations), "row.citations must be an array");
  assert.equal(row.citations.length, 3, "all 3 search citations must be preserved");
  assert.deepEqual(row.citations, [
    "https://acme.io/pricing-guide",
    "https://rival.com/comparison",
    "https://independent-review.example/best-crms",
  ]);

  // 4. References are mapped with domains
  assert.equal(row.references.length, 3);
  assert.equal(row.references[0].domain, "acme.io");
  assert.equal(row.references[1].domain, "rival.com");
  assert.equal(row.references[2].domain, "independent-review.example");

  // 5. Derived citation signals are preserved
  assert.equal(row.brand_cited, true, "brand domain acme.io in references sets brand_cited true");
  assert.deepEqual(row.competitors_cited, ["Rival"], "rival domain in references sets competitors_cited");
  assert.equal(row.visible, true, "brand_cited true sets visible true");
});

test("R2.2.9 — answer leg fails and search leg returns 0 results is a verified zero", async (t) => {
  useEnv(t, { ENGINES: "perplexity", PERPLEXITY_API_KEY: "TEST-KEY" });

  const PROMPT_ANSWER_FAILS_SEARCH_ZERO = "answer fails search empty prompt";
  mockPerplexityRoutes(t, (q) => (q === PROMPT_ANSWER_FAILS_SEARCH_ZERO ? "search_empty" : "ok"));

  // We want both answer to fail AND search to return empty:
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const isSearch = String(url).includes("/search");
    if (isSearch) return okResponse(searchPayloadEmpty());
    return failResponse(500);
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const perplexity = resolveEnabledEngines().find((e) => e.name === "perplexity");
  const row = await perplexity.probe(
    asQuery(PROMPT_ANSWER_FAILS_SEARCH_ZERO),
    BRAND,
    [BRAND],
    "acme.io",
    COMPETITORS,
    null
  );

  assert.ok(row.error, "row.error must be set");
  assert.equal(row.answer_present, false);
  assert.equal(row.citations_state, CITATIONS_STATE.VERIFIED, "search leg ran and found 0 results");
  assert.equal(row.citations_state_reason, null);
  assert.deepEqual(row.citations, []);
  assert.deepEqual(row.references, []);
  assert.equal(row.brand_cited, false);
  assert.equal(row.visible, false);
});

test("R2.2.9 — both legs fail is unverified with search_leg_failed reason", async (t) => {
  useEnv(t, { ENGINES: "perplexity", PERPLEXITY_API_KEY: "TEST-KEY" });

  const PROMPT_BOTH_FAIL = "both legs fail prompt";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => failResponse(503);
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const perplexity = resolveEnabledEngines().find((e) => e.name === "perplexity");
  const row = await perplexity.probe(
    asQuery(PROMPT_BOTH_FAIL),
    BRAND,
    [BRAND],
    "acme.io",
    COMPETITORS,
    null
  );

  assert.ok(row.error, "row.error must be set");
  assert.equal(row.answer_present, false);
  assert.equal(row.citations_state, CITATIONS_STATE.UNVERIFIED);
  assert.equal(row.citations_state_reason, CITATIONS_STATE_REASON.SEARCH_LEG_FAILED);
  assert.deepEqual(row.citations, []);
  assert.equal(row.brand_cited, false);
  assert.equal(row.visible, false);
});

test("R2.2.9 — multi-engine scan persists citations on answer-failed rows without corrupting visibility denominator", async (t) => {
  useEnv(t, { ENGINES: "perplexity", PERPLEXITY_API_KEY: "TEST-KEY" });

  const HEALTHY_PROMPT = "best crm for growing agencies";
  const ANSWER_FAIL_PROMPT = "cheapest crm with good api";

  mockPerplexityRoutes(t, (q) => (q === ANSWER_FAIL_PROMPT ? "answer_fail" : "ok"));

  const scan = await runMultiEngineScan({
    brand: BRAND,
    url: SITE,
    competitors: COMPETITORS,
    queries: [asQuery(HEALTHY_PROMPT), asQuery(ANSWER_FAIL_PROMPT)],
  });

  const healthyRow = scan.results.find((r) => r.prompt === HEALTHY_PROMPT);
  const failedAnswerRow = scan.results.find((r) => r.prompt === ANSWER_FAIL_PROMPT);

  assert.ok(healthyRow, "healthy row must be present in scan results");
  assert.ok(failedAnswerRow, "failed-answer row must be present in scan results");

  // Failed answer row must have preserved citations in scan.results
  assert.ok(failedAnswerRow.error, "failed-answer row must carry error");
  assert.equal(failedAnswerRow.answer_present, false);
  assert.equal(failedAnswerRow.citations.length, 3, "scan.results must persist citations on failed-answer row");
  assert.equal(failedAnswerRow.brand_cited, true);
  assert.equal(failedAnswerRow.citations_state, CITATIONS_STATE.VERIFIED);

  // Slice summary: only healthy row had answer_present=true
  const slice = scan.engines.perplexity;
  assert.equal(slice.total_queries, 2);
  assert.equal(slice.errored_queries, 1);
  assert.equal(slice.non_branded_with_answer, 1, "failed-answer prompt is not in with_answer denominator");
});
