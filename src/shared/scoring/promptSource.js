import { LlmUnavailableError } from "../llmErrors.js";

/**
 * Provenance of a scan's prompt set (R0.3.4, finding B7).
 *
 * The failure this closes: a brand with no persisted prompt pool needs the
 * LLM to generate its questions. When the LLM was off, generateUnbrandedPrompts
 * silently topped the set up from a hardcoded per-industry pack
 * (src/shared/industries.js) and returned it as if it had been generated for
 * that brand. The resulting scan then measured a real brand against generic
 * category questions and published the score with no marking at all.
 *
 * Two honest outcomes replace that, and this module supplies both:
 *   - the LLM is unreachable        -> PromptSourcingUnavailableError, loud, at sourcing
 *   - the static pack was used      -> prompt_source = "static_industry_pack" on the scan
 *
 * Pure except for the error class. No I/O.
 */

export const PROMPT_SOURCE = Object.freeze({
  /** Every prompt came from the LLM (or real SERP seeds derived per brand). */
  LLM_GENERATED: "llm_generated",
  /** At least one prompt came from the hardcoded industry pack. */
  STATIC_INDUSTRY_PACK: "static_industry_pack",
});

/**
 * The `source` value generateUnbrandedPrompts stamps on a prompt it took from
 * the hardcoded industry pack (src/shared/scoring/promptGen.js, the last-resort
 * top-up).
 */
export const STATIC_PACK_SOURCE = "industry_fallback";

/**
 * Classify a resolved prompt set by where its questions actually came from.
 *
 * Deliberately pessimistic: ONE static-pack prompt is enough to mark the whole
 * set `static_industry_pack`. A set that is 90% brand-specific and 10% generic
 * still produced a score partly measured on questions nobody chose for this
 * brand, and the dashboard has to be able to say so.
 *
 * @param {Array<{source?: string}>} queries the scan's unbranded prompt set
 * @returns {{prompt_source: string|null, static_pack_prompts: number, total_prompts: number}}
 */
export function classifyPromptSource(queries) {
  const rows = Array.isArray(queries) ? queries : [];
  const total = rows.length;
  if (total === 0) {
    // No prompts is not "llm_generated" — it is nothing. Standing rule 1.
    return { prompt_source: null, static_pack_prompts: 0, total_prompts: 0 };
  }
  const staticCount = rows.filter((q) => q && q.source === STATIC_PACK_SOURCE).length;
  return {
    prompt_source: staticCount > 0 ? PROMPT_SOURCE.STATIC_INDUSTRY_PACK : PROMPT_SOURCE.LLM_GENERATED,
    static_pack_prompts: staticCount,
    total_prompts: total,
  };
}

/**
 * Raised when a brand needs new prompts and the LLM cannot be reached.
 *
 * Extends LlmUnavailableError so `isLlmUnavailable` still recognises it and
 * the original reason ("missing_key" / "exhausted_retries") survives — the
 * subclass exists to name the STAGE, because "OpenRouter failed" alone leaves
 * an operator guessing which of a scan's several LLM calls died.
 */
export class PromptSourcingUnavailableError extends LlmUnavailableError {
  constructor(brand, cause) {
    super(
      `Cannot source a prompt set for "${brand}": the prompt-generation LLM is unavailable ` +
        `(${cause?.reason || "unavailable"}: ${cause?.message || cause}). Scan aborted rather than ` +
        `scored on the generic industry pack — a generic prompt set is not a measurement of this brand.`,
      { reason: cause?.reason || "unavailable", provider: cause?.provider || null, cause }
    );
    this.name = "PromptSourcingUnavailableError";
    this.stage = "sourcing";
    this.brand = brand;
  }
}
