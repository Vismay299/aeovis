import { generateContent, COST_STATE, GEMINI_PROVIDER } from "../gemini.js";

export { COST_STATE, GEMINI_PROVIDER };

/**
 * Record that this probe produced no cost number. Mirrors the counter in
 * src/lib/gemini.js and src/lib/engines/openai.js: a run in which nothing could
 * be priced must not look like a run that was free (standing rule 1).
 */
function noteUnmeasuredCost(stats) {
  if (!stats) return;
  stats.cost_unmeasured_calls = (stats.cost_unmeasured_calls || 0) + 1;
}

/**
 * Gemini engine adapter wrapping the central generateContent implementation.
 *
 * COST (R3.6.5). This adapter used to close both of its exits with a fabricated
 * zero:
 *
 *     cost: res.cost || 0.0                                   // success path
 *     return { text: "", model_used: "gemini-failed", cost: 0.0, tokens: 0 };  // catch
 *
 * The first turned an unreported cost into a measured $0. The second is worse
 * than it looks: `generateContent` did not throw on a dead ladder, it RETURNED
 * `{ text: "", model_used: "" }`, so the catch never ran — a total Gemini outage
 * came out of here as `{ text: "", model_used: "gemini", cost: 0 }`, a free
 * successful answer from a model called "gemini". A caller could not tell an
 * outage, an unset key and a genuinely free call apart.
 *
 * Every exit now carries `cost: null` unless a price was actually computed, plus
 * the `cost_state` that says why, and a failure carries a non-null `error`.
 * `cost` is a number ONLY when `cost_state === COST_STATE.MEASURED`.
 *
 * @param {string} prompt - Input text prompt
 * @param {Object} options - Generation options (jsonMode, temperature, stats, etc.)
 * @param {number} retries - Number of retries
 * @returns {Promise<{text: string, model_used: string, citations: string[],
 *          cost: number|null, cost_source: string|null, cost_state: string,
 *          cost_state_detail: string|null, tokens: number|null,
 *          error: string|null}>}
 */
export async function probeGemini(prompt, options = {}, retries = 2) {
  const stats = options.stats;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn("GEMINI_API_KEY is not configured.");
    noteUnmeasuredCost(stats);
    return {
      text: "",
      model_used: "gemini-skipped",
      citations: [],
      cost: null,
      cost_source: null,
      cost_state: COST_STATE.NOT_CONFIGURED,
      cost_state_detail: "GEMINI_API_KEY is not set, so no request was made",
      tokens: null,
      // A skip is not a success (standing rule 1): the caller must be able to
      // see that this row is an absence of a measurement, not an empty answer.
      error: "GEMINI_API_KEY not set",
    };
  }

  try {
    const res = await generateContent(prompt, options, retries);
    const costState = res.cost_state || COST_STATE.PROBE_FAILED;
    const failed = costState === COST_STATE.PROBE_FAILED || costState === COST_STATE.NOT_CONFIGURED;
    return {
      text: res.text || "",
      // No `|| "gemini"` fallback: an empty model_used means no rung answered,
      // and papering it over with a plausible id is how the outage above came
      // to look like a successful call.
      model_used: res.model_used || null,
      citations: [],
      // `?? null`, never `|| 0.0`: a cost of 0 that was measured survives, and
      // an absent one stays absent.
      cost: res.cost ?? null,
      cost_source: res.cost_source ?? null,
      cost_state: costState,
      cost_state_detail: res.cost_state_detail ?? null,
      tokens: res.tokens ?? null,
      error: failed ? res.cost_state_detail || "Gemini returned no completion" : null,
    };
  } catch (e) {
    console.error("[gemini adapter] Error generateContent:", e);
    noteUnmeasuredCost(stats);
    return {
      text: "",
      model_used: null,
      citations: [],
      cost: null,
      cost_source: null,
      cost_state: COST_STATE.PROBE_FAILED,
      cost_state_detail: e?.message || String(e),
      tokens: null,
      error: e?.message || "Gemini probe failed",
    };
  }
}
