/**
 * THE vendor credential registry — one list, two surfaces (R0.1.16, finding S30).
 *
 * Before this file there were two lists. src/server/health.js held a nine-vendor
 * array feeding /api/health, scripts/check-secrets.mjs held its own nine-vendor
 * array in a different shape (`name`/`keys`/`anyKeys` rather than
 * `key`/`env`/`legacy`), and a comment on the health one claimed that adding a
 * vendor there taught BOTH surfaces about it. It did not. The lists happened to
 * agree name-for-name, so the falsehood was invisible; a tenth vendor added to
 * either one would have been reported by one surface and silently absent from
 * the other. That is the same shape of defect as a scan that measures two
 * engines while the page advertises three.
 *
 * The two surfaces really do differ, and the difference is modelled here rather
 * than by keeping two tables:
 *
 *   - WHAT a vendor needs — its env var names, its deprecated aliases, whether
 *     a scan can run without it — is a property of the vendor. It lives below,
 *     once, and both surfaces read it.
 *   - WHETHER the credential WORKS is a live authenticated call, and only
 *     check:secrets makes one. Those calls live in scripts/check-secrets.mjs
 *     keyed by vendor key, because /api/health must never make them: it is
 *     polled, and a poll that spends vendor budget is a different product.
 *     /api/health answers the cheap question — is a credential CONFIGURED —
 *     using credentialStatus() below.
 *
 * Standing rule 1: a vendor here with no live check in check:secrets is not
 * skipped quietly. vendorsWithChecks() in that script refuses to run at all and
 * names the vendor, because a vendor that silently gets no check is exactly the
 * blind spot this file exists to close.
 */

import { LLM_ENV } from "../shared/llmConfig.js";

/**
 * Every vendor this app can talk to, and the env vars that configure it.
 *
 * `env`      — every name that must be non-empty for the vendor to be configured.
 * `legacy`   — canonical name -> deprecated names that still satisfy it. An
 *              alias makes the vendor configured (the deployment works) but is
 *              reported separately, so "running on a name we are removing" does
 *              not render identically to "configured correctly".
 * `required` — a scan cannot run without it. Absence degrades /api/health and is
 *              called out by name in the check:secrets summary.
 *
 * Add a vendor HERE and both /api/health and check:secrets learn about it — and
 * check:secrets then refuses to start until the vendor also has a live check.
 */
export const VENDORS = Object.freeze(
  [
    { key: "supabase", env: ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"], required: true },
    // The utility LLM is provider-neutral (R5.1.1): LLM_API_KEY is canonical and
    // OPENROUTER_API_KEY is a deprecated alias that still configures it. The
    // pair comes from llmConfig.js so this is not a third copy of those names.
    {
      key: "llm",
      env: [LLM_ENV.apiKey.canonical],
      legacy: { [LLM_ENV.apiKey.canonical]: [LLM_ENV.apiKey.legacy] },
      required: true,
    },
    { key: "brightdata", env: ["BRIGHTDATA_API_KEY"], required: true },
    { key: "firecrawl", env: ["FIRECRAWL_API_KEY"], required: false },
    // These are answer engines behind the shared OpenRouter gateway. Their
    // model IDs choose the underlying provider; they do not need native vendor
    // API keys. Keep the same canonical/legacy key pair as the utility LLM.
    {
      key: "perplexity",
      env: [LLM_ENV.apiKey.canonical],
      legacy: { [LLM_ENV.apiKey.canonical]: [LLM_ENV.apiKey.legacy] },
      required: false,
    },
    {
      key: "openai",
      env: [LLM_ENV.apiKey.canonical],
      legacy: { [LLM_ENV.apiKey.canonical]: [LLM_ENV.apiKey.legacy] },
      required: false,
    },
    { key: "gemini", env: [LLM_ENV.apiKey.canonical], legacy: { [LLM_ENV.apiKey.canonical]: [LLM_ENV.apiKey.legacy] }, required: false },
    // GSC: service account (legacy) OR customer OAuth connector. Either path
    // configures GSC; the OAuth path is the self-service customer connector.
    { key: "gsc", env: ["GSC_SERVICE_ACCOUNT_KEY"], required: false },
    { key: "gsc_oauth", env: ["GSC_GOOGLE_CLIENT_ID", "GSC_GOOGLE_CLIENT_SECRET", "GSC_OAUTH_REDIRECT_URI", "GSC_TOKEN_ENCRYPTION_KEY"], required: false },
    { key: "cron", env: ["CRON_SECRET"], required: true },
    { key: "dataforseo", env: ["DATAFORSEO_API_KEY"], required: false },
  ].map((v) => Object.freeze(v))
);

/** Every vendor key, in registry order. */
export const VENDOR_KEYS = Object.freeze(VENDORS.map((v) => v.key));

const present = (env, name) => String(env[name] || "").trim().length > 0;

/**
 * Is this vendor's credential CONFIGURED, and if not, which name is the fix?
 *
 * Shared by /api/health and check:secrets so the two cannot disagree about what
 * "configured" means — the disagreement would show up as a green health check
 * beside an UNCONFIGURED row for the same vendor in the same environment.
 *
 * `missing` names CANONICAL vars only: when a name is unset but a deprecated
 * alias carries the value, the vendor is configured and the alias is reported in
 * `deprecated` instead. Pure — it never warns or logs, because /api/health must
 * stay free of side effects.
 *
 * @param {{env: string[], legacy?: Record<string, string[]>}} vendor
 * @param {Record<string, string|undefined>} env
 * @returns {{configured: boolean, missing: string[], deprecated: string[]}}
 */
export function credentialStatus(vendor, env = {}) {
  const aliasesFor = (name) => (vendor.legacy?.[name] || []).filter((alias) => present(env, alias));
  const unsatisfied = vendor.env.filter((name) => !present(env, name));
  const missing = unsatisfied.filter((name) => aliasesFor(name).length === 0);
  return {
    configured: missing.length === 0,
    missing,
    // Names that ARE carrying the value but are on their way out.
    deprecated: unsatisfied.flatMap(aliasesFor),
  };
}
