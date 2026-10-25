import test from "node:test";
import assert from "node:assert/strict";
import { BUILT_IN_SERP_QUERY_PRICES } from "../llmPricing.js";
import { costAccuracy } from "./index.ts";
import {
  PERCEEV_ENGINE_PROVIDERS,
  aioMaxQueriesPerAttempt,
  engineProvider,
  modelCallUsd,
  serpQueryUsd,
  toolFeeUsd,
} from "./perceev.ts";

const ENV: Record<string, string | undefined> = {};

test("reads the SERP query price from llmPricing's table", () => {
  assert.equal(
    serpQueryUsd("brightdata", 1, ENV),
    BUILT_IN_SERP_QUERY_PRICES.brightdata,
  );
  assert.equal(
    serpQueryUsd("serpapi", 2, ENV),
    2 * BUILT_IN_SERP_QUERY_PRICES.serpapi,
  );
});

test("a changed SERP_QUERY_PRICES value changes the result", () => {
  assert.equal(
    serpQueryUsd("brightdata", 1, {
      SERP_QUERY_PRICES: '{"brightdata":0.002}',
    }),
    0.002,
  );
});

test("prices a completion from the per-million-token table", () => {
  const usd = modelCallUsd("gpt-4o-mini", 1_000_000, 1_000_000, ENV);
  assert.ok(usd !== null);
  assert.ok(Math.abs(usd - 0.75) < 1e-10);
  assert.equal(modelCallUsd("unpriced-model", 1_000_000, 1_000_000, ENV), null);
});

test("prices a tool from the per-call fee table", () => {
  const usd = toolFeeUsd("gpt-4o-mini", "web_search", 2, ENV);
  assert.ok(usd !== null);
  assert.ok(Math.abs(usd - 0.02) < 1e-10);
  assert.equal(toolFeeUsd("gpt-4o-mini", "no_such_tool", 2, ENV), null);
  assert.equal(toolFeeUsd("unpriced-model", "web_search", 2, ENV), null);
});

test("names the gateway that served an attempt", () => {
  assert.deepEqual(PERCEEV_ENGINE_PROVIDERS, {
    aio: "brightdata",
    chatgpt: "openrouter",
    gemini: "openrouter",
    perplexity: "openrouter",
  });
  assert.equal(aioMaxQueriesPerAttempt, 2);
  assert.equal(engineProvider("chatgpt"), "openrouter");
  assert.equal(engineProvider("aio"), "brightdata");
  assert.equal(engineProvider("chatgpt", "native"), "openrouter");
  assert.equal(engineProvider("chatgpt", "dataforseo"), "dataforseo");
  assert.equal(engineProvider("nope"), "unknown");
});

test("classifies a settled actual against its estimate", () => {
  assert.equal(costAccuracy(0.0035, null), "unknown");
  assert.equal(costAccuracy(0.0035, 0.0035), "within");
  assert.equal(costAccuracy(0.0035, 0.003), "within");
  assert.equal(costAccuracy(0.0035, 0.004), "undershoot");
  // The ledger's own unit is the micro-dollar, so a difference below one is not
  // an undershoot.
  assert.equal(costAccuracy(0.0035, 0.0035004), "within");
  assert.equal(costAccuracy(0.0035, 0.0035006), "undershoot");
});
