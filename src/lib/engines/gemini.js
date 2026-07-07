import { generateContent } from "../gemini.js";

/**
 * Gemini engine adapter wrapping the central generateContent implementation.
 *
 * @param {string} prompt - Input text prompt
 * @param {Object} options - Generation options (jsonMode, temperature, stats, etc.)
 * @param {number} retries - Number of retries
 * @returns {Promise<Object>} Probe result: { text, model_used, citations: [], cost, tokens }
 */
export async function probeGemini(prompt, options = {}, retries = 2) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("GEMINI_API_KEY is not configured.");
    return { text: "", model_used: "gemini-skipped", citations: [], cost: 0.0, tokens: 0 };
  }

  try {
    const res = await generateContent(prompt, options, retries);
    return {
      text: res.text || "",
      model_used: res.model_used || "gemini",
      citations: [],
      cost: res.cost || 0.0,
      tokens: res.tokens || 0
    };
  } catch (e) {
    console.error("[gemini adapter] Error generateContent:", e);
    return { text: "", model_used: "gemini-failed", citations: [], cost: 0.0, tokens: 0 };
  }
}
