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

export function getEnabledEngines() {
  const envVal = process.env.ENGINES_ENABLED;
  const probeMode = process.env.PROBE_MODE || "hybrid";
  
  if (envVal) {
    return envVal
      .split(",")
      .map(s => s.trim().toLowerCase())
      .filter(s => ENGINES.includes(s));
  }
  
  // Default fallbacks based on probe mode
  if (probeMode === "llm_only") {
    return [Engine.GEMINI];
  }
  
  // For hybrid or serp_primary, default to google_ai_overview and gemini
  return [Engine.GOOGLE_AI_OVERVIEW, Engine.GEMINI];
}
