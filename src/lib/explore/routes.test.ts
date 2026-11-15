import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveExploreModelRoute,
  resolveExploreRoutes,
  getExploreOpenRouterReserveUsd,
} from "./routes.ts";
import { hashIdentity } from "../db/probeDispatch.js";
import { circuitIdentity } from "../engines/providerReadiness.js";

describe("src/lib/explore/routes.ts", () => {
  const baseDfsEnv = {
    FEATURE_DATAFORSEO_ENGINES: "on",
    DATAFORSEO_API_KEY: "test-dfs-key",
    LLM_API_KEY: "test-or-key",
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
  };

  const baseOrEnv = {
    FEATURE_DATAFORSEO_ENGINES: "off",
    DATAFORSEO_API_KEY: "test-dfs-key",
    LLM_API_KEY: "test-or-key",
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
    OPENROUTER_OPENAI_MODEL: "openai/gpt-4o",
    OPENROUTER_GEMINI_MODEL: "google/gemini-pro",
    OPENROUTER_PERPLEXITY_MODEL: "perplexity/sonar-reasoning-pro",
  };

  it("chooses DataForSEO when flag on, key set, and circuit closed", async () => {
    const res = await resolveExploreModelRoute({
      model: "chatgpt",
      env: baseDfsEnv,
      webSearch: true,
      country: null,
    });
    assert.equal(res.route, "dataforseo");
    assert.equal(res.modelName, "gpt-5.6-luna");
    assert.equal(res.reserveUsd, 0.09);
    assert.equal(res.skipped, null);
  });

  it("falls back to OpenRouter when DataForSEO flag is off", async () => {
    const res = await resolveExploreModelRoute({
      model: "chatgpt",
      env: baseOrEnv,
      webSearch: true,
      country: null,
    });
    assert.equal(res.route, "openrouter");
    assert.equal(res.modelName, "openai/gpt-4o");
    assert.equal(res.reserveUsd, 0.10);
    assert.equal(res.skipped, null);
  });

  it("falls back to OpenRouter when DataForSEO circuit is open", async () => {
    const dfsCircuit = circuitIdentity("chatgpt", baseDfsEnv, { route: "dataforseo" });
    const dfsCircuitKey = hashIdentity(dfsCircuit);

    const res = await resolveExploreModelRoute({
      model: "chatgpt",
      env: baseDfsEnv,
      openCircuits: [dfsCircuitKey],
      webSearch: true,
      country: null,
    });
    assert.equal(res.route, "openrouter");
    assert.equal(res.skipped, null);
  });

  it("skips Gemini when a country is provided", async () => {
    const res = await resolveExploreModelRoute({
      model: "gemini",
      env: baseDfsEnv,
      webSearch: true,
      country: "IN",
    });
    assert.equal(res.route, null);
    assert.equal(res.skipped, "UNSUPPORTED_COUNTRY");
    assert.match(res.skipReason || "", /Gemini doesn’t support country selection/);
  });

  it("allows Gemini when country is null", async () => {
    const res = await resolveExploreModelRoute({
      model: "gemini",
      env: baseDfsEnv,
      webSearch: true,
      country: null,
    });
    assert.equal(res.route, "dataforseo");
    assert.equal(res.skipped, null);
  });

  it("returns NOT_AVAILABLE when no provider route is available", async () => {
    const emptyEnv = {
      FEATURE_DATAFORSEO_ENGINES: "off",
    };
    const res = await resolveExploreModelRoute({
      model: "chatgpt",
      env: emptyEnv,
      webSearch: true,
      country: null,
    });
    assert.equal(res.route, null);
    assert.equal(res.skipped, "NOT_AVAILABLE");
  });

  it("validates EXPLORE_OPENROUTER_RESERVE_USD and rejects invalid values", () => {
    assert.equal(getExploreOpenRouterReserveUsd({}), 0.10);
    assert.equal(getExploreOpenRouterReserveUsd({ EXPLORE_OPENROUTER_RESERVE_USD: "0.25" }), 0.25);

    assert.throws(() => {
      getExploreOpenRouterReserveUsd({ EXPLORE_OPENROUTER_RESERVE_USD: "-1" });
    }, /Invalid EXPLORE_OPENROUTER_RESERVE_USD/);

    assert.throws(() => {
      getExploreOpenRouterReserveUsd({ EXPLORE_OPENROUTER_RESERVE_USD: "not-a-number" });
    }, /Invalid EXPLORE_OPENROUTER_RESERVE_USD/);
  });

  it("resolves multiple explore routes concurrently", async () => {
    const decisions = await resolveExploreRoutes({
      models: ["chatgpt", "gemini", "perplexity"],
      country: "IN",
      webSearch: true,
      env: baseDfsEnv,
    });

    assert.equal(decisions.length, 3);
    assert.equal(decisions[0].model, "chatgpt");
    assert.equal(decisions[0].route, "dataforseo");
    assert.equal(decisions[0].skipped, null);

    assert.equal(decisions[1].model, "gemini");
    assert.equal(decisions[1].route, null);
    assert.equal(decisions[1].skipped, "UNSUPPORTED_COUNTRY");

    assert.equal(decisions[2].model, "perplexity");
    assert.equal(decisions[2].route, "dataforseo");
    assert.equal(decisions[2].skipped, null);
  });
});
