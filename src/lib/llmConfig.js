/**
 * Provider-neutral LLM configuration (R5.1.1, findings C4/S19).
 *
 * The utility LLM is any OpenAI-compatible chat/completions gateway. It was
 * configured by OPENROUTER_BASE_URL / OPENROUTER_MODEL / OPENROUTER_API_KEY
 * while the deployed base URL was https://api.xiaomimimo.com/v1 — the name
 * said one vendor and the traffic went to another, and every reader had to
 * know that to reason about the client at all.
 *
 * The canonical names are LLM_BASE_URL / LLM_MODEL / LLM_API_KEY. The
 * OPENROUTER_* names keep working as a DEPRECATED fallback so an existing
 * deployment does not break the moment this ships; using one warns exactly
 * once per process so the operator learns without a log flood.
 *
 * Provider-specific request quirks are still real (MiMo needs
 * max_completion_tokens and thinking-disable; only OpenRouter honours
 * `usage.include`) — they are derived HERE, from the base URL, once, instead
 * of being re-sniffed at each call site under a vendor-shaped variable name.
 * See docs/vendors/mimo.md.
 */

export const DEFAULT_LLM_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_LLM_MODEL = "google/gemma-4-31b-it:free";

/**
 * canonical name -> deprecated name it replaces. Exported so /api/health,
 * check:secrets and the docs all name the same pair instead of each keeping
 * their own copy.
 */
export const LLM_ENV = Object.freeze({
  baseUrl: Object.freeze({ canonical: "LLM_BASE_URL", legacy: "OPENROUTER_BASE_URL" }),
  model: Object.freeze({ canonical: "LLM_MODEL", legacy: "OPENROUTER_MODEL" }),
  apiKey: Object.freeze({ canonical: "LLM_API_KEY", legacy: "OPENROUTER_API_KEY" }),
});

const warned = new Set();

/** Test seam: forget which deprecation warnings have already been emitted. */
export function resetLlmConfigWarnings() {
  warned.clear();
}

const clean = (value) => String(value ?? "").trim();

/**
 * Read the canonical var, falling back to the deprecated one.
 *
 * A fallback that happens invisibly is the same failure as the name that lied:
 * when only the legacy name carries the value we say so, once, on stderr. The
 * warning is suppressed when `warn` is false (pure readers such as
 * vendorFlags, which must stay side-effect free).
 */
export function readLlmEnv({ canonical, legacy }, env = process.env, { warn = true } = {}) {
  const primary = clean(env[canonical]);
  if (primary) return { value: primary, name: canonical, deprecated: false };

  const fallback = clean(env[legacy]);
  if (fallback) {
    if (warn && !warned.has(legacy)) {
      warned.add(legacy);
      console.warn(
        `[llmConfig] ${legacy} is DEPRECATED and will be removed — rename it to ${canonical}. ` +
          `It is read only because ${canonical} is unset.`
      );
    }
    return { value: fallback, name: legacy, deprecated: true };
  }

  return { value: null, name: null, deprecated: false };
}

/** Configured gateway base URL, trailing slashes stripped. */
export function getLlmBaseUrl(env = process.env) {
  return (readLlmEnv(LLM_ENV.baseUrl, env).value || DEFAULT_LLM_BASE_URL).replace(/\/+$/, "");
}

/** Configured model id for the utility (scoring / prompt-gen) path. */
export function getLlmModel(env = process.env) {
  return readLlmEnv(LLM_ENV.model, env).value || DEFAULT_LLM_MODEL;
}

/**
 * The API key, or null when neither name is set. Null, never "" — an
 * unconfigured key is not an empty credential, and the caller must throw on it
 * rather than send an anonymous request (R0.3.1).
 */
export function getLlmApiKey(env = process.env) {
  return readLlmEnv(LLM_ENV.apiKey, env).value;
}

/**
 * Which gateway a base URL points at. This is the ONLY place the app sniffs a
 * hostname; `generateContent` asks once and branches on the answer.
 *
 * "custom" is a deliberate third value: an OpenAI-compatible gateway we have
 * no quirk knowledge of gets the plain, portable request shape — not
 * OpenRouter's extensions, and not MiMo's.
 */
export function getLlmProvider(baseUrl = getLlmBaseUrl()) {
  const url = String(baseUrl || "");
  if (url.includes("openrouter.ai")) return "openrouter";
  if (url.includes("xiaomimimo.com")) return "mimo";
  return "custom";
}
