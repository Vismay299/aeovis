import test from "node:test";
import assert from "node:assert/strict";
import {
  probePerplexity,
  isPerplexityConfigured,
  CITATIONS_STATE,
  CITATIONS_STATE_REASON,
  hasUnverifiedCitations,
  FAILURE_KIND,
  classifyHttpStatus,
  failureKindOf,
  isRetryableFailure,
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
  // R3.6.5: this used to read `assert.ok(result.cost >= 0.005)` and passed only
  // because the /search leg returned a hardcoded 0.005 on every success. With
  // no LLM_TOOL_FEES declared that leg has no price, so the TOTAL is not a
  // measurement — the answer leg's real 0.005 is reported in the detail rather
  // than shipped as a total that understates the probe.
  assert.equal(result.cost, null, "an unpriced /search leg means there is no honest total");
  assert.equal(result.cost_state, "unpriced");
  assert.match(result.cost_state_detail || "", /answer: measured 0\.005/);
  assert.match(result.cost_state_detail || "", /search: unpriced/);
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

test("probePerplexity tracks tokens in options.stats, and refuses to track a cost it did not measure", async () => {
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
  // R3.6.5: this used to read `assert.ok(stats.cost > 0)`. The vendor reported
  // token counts and NO cost, and "sonar" has no declared rate here, so every
  // dollar in that assertion came from the two hardcoded 0.005 literals. Tokens
  // were genuinely measured and still accrue; the cost was not, so it does not —
  // and the counter is what stops that reading as a free scan.
  assert.equal(stats.cost, 0, "an unmeasured cost must not accrue as spend");
  assert.equal(stats.cost_unmeasured_calls, 1, "it is counted instead, never silently dropped");
  assert.equal(stats.tokens, 15);
  // See src/lib/engines/perplexityCost.test.mjs for the positive case: with
  // LLM_MODEL_PRICES / LLM_TOOL_FEES declared, stats.cost does move.

  globalThis.fetch = originalFetch;
  delete process.env.PERPLEXITY_API_KEY;
});

/**
 * R2.2.10 — the retry policy, counted in CALLS.
 *
 * The pre-fix code guarded the retry with `if (429 || >=500)` and threw for
 * everything else — inside a try whose own catch retried unconditionally. The
 * guard was dead code, so a 401 from a revoked key cost 3 calls and ~3s of
 * backoff before failing, and the one error an operator can fix looked like
 * vendor flakiness.
 *
 * Every assertion below counts ACTUAL invocations of the injected fetch stub.
 * A log line is not evidence that a call did not happen; a call count is.
 * Restore the old `throw err` under a dead status check and the `= 1` counts
 * below go to 3.
 */

const MAX_ATTEMPTS = 3; // MAX_RETRIES(2) + the first try
const ONE_BACKOFF_MS = 1000; // the first sleep the old code paid on a 401

function stubLegs(t, { answer, search }) {
  const original = globalThis.fetch;
  const calls = { answer: 0, search: 0 };
  globalThis.fetch = async (url) => {
    if (String(url).includes("/chat/completions")) {
      calls.answer++;
      return answer(calls.answer);
    }
    calls.search++;
    return search(calls.search);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

const httpFail = (status) => () => ({
  ok: false,
  status,
  text: async () => `upstream said ${status}`,
});
const answerOk = () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: "HubSpot is great." } }], usage: {} }),
});
const searchOk = () => ({
  ok: true,
  json: async () => ({ results: [{ url: "https://www.hubspot.com/crm", title: "HubSpot" }] }),
});

function useKey(t) {
  const old = process.env.PERPLEXITY_API_KEY;
  process.env.PERPLEXITY_API_KEY = "EXAMPLE-NOT-A-REAL-KEY";
  t.after(() => {
    if (old === undefined) delete process.env.PERPLEXITY_API_KEY;
    else process.env.PERPLEXITY_API_KEY = old;
  });
}

test("classifyHttpStatus: a refusal is permanent, an outage is transient", () => {
  for (const status of [400, 401, 402, 403, 404, 405, 413, 422]) {
    assert.equal(
      classifyHttpStatus(status),
      FAILURE_KIND.PERMANENT,
      `${status} is the vendor refusing the request — retrying asks the same question again`
    );
  }
  for (const status of [408, 425, 429, 500, 502, 503, 504]) {
    assert.equal(
      classifyHttpStatus(status),
      FAILURE_KIND.TRANSIENT,
      `${status} may well succeed on the next attempt`
    );
  }
  // A status we cannot read is NOT proof of a refusal. Defaulting to permanent
  // would throw away recoverable measurements, which is the worse mistake.
  assert.equal(classifyHttpStatus(undefined), FAILURE_KIND.TRANSIENT);
  assert.equal(classifyHttpStatus("nonsense"), FAILURE_KIND.TRANSIENT);
});

test("failureKindOf: only a tagged error is permanent; transport noise is transient", () => {
  const abort = new Error("The operation was aborted");
  abort.name = "AbortError";
  assert.equal(failureKindOf(abort), FAILURE_KIND.TRANSIENT, "a timeout is retryable");
  assert.equal(failureKindOf(new TypeError("fetch failed")), FAILURE_KIND.TRANSIENT);
  assert.equal(failureKindOf(new SyntaxError("Unexpected end of JSON input")), FAILURE_KIND.TRANSIENT);
  assert.equal(failureKindOf(null), FAILURE_KIND.TRANSIENT);

  const refused = Object.assign(new Error("HTTP 401"), { failureKind: FAILURE_KIND.PERMANENT });
  assert.equal(failureKindOf(refused), FAILURE_KIND.PERMANENT);
  assert.equal(isRetryableFailure(refused), false);
  assert.equal(isRetryableFailure(abort), true);
  assert.ok(Object.isFrozen(FAILURE_KIND));
});

test("a 401 on the answer leg costs exactly ONE call and no backoff", async (t) => {
  useKey(t);
  const calls = stubLegs(t, { answer: httpFail(401), search: searchOk });

  const startedAt = Date.now();
  const result = await probePerplexity("best crm for small business");
  const elapsed = Date.now() - startedAt;

  assert.equal(calls.answer, 1, "a revoked key is not a reason to ask twice more");
  assert.ok(
    elapsed < ONE_BACKOFF_MS,
    `a permanent failure must not sleep; took ${elapsed}ms (old code: ~3000ms)`
  );
  // Still a real, typed failure — failing fast is not failing quietly.
  assert.match(result.error || "", /401/);
  assert.equal(result.error_kind, FAILURE_KIND.PERMANENT);
  assert.equal(result.text, "");
});

test("403 and 4xx request errors also fail on the first response", async (t) => {
  useKey(t);
  for (const status of [403, 400, 404, 422]) {
    const calls = stubLegs(t, { answer: httpFail(status), search: searchOk });
    const result = await probePerplexity("best crm for small business");
    assert.equal(calls.answer, 1, `HTTP ${status} must not be retried`);
    assert.equal(result.error_kind, FAILURE_KIND.PERMANENT);
    assert.match(result.error || "", new RegExp(String(status)));
  }
});

test("a 500 is still retried to exhaustion — the fix narrows retries, it does not remove them", async (t) => {
  useKey(t);
  // Both legs 500 so the two backoff chains overlap and the file pays ~3s once.
  const calls = stubLegs(t, { answer: httpFail(500), search: httpFail(503) });

  const result = await probePerplexity("best crm for small business");

  assert.equal(calls.answer, MAX_ATTEMPTS, "an upstream fault gets the full attempt budget");
  assert.equal(calls.search, MAX_ATTEMPTS, "and so does the citation leg");
  assert.equal(result.error_kind, FAILURE_KIND.TRANSIENT);
  assert.equal(result.citations_state, CITATIONS_STATE.UNVERIFIED);
  assert.equal(
    result.citations_state_reason,
    CITATIONS_STATE_REASON.SEARCH_LEG_FAILED,
    "an outage that was retried to exhaustion is 'failed', not 'rejected'"
  );
});

test("a refused citation leg is unverified AND distinguishable from one that died trying", async (t) => {
  useKey(t);
  const calls = stubLegs(t, { answer: answerOk, search: httpFail(401) });

  const result = await probePerplexity("best crm for small business");

  assert.equal(calls.search, 1, "the citation leg is refused once, not three times");
  // The answer is a real measurement and survives — unchanged from R2.2.2.
  assert.equal(result.text, "HubSpot is great.");
  assert.equal(result.error, null);
  assert.equal(result.citations.length, 0);
  // The empty citation list is still NOT a measured zero...
  assert.equal(result.citations_state, CITATIONS_STATE.UNVERIFIED);
  assert.equal(hasUnverifiedCitations(result), true, "still out of the citation denominator");
  // ...and now says a human must act, not that the vendor wobbled.
  assert.equal(result.citations_state_reason, CITATIONS_STATE_REASON.SEARCH_LEG_REJECTED);
  assert.notEqual(
    CITATIONS_STATE_REASON.SEARCH_LEG_REJECTED,
    CITATIONS_STATE_REASON.SEARCH_LEG_FAILED,
    "a config fault and a vendor outage must not be the same token"
  );
  assert.match(result.citations_state_detail || "", /401/);
});

test("a healthy probe carries error_kind null — a kind is never invented", async (t) => {
  useKey(t);
  const calls = stubLegs(t, { answer: answerOk, search: searchOk });

  const result = await probePerplexity("best crm for small business");

  assert.equal(calls.answer, 1, "a 200 is asked for exactly once");
  assert.equal(calls.search, 1);
  assert.equal(result.error, null);
  assert.equal(result.error_kind, null, "error_kind is null exactly when error is");
  assert.equal(result.citations_state, CITATIONS_STATE.VERIFIED);
});

test("a transient failure that later succeeds still returns the answer", async (t) => {
  useKey(t);
  const calls = stubLegs(t, {
    answer: (n) => (n === 1 ? httpFail(503)() : answerOk()),
    search: searchOk,
  });

  const result = await probePerplexity("best crm for small business");

  assert.equal(calls.answer, 2, "one retry was enough");
  assert.equal(result.text, "HubSpot is great.");
  assert.equal(result.error, null);
  assert.equal(result.error_kind, null);
});

test("no key at all is a permanent failure, not a transient one", async (t) => {
  const old = process.env.PERPLEXITY_API_KEY;
  delete process.env.PERPLEXITY_API_KEY;
  t.after(() => {
    if (old !== undefined) process.env.PERPLEXITY_API_KEY = old;
  });

  const result = await probePerplexity("best crm for small business");
  assert.equal(result.error_kind, FAILURE_KIND.PERMANENT);
  assert.equal(result.citations_state_reason, CITATIONS_STATE_REASON.NOT_CONFIGURED);
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
