import {
  lookupModelPrice,
  resolveSerpQueryCost,
  resolveToolFee,
} from "../llmPricing.js";

/**
 * Adapters over src/shared/llmPricing.js: the token, tool-fee and per-query SERP
 * tables already live there, so nothing here restates a price. An unpriced
 * model returns null; an unpriced tool or SERP provider throws, as
 * llmPricing.js decides, so a caller never inherits a fabricated zero.
 */

export type SerpPriceProvider = "brightdata" | "serpapi";
export type PriceEnv = Record<string, string | undefined>;

// llmPricing.js infers its `env` parameter from its `process.env` default, which
// Next augments with a required NODE_ENV; an operator-declared table needs only the
// map, so the call sites state that instead of demanding a NODE_ENV of every caller.
function priceEnv(env: PriceEnv): NodeJS.ProcessEnv {
  return env as NodeJS.ProcessEnv;
}

/** Raw USD for `queries` billed SERP queries on `provider`. */
export function serpQueryUsd(
  provider: SerpPriceProvider,
  queries = 1,
  env: PriceEnv = process.env,
): number {
  return resolveSerpQueryCost({ provider, queries, env }).cost;
}

/** Raw USD for one completion from the per-million-token table, or null. */
export function modelCallUsd(
  model: string,
  inTok: number,
  outTok: number,
  env: PriceEnv = process.env,
): number | null {
  const price = lookupModelPrice(model, priceEnv(env)) as {
    input: number;
    output: number;
  } | null;
  if (!price) return null;
  return (inTok / 1e6) * price.input + (outTok / 1e6) * price.output;
}

/**
 * Raw USD for `calls` invocations of a built-in provider tool. Delegates to
 * `resolveToolFee`, which owns the per-call table and the multiplication, and
 * throws for an unpriced pair rather than dropping a billed fee.
 */
export function toolFeeUsd(
  model: string,
  tool: string,
  calls: number,
  env: PriceEnv = process.env,
): number {
  return resolveToolFee({
    model,
    tool,
    provider: "openrouter",
    calls,
    env: priceEnv(env),
  }).cost;
}

/** The gateway each answer engine's probe calls by default. */
export const PERCEEV_ENGINE_PROVIDERS = {
  aio: "brightdata",
  chatgpt: "openrouter",
  gemini: "openrouter",
  perplexity: "openrouter",
} as const;

/**
 * The provider that actually served an attempt: DataForSEO when F02 routed it
 * there (it records `result.provenance.gateway = "dataforseo"`), otherwise the
 * engine's own gateway. An engine with neither reads "unknown", never a guess.
 */
export function engineProvider(
  engine: string,
  route?: "native" | "dataforseo",
): string {
  if (route === "dataforseo") return "dataforseo";
  return (PERCEEV_ENGINE_PROVIDERS as Record<string, string>)[engine] ?? "unknown";
}

/** The rendered attempt plus its same-deadline standard fallback. */
export const aioMaxQueriesPerAttempt = 2;
