import test from "node:test";
import assert from "node:assert/strict";
import { checkEngineAdvertising, VENDOR_CHECKS } from "../../scripts/check-secrets.mjs";

test("checkEngineAdvertising: ENGINES=perplexity without route credentials returns MISMATCH", () => {
  const env = {
    ENGINES: "perplexity",
    NEXT_PUBLIC_ENGINES: "perplexity",
  };
  const res = checkEngineAdvertising(env);
  assert.equal(res.ok, false);
  assert.match(res.line, /^MISMATCH:/);
  assert.match(res.line, /perplexity/i);
});

test("checkEngineAdvertising: perplexity=dataforseo>openrouter with only LLM_API_KEY passes because fallback funds it", () => {
  const env = {
    ENGINES: "perplexity",
    NEXT_PUBLIC_ENGINES: "perplexity",
    ANSWER_ENGINE_ROUTES: "perplexity=dataforseo>openrouter",
    LLM_API_KEY: "sk-or-test-key",
  };
  const res = checkEngineAdvertising(env);
  assert.equal(res.ok, true);
  assert.match(res.line, /^in step:/);
});

test("check-secrets: DataForSEO vendor check produces verdict and never leaks login or balance", async () => {
  assert.equal(typeof VENDOR_CHECKS.dataforseo, "function");

  // Run against unconfigured env (should fail gracefully)
  const prevKey = process.env.DATAFORSEO_API_KEY;
  try {
    delete process.env.DATAFORSEO_API_KEY;
    const res = await VENDOR_CHECKS.dataforseo();
    assert.ok(res.verdict === "PASS" || res.verdict === "FAIL");
    assert.doesNotMatch(res.detail || "", /login/i);
    assert.doesNotMatch(res.detail || "", /balance/i);
  } finally {
    if (prevKey !== undefined) process.env.DATAFORSEO_API_KEY = prevKey;
  }
});
