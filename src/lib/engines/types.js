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
  
  // Dynamic API Key check fallback
  const list = [Engine.GEMINI];
  if (process.env.OPENAI_API_KEY) list.push(Engine.OPENAI);
  if (process.env.PERPLEXITY_API_KEY) list.push(Engine.PERPLEXITY);
  // BRIGHTDATA_API_KEY only. SERPAPI_KEY is deliberately absent: Bright Data is
  // the chosen SERP provider (docs/decisions/2026-08-29-serp-provider-bright-data.md),
  // so a stale SERPAPI_KEY must read as unconfigured here rather than let a
  // deployment look configured at boot and fail at probe time.
  const serpConfigured = process.env.BRIGHTDATA_API_KEY;
  if (serpConfigured && probeMode !== "llm_only") {
    list.push(Engine.GOOGLE_AI_OVERVIEW);
  }
  return list;
}
