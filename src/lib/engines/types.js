export const Engine = {
  GEMINI: "gemini",
  OPENAI: "openai",
  PERPLEXITY: "perplexity"
};

export const ENGINES = [Engine.GEMINI, Engine.OPENAI, Engine.PERPLEXITY];

export const ENGINE_DEFAULT_WEIGHTS = {
  [Engine.PERPLEXITY]: 0.40,
  [Engine.OPENAI]: 0.35,
  [Engine.GEMINI]: 0.25
};

export function getEnabledEngines() {
  const envVal = process.env.ENGINES_ENABLED;
  if (!envVal) return [Engine.GEMINI];
  const list = envVal
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(s => ENGINES.includes(s));
  return list.length > 0 ? list : [Engine.GEMINI];
}
