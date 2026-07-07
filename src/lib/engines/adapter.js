import { Engine } from "./types.js";
import { probeGemini } from "./gemini.js";
import { probeOpenAI } from "./openai.js";
import { probePerplexity } from "./perplexity.js";
import { probeGoogleAiOverview } from "./serp.js";

/**
 * Universal engine adapter router to probe different LLM engines.
 *
 * @param {string} engine - Engine enum value (gemini | openai | perplexity | google_ai_overview)
 * @param {string} prompt - Input text prompt
 * @param {Object} options - Mapping options (jsonMode, temperature, stats, etc.)
 * @returns {Promise<Object>} Probe result payload: { text, model_used, citations, cost, tokens }
 */
export async function probeEngine(engine, prompt, options = {}) {
  switch (engine) {
    case Engine.GEMINI:
      return await probeGemini(prompt, options);
    case Engine.OPENAI:
      return await probeOpenAI(prompt, options);
    case Engine.PERPLEXITY:
      return await probePerplexity(prompt, options);
    case Engine.GOOGLE_AI_OVERVIEW:
      return await probeGoogleAiOverview(prompt, options);
    default:
      throw new Error(`Unsupported engine: ${engine}`);
  }
}
