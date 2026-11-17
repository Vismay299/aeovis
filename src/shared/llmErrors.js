/**
 * Typed LLM failure signal.
 *
 * The reason this class exists: `generateContent` used to return
 * `{ text: "", model_used: "" }` when the API key was missing or every retry
 * was exhausted. Callers cannot tell that apart from "the model answered with
 * nothing", so a total LLM outage was laundered into a clean-looking result —
 * no rivals extracted, a roster of `[self]` alone, and a Share of Voice donut
 * that read a confident 100%. See docs/BUILD_JOURNAL.md (finding B6/A8).
 *
 * Standing rule 1: a code path that can silently do nothing must say so.
 * A caller may still choose to degrade — but it must choose, explicitly,
 * having seen this error.
 */
export class LlmUnavailableError extends Error {
  /**
   * `auth_failed` (401/403) and `permanent_error` (other refusals the gateway
   * understood: 400, 404, 422...) joined the union in R3.6.7 so a revoked key
   * stops arriving labelled `exhausted_retries`, which sent operators to a
   * vendor status page instead of to their own credential. Both carry a
   * `.status`. `exhausted_retries` now means only what it says: a transient
   * failure that used up its whole retry budget. Emitted by
   * src/server/openrouter.js; keep this union in step with what is thrown, since
   * `.reason` is the one field callers branch on.
   *
   * @param {string} message human-readable cause
   * @param {{reason?: "missing_key"|"auth_failed"|"permanent_error"|"exhausted_retries"|"deadline_exceeded"|"unavailable", provider?: string, model?: string, cause?: unknown}} [meta]
   */
  constructor(message, meta = {}) {
    super(message);
    this.name = "LlmUnavailableError";
    /** Machine-readable discriminator; see the union in the param doc. */
    this.reason = meta.reason || "unavailable";
    this.provider = meta.provider || null;
    this.model = meta.model || null;
    if (meta.cause !== undefined) this.cause = meta.cause;
  }
}

/**
 * True when `err` signals the LLM itself was unreachable/unconfigured, as
 * opposed to the LLM answering with something the caller could not use.
 *
 * Matches by name as well as by instance so the check still holds across
 * module-instance boundaries (Next.js can load a module twice — server bundle
 * and route bundle — which makes `instanceof` alone unreliable here).
 */
export function isLlmUnavailable(err) {
  return Boolean(err) && (err instanceof LlmUnavailableError || err.name === "LlmUnavailableError");
}
