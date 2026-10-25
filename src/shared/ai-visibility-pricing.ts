// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/ai-visibility.ts, src/shared/rank-tracking.ts,
//   src/server/features/ai-visibility/services/aiVisibilityCost.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

// Shared code cannot import src/lib/, so the four-row LLM response table lives here and
// src/lib/pricing/dataforseo.ts re-exports its `llmResponseUsd`.

// `claude` stays in this union only because the ported DataForSEO price table and
// `llmResponseUsd` know that slug. Claude is not a Perceev engine (owner decision,
// 25 October 2026): it has no label, picker entry, route or event.
export type AiEngine =
  | "chatgpt"
  | "gemini"
  | "google_ai_overview"
  | "claude"
  | "perplexity";

/** The engines Perceev can actually collect an answer from. */
export type PerceevEngine = Exclude<AiEngine, "claude">;

export const AI_ENGINE_LABELS: Record<PerceevEngine, string> = {
  chatgpt: "ChatGPT",
  gemini: "Gemini",
  google_ai_overview: "Google AI Overviews",
  perplexity: "Perplexity",
};
/**
 * Engines DataForSEO has no LLM Scraper for. Their answers come from the live
 * LLM Responses API, at live API pricing. Each name is also its API model slug.
 */
export type AiModelApiEngine = Extract<AiEngine, "claude" | "perplexity">;
export function aiEngineUsesModelApi(
  engine: AiEngine,
): engine is AiModelApiEngine {
  return engine === "claude" || engine === "perplexity";
}
/**
 * Raw DataForSEO USD for one answer, standard queue. AI Overviews is one
 * organic SERP page ($0.0006) plus the async overview load ($0.0006).
 */
export const AI_RECORD_COST_USD = 0.0012;
/**
 * Raw DataForSEO USD for one live answer, used by manual runs. AI Overviews is
 * one live organic SERP page ($0.002) plus the async overview load ($0.002).
 */
export const AI_LIVE_RECORD_COST_USD = 0.004;

export type LlmResponseModelSlug =
  | "chat_gpt"
  | "claude"
  | "gemini"
  | "perplexity";

/**
 * measured, token-priced: $0.0006 + the model's own bill. Measured with a
 * long-answer prompt at the 4096-token output cap on the model Prompt Explorer
 * sends per slug, then padded ~1.25x without web search and ~1.3x with it,
 * where the searched pages add a variable input bill. Measured bills: gpt-5
 * $0.072 / $0.042, claude-sonnet-4-5 $0.142 / $0.062, gemini-2.5-pro
 * $0.085 / $0.042, sonar-reasoning-pro $0.028 (it always searches).
 */
export const LLM_RESPONSE_USD: Record<
  LlmResponseModelSlug,
  { webSearch: number; noSearch: number }
> = {
  chat_gpt: { webSearch: 0.09, noSearch: 0.05 },
  claude: { webSearch: 0.18, noSearch: 0.08 },
  gemini: { webSearch: 0.11, noSearch: 0.05 },
  perplexity: { webSearch: 0.04, noSearch: 0.04 },
};

/** Estimated USD for one live LLM response at the 4096-token output cap. */
export function llmResponseUsd(
  modelSlug: LlmResponseModelSlug,
  webSearch: boolean,
): number {
  const price = LLM_RESPONSE_USD[modelSlug];
  return webSearch ? price.webSearch : price.noSearch;
}

/**
 * Raw DataForSEO USD for one answer. Claude and Perplexity always use the
 * model API. The other engines are live on Run now and queued otherwise.
 */
export function aiAnswerUsd(
  engine: AiEngine,
  mode: "live" | "queued",
): number {
  if (aiEngineUsesModelApi(engine)) return llmResponseUsd(engine, true);
  return mode === "live" ? AI_LIVE_RECORD_COST_USD : AI_RECORD_COST_USD;
}

/**
 * The provider cost of a check, given one engine per answer. Perceev bills no
 * credits or markup, so provider USD is the whole cost; the sum keeps the
 * per-call rounding OpenSEO applied to it.
 */
export function aiCostForAnswers(
  engines: readonly AiEngine[],
  mode: "live" | "queued",
): { providerCostUsd: number } {
  let providerUsd = 0;
  for (const engine of engines) providerUsd += aiAnswerUsd(engine, mode);
  return { providerCostUsd: Math.round(providerUsd * 1e6) / 1e6 };
}

export type AiScheduleInterval = "daily" | "weekly" | "monthly";

/** Planning figure for monthly cost estimates, not a calendar count. */
export function scheduledChecksPerMonth(
  interval: AiScheduleInterval,
): number {
  return interval === "daily" ? 30 : interval === "weekly" ? 4 : 1;
}
