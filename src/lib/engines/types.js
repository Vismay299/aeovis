export const Engine = {
  GEMINI: "gemini",
  OPENAI: "openai",
  PERPLEXITY: "perplexity",
  GOOGLE_AI_OVERVIEW: "google_ai_overview"
};

export const ENGINES = [
  Engine.GOOGLE_AI_OVERVIEW,
  Engine.PERPLEXITY,
  Engine.OPENAI,
  Engine.GEMINI
];

export const ENGINE_DEFAULT_WEIGHTS = {
  [Engine.PERPLEXITY]: 0.40,
  [Engine.OPENAI]: 0.35,
  [Engine.GEMINI]: 0.25
};

export const ENGINE_HYBRID_WEIGHTS = {
  [Engine.GOOGLE_AI_OVERVIEW]: 0.50,
  [Engine.PERPLEXITY]: 0.25,
  [Engine.OPENAI]: 0.15,
  [Engine.GEMINI]: 0.10
};

/**
 * R1.7.3 — getEnabledEngines() was the dead second engine registry.
 *
 * It had zero production callers outside its own tests: the real gating lives
 * in src/lib/scoring/enginePipeline.js's resolveEnabledEngines(). The function
 * is deleted; the Engine enum and weight tables remain for aggregate.js and
 * qualityGate.js.
 */
