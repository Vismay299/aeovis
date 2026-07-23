import { generateContent, robustJsonParse } from "./openrouter.js";

/**
 * Single choke-point for all LLM JSON generation/extraction in the app.
 * promptGen.js and competitorExtract.js must call only this — never a
 * provider module directly — so the free-model-only policy holds in one place.
 */
export async function llmJson(prompt, options = {}, jsonRetries = 2) {
  // Callers doing creative/varied generation (e.g. prompt-gen) can pass a
  // higher base temperature; callers doing factual extraction (e.g.
  // competitor-name extraction) get the conservative 0.2 default. Either way
  // each retry nudges temperature up slightly for variety on malformed JSON.
  const baseTemperature = options.temperature ?? 0.2;
  for (let i = 0; i <= jsonRetries; i++) {
    const p =
      i === 0
        ? prompt
        : prompt + "\n\nReturn ONLY valid JSON. No prose, no code fences.";
    const { text } = await generateContent(p, {
      ...options,
      jsonMode: true,
      temperature: Math.min(1, baseTemperature + i * 0.1),
    });
    const parsed = robustJsonParse(text);
    if (parsed) return parsed;
  }
  return null;
}

/** Paid content-generation model (Agent Content OS pipeline steps only). */
export function getContentModel() {
  return process.env.CONTENT_MODEL || "anthropic/claude-sonnet-4.5";
}

/**
 * Content-pipeline variant of llmJson: same JSON-retry contract, but routed
 * to the paid CONTENT_MODEL via the existing OpenRouter client. Scoring and
 * prompt-gen callers must keep using llmJson (free model) — this entry point
 * exists ONLY for content steps (coordinate/research/benchmark/draft/review/
 * learn), which need a capable model and track real cost via options.stats.
 */
export async function contentLlmJson(prompt, options = {}, jsonRetries = 2) {
  return llmJson(
    prompt,
    {
      model: getContentModel(),
      // Long-form drafting needs headroom; callers can still override.
      timeout: 120000,
      max_tokens: 8000,
      ...options,
    },
    jsonRetries
  );
}
