/**
 * R01.3a/b + R01.4a — provider readiness, separated from liveness.
 *
 * `/api/health` answered "ok" while every persisted provider call was failing
 * authentication, because the only question it could answer was whether a
 * credential variable was SET. That is a liveness answer to a readiness
 * question, and the audit's own words for it are exact: "configured credentials
 * were reported healthy while persisted calls failed authentication". This
 * module is the missing half — what a probe ACTUALLY observed, kept separately
 * from what the environment claims.
 *
 * THE TWO PATHS, and why they must not merge:
 *
 *   READ  (readinessForEngine / buildProviderReadiness) is PURE. It never
 *         dispatches anything, so a health poll cannot spend vendor budget or
 *         count as a canary (R01-12). It answers from the stored canary record.
 *   WRITE (runCanary) is the ONLY dispatcher. It refuses before dispatch when
 *         the configuration is not usable (R01-02/R01-03), bounds itself by a
 *         deadline, records every attempt, and returns the record a READ will
 *         later interpret.
 *
 * A READ with no canary reports UNVERIFIED and `last_success_at: null`. It does
 * NOT invent a timestamp, and it does not upgrade "the variable is set" into
 * "the provider works" — the audit's finding in one sentence.
 *
 * CONFIGURATION IDENTITY, NOT CREDENTIAL VALUES (R01.1b). Readiness has to
 * notice that a credential ROTATED, because the backlog makes A's result
 * historical the moment B is configured (R01-14), and the old result must not
 * be presented as current. The only way to notice a rotation without storing or
 * printing the value is to keep a one-way digest of it. `credential_fingerprint`
 * is a SHA-256 hex digest; it is not the value, not a prefix of the value, and
 * not reversible, and it never appears in an operator message — only in
 * `config_version`, which exists to be compared and never to be read as a
 * credential.
 */

import { createHash } from "node:crypto";

import { VENDORS, credentialStatus } from "../../server/vendorRegistry.js";
import { resolveNodeEnv } from "../../server/operatorPerimeter.js";
import { getLlmBaseUrl, getLlmProvider } from "../llmConfig.js";
import { DATAFORSEO_APPROVED_ENGINES, getOpenRouterEngineModel, isOpenRouterEngineConfigured } from "./openRouterProbe.js";
import { OPENAI_PROVIDER, getOpenAiModel } from "./openai.js";
import { PERPLEXITY_PROVIDER, getPerplexityModel } from "./perplexity.js";
import { resolveSerpGeo } from "./serpGeo.js";
import { PROVIDER_FAILURE, classifyProviderFailure, operatorActionFor } from "./providerFailure.js";
import { DEFAULT_RETRY_POLICY, planRetry, reconcileCost } from "../../server/attemptPolicy.js";

/**
 * The distinct states the backlog requires (R01.3b). `configured` is a separate
 * boolean rather than a sixth state, because "the variable is set" and "we know
 * it works" are two independent facts and a single enum invites exactly the
 * collapse this repair is about.
 */
export const READINESS = Object.freeze({
  UNVERIFIED: "unverified",
  READY: "ready",
  DEGRADED: "degraded",
  BLOCKED: "blocked",
  STALE: "stale",
});

/** How long a valid canary counts as CURRENT readiness. */
export const READY_TTL_MS = 60 * 60 * 1000;

/** Whether an observed location was verified, or only requested (R10 contract). */
export const LOCATION_STATE = Object.freeze({
  UNVERIFIED: "unverified",
  VERIFIED: "verified",
});

/**
 * The offered surfaces, one entry per thing a scan can actually call.
 *
 * `required_groups` lists credential ROUTES, not variables: an engine is
 * configured when EVERY name in AT LEAST ONE group is set. The groups come from
 * src/server/vendorRegistry.js wherever the registry already describes the
 * credential, so this file does not become a second list of variable names — a
 * new vendor or a renamed canonical variable must not make readiness and
 * /api/health disagree.
 *
 * Gemini's offered scan surface uses the shared OpenRouter adapter in
 * enginePipeline.js. The standalone native gemini.js utility is not the
 * offered scan adapter; a GEMINI_API_KEY must not verify that surface.
 *
 * `provider` names the vendor the NATIVE adapter actually calls, and is taken
 * from the adapter module's own constant so the two cannot drift; `gateway`
 * names the shared gateway a surface MAY fall back to (null when it has none).
 * A route's provider is chosen from the selected route, never hard-coded per
 * surface: ChatGPT's native probe calls api.openai.com, so its provider is
 * `openai`, and only its shared route is OpenRouter.
 */
export const ENGINE_SURFACES = Object.freeze({
  aio: Object.freeze({
    label: "Google AI Overview",
    provider: "brightdata",
    required_groups: Object.freeze([Object.freeze({ registry: "brightdata" })]),
    direct_variables: Object.freeze([]),
    gateway: null,
  }),
  chatgpt: Object.freeze({
    label: "ChatGPT",
    provider: OPENAI_PROVIDER,
    required_groups: Object.freeze([
      Object.freeze({ env: Object.freeze(["OPENAI_API_KEY"]) }),
      Object.freeze({ registry: "openai" }),
    ]),
    direct_variables: Object.freeze(["OPENAI_API_KEY"]),
    gateway: "openrouter",
  }),
  perplexity: Object.freeze({
    label: "Perplexity",
    provider: PERPLEXITY_PROVIDER,
    required_groups: Object.freeze([
      Object.freeze({ env: Object.freeze(["PERPLEXITY_API_KEY"]) }),
      Object.freeze({ registry: "perplexity" }),
    ]),
    direct_variables: Object.freeze(["PERPLEXITY_API_KEY"]),
    gateway: "openrouter",
  }),
  gemini: Object.freeze({
    label: "Gemini",
    provider: "gemini",
    required_groups: Object.freeze([Object.freeze({ registry: "gemini" })]),
    direct_variables: Object.freeze([]),
    gateway: "openrouter",
  }),
});

/** Every offered engine key, in surface order. */
export const ENGINE_KEYS = Object.freeze(Object.keys(ENGINE_SURFACES));

/**
 * The canary's probe text. Deliberately a fixed, obvious string: a canary
 * measures whether the PROVIDER answers, never anything about a brand, so the
 * text carries no client meaning and cannot be mistaken for a measurement.
 */
export const CANARY_QUERY = "readiness canary";

function dataforseoRouteRefusal(engine, env = {}) {
  if (!DATAFORSEO_APPROVED_ENGINES.includes(engine)) {
    return {
      reason: "engine_not_approved",
      detail: `DataForSEO is not approved for ${ENGINE_SURFACES[engine]?.label ?? engine}`,
      corrective_action: "Use an approved DataForSEO engine route",
    };
  }
  const mode = String(env?.FEATURE_DATAFORSEO_ENGINES ?? "").trim().toLowerCase();
  const enabled = mode === "on" || (!mode && resolveNodeEnv(env) !== "production");
  if (!enabled) {
    return {
      reason: "feature_disabled",
      detail: "DataForSEO answer engines are disabled",
      corrective_action: "Set FEATURE_DATAFORSEO_ENGINES=on",
    };
  }
  return null;
}

const present = (env, name) => String(env?.[name] ?? "").trim().length > 0;

function registryEntry(key) {
  return VENDORS.find((v) => v.key === key) || null;
}

/**
 * The variable names that configure this engine, in the order an operator
 * should try them. Names only — this function is safe to log.
 */
export function credentialNamesFor(engine) {
  const surface = ENGINE_SURFACES[engine];
  if (!surface) return [];
  return surface.required_groups.flatMap((group) =>
    group.registry ? (registryEntry(group.registry)?.env ?? []) : group.env
  );
}

export function effectiveEngineRoute(engine, env, opts = {}) {
  if (opts.route) return opts.route;
  const raw = env?.ANSWER_ENGINE_ROUTES ?? process.env.ANSWER_ENGINE_ROUTES;
  if (!raw) return undefined;
  const match = raw.split(";").map((s) => s.trim()).find((s) => s.startsWith(`${engine}=`));
  if (!match) return undefined;
  const routes = match.split("=")[1]?.split(">").map((s) => s.trim()).filter(Boolean);
  return routes?.[0];
}

/** Is any one credential route for this engine fully configured? */
function routeSatisfied(engine, env, opts = {}) {
  const route = opts.route ?? effectiveEngineRoute(engine, env, opts);
  if (route === "dataforseo") {
    return present(env, "DATAFORSEO_API_KEY");
  }
  const surface = ENGINE_SURFACES[engine];
  if (!surface) return false;
  for (const group of surface.required_groups) {
    if (group.registry) {
      const vendor = registryEntry(group.registry);
      if (vendor && credentialStatus(vendor, env).configured) return true;
      continue;
    }
    if (group.env.every((name) => present(env, name))) return true;
  }
  return false;
}

/** Is the engine's own native key set, i.e. does the adapter's direct path exist? */
function directKeyPresent(engine, env) {
  const surface = ENGINE_SURFACES[engine];
  return surface.direct_variables.length > 0 && surface.direct_variables.every((name) => present(env, name));
}

/** The variable that actually CARRIES a registry route's credential, canonical first, then alias. */
function effectiveRegistryNames(vendor, env) {
  const names = [];
  for (const name of vendor.env) {
    if (present(env, name)) {
      names.push(name);
      continue;
    }
    const alias = (vendor.legacy?.[name] || []).find((candidate) => present(env, candidate));
    if (alias) names.push(alias);
  }
  return names;
}

/** The effective variable names of one credential route, once it is satisfied. */
function groupCredentialNames(group, env) {
  if (group.registry) {
    const vendor = registryEntry(group.registry);
    return vendor ? effectiveRegistryNames(vendor, env) : [];
  }
  return group.env.filter((name) => present(env, name));
}

/**
 * The single route the adapter would take for `engine`, and the effective
 * credential variables that route actually uses.
 *
 * Provider, model, gateway and credential all come from THIS selection, so the
 * plan, `config_version` and the circuit describe the endpoint that will really
 * be called. A native key is not the shared gateway, and a deprecated alias the
 * adapter still accepts is not "unconfigured" merely because the canonical name
 * it renames is absent.
 */
export function dataforseoModelLabel(engine) {
  if (engine === "chatgpt") return "llm_scraper:chatgpt";
  if (engine === "gemini") return "llm_scraper:gemini";
  if (engine === "aio") return "serp:google_organic:async_aio";
  return `llm_responses:${engine}:catalogue`;
}

export function resolveRoute(engine, env, opts = {}) {
  const surface = ENGINE_SURFACES[engine];
  if (!surface) return { adapter: null, provider: null, gateway: null, model: null, credential_names: [] };

  if (opts.route === "dataforseo") {
    const creds = present(env, "DATAFORSEO_API_KEY") ? ["DATAFORSEO_API_KEY"] : [];
    return {
      adapter: "vendor_api",
      provider: "dataforseo",
      gateway: null,
      model: opts.model ?? dataforseoModelLabel(engine),
      credential_names: creds,
    };
  }

  if (opts.route === "openrouter") {
    const registryGroup = surface.required_groups.find((group) => group.registry);
    return {
      adapter: "shared_gateway",
      provider: getLlmProvider(getLlmBaseUrl(env)),
      gateway: surface.gateway || "openrouter",
      model: opts.model ?? resolvedModel(engine, env),
      credential_names: registryGroup ? groupCredentialNames(registryGroup, env) : [],
    };
  }

  if (opts.route === "vendor_api" || opts.route === "brightdata") {
    const direct = surface.direct_variables.filter((name) => present(env, name));
    const credentialNames = direct.length
      ? direct
      : (surface.required_groups.map((group) => groupCredentialNames(group, env)).find((names) => names.length) ?? []);
    return {
      adapter: "vendor_api",
      provider: surface.provider,
      gateway: null,
      model: opts.model ?? resolvedModel(engine, env),
      credential_names: credentialNames,
    };
  }

  if (directKeyPresent(engine, env) || !surface.gateway) {
    // Native path. The credential is the direct variable when the surface has
    // one (ChatGPT, Perplexity, Gemini) and otherwise the registry route the
    // adapter reads (Bright Data) — never a second, separately maintained list.
    const direct = surface.direct_variables.filter((name) => present(env, name));
    const credentialNames = direct.length
      ? direct
      : (surface.required_groups.map((group) => groupCredentialNames(group, env)).find((names) => names.length) ?? []);
    return {
      adapter: "vendor_api",
      provider: surface.provider,
      gateway: null,
      model: opts.model ?? resolvedModel(engine, env),
      credential_names: credentialNames,
    };
  }

  // Shared-gateway path: the gateway that will be called, not a hard-coded
  // surface label. The credential is the registry route's effective variable, so
  // a legacy alias is fingerprinted under the name that actually carries it.
  const registryGroup = surface.required_groups.find((group) => group.registry);
  return {
    adapter: "shared_gateway",
    provider: getLlmProvider(getLlmBaseUrl(env)),
    gateway: surface.gateway,
    model: opts.model ?? resolvedModel(engine, env),
    credential_names: registryGroup ? groupCredentialNames(registryGroup, env) : [],
  };
}

/**
 * One-way digests of the credentials the SELECTED route would use, so a rotation
 * is detectable without the value ever being stored, logged or printed.
 *
 * The names come from `resolveRoute`, not from `credentialNamesFor`: the adapter
 * accepts a canonical name OR its deprecated alias, and it is the variable that
 * actually carries the value that must be fingerprinted. Canonical names alone
 * made a legacy-only deployment read as unconfigured and could not see the alias
 * rotate, so two different legacy-key accounts shared one unidentified circuit.
 *
 * Returns the NAME of each variable alongside its digest, because an operator
 * needs to know which variable moved without being told what it moved to.
 */
export function credentialFingerprint(engine, env = {}, opts = {}) {
  const parts = [];
  for (const name of resolveRoute(engine, env, opts).credential_names) {
    if (!present(env, name)) continue;
    const digest = createHash("sha256").update(`${name}:${String(env[name])}`).digest("hex").slice(0, 16);
    parts.push(`${name}#${digest}`);
  }
  return parts.length ? parts.join(",") : null;
}

/**
 * The configuration IDENTITY behind `engine` right now: everything that decides
 * which provider is called and with what, and nothing that could leak a
 * credential value.
 *
 * R01-14 turns on this string. A rotation changes the digest, so a stored
 * canary's `config_version` no longer matches and its result is HISTORICAL —
 * reported as history rather than as current readiness. The provider in the
 * string is the SELECTED route's, so a native key and the shared gateway cannot
 * share a version.
 */
export function configVersion(engine, env = {}, opts = {}) {
  const surface = ENGINE_SURFACES[engine];
  if (!surface) return null;
  const route = resolveRoute(engine, env, opts);
  return [
    "v1",
    route.provider || "unknown-provider",
    route.adapter === "shared_gateway" ? "gateway" : "direct",
    route.gateway || "n/a",
    route.model || "unknown-model",
    credentialFingerprint(engine, env, opts) || "unconfigured",
  ].join(":");
}

/** The model id the selected adapter would send, or null when it is not ours to name. */
function resolvedModel(engine, env) {
  const surface = ENGINE_SURFACES[engine];
  if (!surface) return null;
  if (surface.gateway && !directKeyPresent(engine, env)) return getOpenRouterEngineModel(engine, env);
  if (engine === "chatgpt") return getOpenAiModel(env);
  if (engine === "perplexity") return getPerplexityModel(env);
  // Gemini's id is chosen inside the generateContent ladder, which this module
  // does not own. "unknown" is the honest answer; inventing a default here would
  // be a second opinion about what to call.
  return null;
}

/** A `provider/model` id, which is what the shared gateway requires. */
const GATEWAY_MODEL_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

/**
 * The circuit identity behind `engine` (R02.5a): provider plus ACCOUNT.
 *
 * Deliberately NOT `configVersion`. `config_version` carries the model so that
 * a model change invalidates an old readiness measurement; a circuit must not,
 * because a revoked shared credential fails every model on it. Two engines
 * routed through the same credential share one circuit here, which is what lets
 * the first 401 stop the second engine instead of letting it spend a call to
 * learn the same thing.
 *
 * @param {string} engine
 * @param {Record<string, string|undefined>} [env]
 * @param {object} [opts]
 * @returns {{provider: string|null, account: string|null}}
 */
export function circuitIdentity(engine, env = {}, opts = {}) {
  const route = resolveRoute(engine, env, opts);
  return {
    provider: route.provider ?? null,
    account: credentialFingerprint(engine, env, opts),
  };
}

/**
 * Validate one engine's configuration WITHOUT contacting anything (R01.02/R01-03).
 *
 * @param {string} engine
 * @param {Record<string, string|undefined>} [env]
 * @param {object} [opts]
 * @returns {{ok: boolean, configured: boolean, missing: string[], reason: string|null,
 *            detail: string|null, corrective_action: string|null,
 *            provider_requests: 0}}
 */
export function validateEngineConfig(engine, env = {}, opts = {}) {
  if (!ENGINE_SURFACES[engine]) {
    return {
      ok: false,
      configured: false,
      missing: [],
      reason: "unsupported_engine",
      detail: `${engine} is not an offered surface`,
      corrective_action: `Choose one of the offered engines: ${ENGINE_KEYS.join(", ")}`,
      provider_requests: 0,
    };
  }
  if (opts.route === "dataforseo") {
    const routeRefusal = dataforseoRouteRefusal(engine, env);
    const configured = present(env, "DATAFORSEO_API_KEY");
    return {
      ok: configured && !routeRefusal,
      configured,
      missing: configured ? [] : ["DATAFORSEO_API_KEY"],
      reason: routeRefusal?.reason ?? (configured ? null : "missing_credential"),
      detail: routeRefusal?.detail ?? (configured ? null : "DataForSEO has no DATAFORSEO_API_KEY configured"),
      corrective_action: routeRefusal?.corrective_action ?? (configured ? null : "Set DATAFORSEO_API_KEY"),
      provider_requests: 0,
    };
  }
  if (!routeSatisfied(engine, env)) {
    const names = credentialNamesFor(engine);
    return {
      ok: false,
      configured: false,
      missing: names,
      reason: "missing_credential",
      detail: `${ENGINE_SURFACES[engine].label} has no usable credential route configured`,
      // Names the variable, never a value — the audit's rule for a blocked
      // engine is "blocked with the variable name".
      corrective_action: `Set ${names.join(" or ")}`,
      provider_requests: 0,
    };
  }
  const plan = planEngineCanary(engine, env, opts);
  return {
    ok: plan.dispatch,
    configured: true,
    missing: [],
    reason: plan.refusal?.reason ?? null,
    detail: plan.refusal?.detail ?? null,
    corrective_action: plan.refusal?.corrective_action ?? null,
    provider_requests: 0,
  };
}

/**
 * Decide, before anything is dispatched, which single adapter will serve this
 * engine and whether it is supported at all (R01.3a/R01-04).
 *
 * ALWAYS EXACTLY ONE TARGET when `dispatch` is true. "Selected once" is a
 * property of the plan, not a hope about the caller: a plan with two targets is
 * how one prompt becomes two paid calls, so `dispatch_plan` is built as a
 * single-entry array and every refusal returns an empty one.
 *
 * @returns {{
 *   engine: string, dispatch: boolean, adapter: "shared_gateway"|"vendor_api"|null,
 *   provider: string|null, gateway: string|null, model: string|null, geo: string|null,
 *   config_version: string|null,
 *   config_identity: {provider: string|null, adapter: string|null, gateway: string|null,
 *                     model: string|null, credential_variables: string[],
 *                     credential_fingerprint: string|null},
 *   circuit_identity: {provider: string|null, account: string|null},
 *   dispatch_plan: Array<{adapter: string, provider: string}>, provider_requests: 0,
 *   refusal: null|{reason: string, detail: string, corrective_action: string}
 * }}
 */
export function planEngineCanary(engine, env = {}, opts = {}) {
  const surface = ENGINE_SURFACES[engine];
  const route = resolveRoute(engine, env, opts);
  const gatewayUsed = route.adapter === "shared_gateway" ? route.provider : null;
  const empty = {
    engine,
    dispatch: false,
    adapter: route.adapter,
    provider: route.provider,
    gateway: gatewayUsed,
    model: route.model,
    geo: engine === "aio" ? resolveSerpGeo(env) : null,
    config_version: null,
    config_identity: {
      provider: route.provider,
      adapter: route.adapter,
      gateway: gatewayUsed,
      model: route.model,
      credential_variables: route.credential_names,
      credential_fingerprint: credentialFingerprint(engine, env, opts),
    },
    dispatch_plan: [],
    provider_requests: 0,
    refusal: null,
    circuit_identity: circuitIdentity(engine, env, opts),
  };

  if (!surface) {
    return {
      ...empty,
      refusal: {
        reason: "unsupported_engine",
        detail: `${engine} is not an offered surface`,
        corrective_action: `Choose one of the offered engines: ${ENGINE_KEYS.join(", ")}`,
      },
    };
  }

  if (opts.route === "dataforseo") {
    const routeRefusal = dataforseoRouteRefusal(engine, env);
    if (routeRefusal) return { ...empty, refusal: routeRefusal };
    if (!present(env, "DATAFORSEO_API_KEY")) {
      return {
        ...empty,
        refusal: {
          reason: "missing_credential",
          detail: "DataForSEO has no configured credential route",
          corrective_action: "Set DATAFORSEO_API_KEY",
        },
      };
    }
    return {
      ...empty,
      dispatch: true,
      config_version: configVersion(engine, env, opts),
      dispatch_plan: [{ adapter: route.adapter, provider: route.provider }],
    };
  }

  if (!routeSatisfied(engine, env)) {
    const names = credentialNamesFor(engine);
    return {
      ...empty,
      refusal: {
        reason: "missing_credential",
        detail: `${surface.label} is offered but has no configured credential route`,
        corrective_action: `Set ${names.join(" or ")}`,
      },
    };
  }

  if (route.adapter === "shared_gateway") {
    const gateway = route.provider;
    const model = route.model;
    if (gateway !== "openrouter") {
      return {
        ...empty,
        refusal: {
          reason: "unsupported_gateway",
          detail: `${surface.label} would be routed through "${gateway}", which does not implement the shared answer-engine contract`,
          corrective_action: `Point LLM_BASE_URL at an OpenRouter gateway, or set ${surface.direct_variables.join(" or ")} to use the native API`,
        },
      };
    }
    if (!model || !GATEWAY_MODEL_RE.test(model)) {
      return {
        ...empty,
        refusal: {
          reason: "unsupported_model",
          detail: `${surface.label} is configured with model "${model || "(none)"}" on the "${gateway}" gateway, which needs a provider/model id`,
          corrective_action: `Set the model for ${surface.label} to a provider/model id (e.g. "openai/gpt-6-luna")`,
        },
      };
    }
    return {
      ...empty,
      dispatch: true,
      config_version: configVersion(engine, env, opts),
      dispatch_plan: [{ adapter: route.adapter, provider: route.provider }],
    };
  }

  // A native-key path. The gateway is not consulted at all here — a missing
  // direct key is handled by `routeSatisfied`, and an engine routed natively
  // must not be refused for a gateway problem it will never encounter.
  return {
    ...empty,
    dispatch: true,
    config_version: configVersion(engine, env, opts),
    dispatch_plan: [{ adapter: route.adapter, provider: route.provider }],
  };
}

/**
 * A measurement is only a measurement when the probe says so affirmatively
 * (R04.1b, whose rule readiness inherits): a 200 with an unrecognised shape is
 * an absence of evidence, never a valid no-AIO result. The canary calls this on
 * every response, which is what makes R01-11's malformed 200 unable to leave
 * readiness `ready`.
 */
export function isValidMeasurement(result) {
  return Boolean(result) && result.valid === true;
}

/** The canary's own bounded attempt budget — the same policy the worker will use per pair. */
function policyFor(deps = {}) {
  return deps.policy || DEFAULT_RETRY_POLICY;
}

/**
 * Turn one probe outcome into a classification, whichever shape the adapter
 * used: a thrown error, a failure carrier, or a body that arrived and could not
 * be read.
 */
function classifyAttempt({ probeResult, thrown, plan }) {
  if (thrown) return classifyProviderFailure({ provider: plan.provider, error: thrown });
  if (probeResult?.provider_failure?.ambiguous_call === true) {
    return { ...probeResult.provider_failure, retryable: false };
  }
  const carrier = probeResult?.failure || {};
  // A failure carrier that names a status or a body is evidence about a real
  // response, and must be classified as such — treating it as a parse error
  // would relabel every reported 503 as an unreadable body. The parse verdict is
  // reserved for the case the R04.1b rule is about: a 200 that carries no
  // affirmative measurement AND no stated failure.
  const carrierEvidence = ["status", "headers", "body", "error"].some((key) => named(carrier, key));
  return classifyProviderFailure({
    provider: plan.provider,
    status: carrier.status ?? probeResult?.status ?? null,
    headers: carrier.headers ?? null,
    body: carrier.body ?? null,
    error: carrier.error ? toError(carrier.error) : null,
    parseError:
      probeResult?.valid === false && !carrierEvidence
        ? new Error("response body was not a readable measurement")
        : null,
  });
}

/** A carrier's `error` may be a string from an adapter's envelope; normalise it. */
function toError(value) {
  if (!value) return null;
  if (value instanceof Error) return value;
  return new Error(String(value));
}

/** Is this field actually present? `undefined` and `null` are both absent. */
function named(source, key) {
  const value = source?.[key];
  return value !== undefined && value !== null;
}

/**
 * Race the probe against the remaining deadline.
 *
 * The probe promise is wrapped so that it can neither reject unhandled nor be
 * lost: a probe that settles after the deadline has already fired resolves the
 * wrapper to a value nobody reads, which is the honest representation of
 * "dispatch happened, result unknown" rather than a crash.
 */
async function runWithinDeadline({ probe, engine, query, remainingMs }) {
  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ deadline_exceeded: true }), Math.max(0, remainingMs));
  });
  const settled = Promise.resolve()
    .then(() => probe({ engine, query, deadline_ms: remainingMs }))
    .then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    );
  try {
    const raced = await Promise.race([settled, deadline]);
    if (raced.deadline_exceeded) return { deadline_exceeded: true };
    return raced;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Dispatch ONE bounded canary for one engine (R01.4a) and return its record.
 *
 * This is the only function in the readiness path that can spend vendor budget,
 * and it is never called by a health read. It refuses before dispatch whenever
 * the plan refuses, so a blocked engine cannot produce a provider request
 * (R01-02/R01-03).
 *
 * Every attempt is kept, including the failures before a success, because
 * "503 then a valid fixture" is two calls and the readiness claim has to be
 * about the SECOND one (R01-10). The retry decision is attemptPolicy's, so the
 * canary cannot drift from the policy the worker will apply per pair.
 *
 * @param {object} input
 * @param {string} input.engine
 * @param {Record<string, string|undefined>} [input.env]
 * @param {(args: {engine: string, query: string, deadline_ms: number}) => Promise<object>} input.probe
 * @param {string} [input.query]
 * @param {number} [input.deadlineMs] absolute deadline on the injected clock
 * @param {(ms: number) => Promise<void>} [input.sleep] test seam for backoff
 * @param {() => number} [input.now] test seam for the clock
 */
export async function runCanary({
  engine,
  env = {},
  probe,
  query = CANARY_QUERY,
  deadlineMs,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  policy = DEFAULT_RETRY_POLICY,
} = {}) {
  const plan = planEngineCanary(engine, env);
  const startedAtMs = now();
  const startedAt = new Date(startedAtMs).toISOString();
  const deadline = Number.isFinite(deadlineMs) ? deadlineMs : startedAtMs + 60_000;

  if (typeof probe !== "function") {
    throw new Error("runCanary: a probe function is required — a canary cannot be read into existence");
  }
  if (!plan.dispatch) {
    return {
      engine,
      dispatched: false,
      requests: 0,
      attempts: [],
      observation: null,
      canary: null,
      readiness: READINESS.BLOCKED,
      refusal: plan.refusal,
      started_at: startedAt,
      ended_at: startedAt,
      // Nothing left the process, so there is no possible charge (R02-21).
      charge: reconcileCost({ dispatched: false, cost: null }),
    };
  }

  const attempts = [];
  let observation = null;
  let lastClassification = null;
  let requestId = null;
  let attemptNumber = 0;
  let elapsed = false;

  for (;;) {
    attemptNumber += 1;
    const attemptStartedAt = now();
    const remainingMs = deadline - attemptStartedAt;

    // A canary that cannot finish inside its own deadline is not current
    // readiness evidence, so it is not dispatched at all. Checked before EVERY
    // attempt — including one after a backoff, whose sleep may have carried the
    // clock past the deadline even when the retry policy believed it fit.
    if (remainingMs <= 0) {
      elapsed = true;
      lastClassification = lastClassification ?? deadlineClassification(plan, remainingMs);
      break;
    }

    const outcome = await runWithinDeadline({ probe, engine, query, remainingMs });
    const attemptEndedAt = now();

    // The result must land inside the deadline to count. The probe is invoked
    // ahead of the deadline timer, so a fast result can win the race after
    // expiry; rejecting it here keeps a late observation from becoming readiness.
    if (outcome.deadline_exceeded || attemptEndedAt > deadline) {
      lastClassification = deadlineClassification(plan, deadline - attemptEndedAt);
      attempts.push(attemptRecord({ attemptNumber, attemptStartedAt, attemptEndedAt, classification: lastClassification }));
      elapsed = true;
      break;
    }

    requestId = outcome.ok ? outcome.value?.request_id ?? requestId : requestId;

    if (outcome.ok && isValidMeasurement(outcome.value)) {
      observation = {
        disposition: outcome.value.no_aio === true ? "valid_no_aio" : "answered",
        valid: true,
        no_aio: outcome.value.no_aio === true,
      };
      attempts.push({ attempt: attemptNumber, started_at: iso(attemptStartedAt), ended_at: iso(attemptEndedAt), ok: true, kind: null });
      break;
    }

    lastClassification = classifyAttempt({ probeResult: outcome.ok ? outcome.value : null, thrown: outcome.ok ? null : outcome.error, plan });
    attempts.push(attemptRecord({ attemptNumber, attemptStartedAt, attemptEndedAt, classification: lastClassification }));

    const decision = planRetry({
      policy,
      failure: lastClassification,
      attemptNumber,
      nowMs: attemptEndedAt,
      deadlineMs: deadline,
    });
    if (!decision.retry) {
      attempts[attempts.length - 1].stop_reason = decision.reason;
      break;
    }
    await sleep(decision.delay_ms);
  }

  const endedAtMs = now();
  const endedAt = new Date(endedAtMs).toISOString();
  const outcome = observation ? "valid" : "failed";

  const canary = {
    engine,
    surface: ENGINE_SURFACES[engine].label,
    provider: plan.provider,
    adapter: plan.adapter,
    model: plan.model,
    config_version: plan.config_version,
    config_identity: plan.config_identity,
    outcome,
    kind: observation ? null : lastClassification?.kind ?? null,
    action: observation ? null : operatorActionFor(lastClassification?.kind ?? PROVIDER_FAILURE.TRANSIENT),
    attempts: attempts.length,
    requests: attempts.length,
    request_id: requestId,
    started_at: startedAt,
    ended_at: endedAt,
    // The observation time is the END of the attempt that produced the
    // measurement, on the injected clock. Never `Date.now()`, and never a
    // moment nobody measured.
    observed_at: observation ? endedAt : null,
    deadline_exceeded: elapsed,
    observation,
    // Requested location is frozen for the whole canary and reported separately
    // from the observed one, which stays UNVERIFIED unless a provider actually
    // attested it. Nothing here may rewrite the request to rescue a failure.
    location: {
      requested: plan.geo,
      observed: null,
      status: LOCATION_STATE.UNVERIFIED,
    },
    attempt_history: attempts,
    failure: lastClassification,
    charge: reconcileCost({ dispatched: attempts.length > 0, cost: null }),
  };

  return {
    engine,
    dispatched: attempts.length > 0,
    requests: attempts.length,
    attempts,
    observation,
    canary,
    readiness: observation ? READINESS.READY : READINESS.DEGRADED,
    refusal: null,
    started_at: startedAt,
    ended_at: endedAt,
    charge: canary.charge,
  };
}

/** The timeout failure a canary carries when its deadline is reached without a measurement. */
function deadlineClassification(plan, remainingMs) {
  return classifyProviderFailure({
    provider: plan.provider,
    error: Object.assign(new Error(`canary exceeded its deadline with ${remainingMs}ms remaining`), {
      name: "TimeoutError",
    }),
  });
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function attemptRecord({ attemptNumber, attemptStartedAt, attemptEndedAt, classification }) {
  return {
    attempt: attemptNumber,
    started_at: iso(attemptStartedAt),
    ended_at: iso(attemptEndedAt),
    ok: false,
    kind: classification.kind,
    retryable: classification.retryable,
    status: classification.status,
    provider_code: classification.provider_code,
    retry_after_ms: classification.retry_after_ms,
    reset_observed: classification.reset_observed,
    message: classification.message,
  };
}

/**
 * READ one engine's readiness. PURE — no probe, no client, no clock of its own.
 *
 * @param {object} input
 * @param {string} input.engine
 * @param {Record<string, string|undefined>} [input.env]
 * @param {object|null} [input.canary] the record `runCanary` returned as `canary`
 * @param {string} input.now ISO timestamp
 * @param {number} [input.ttlMs]
 */
export function readinessForEngine({ engine, env = {}, canary = null, now, ttlMs = READY_TTL_MS, opts = {} }) {
  const effectiveRoute = opts.route ?? effectiveEngineRoute(engine, env, opts);
  const routeOpts = effectiveRoute ? { ...opts, route: effectiveRoute } : opts;
  const plan = planEngineCanary(engine, env, routeOpts);
  const nowMs = Date.parse(now);
  const configured = ENGINE_SURFACES[engine]
    ? effectiveRoute === "dataforseo"
      ? present(env, "DATAFORSEO_API_KEY")
      : routeSatisfied(engine, env, routeOpts)
    : false;
  const dataforseoRefusal =
    effectiveRoute === "dataforseo" ? dataforseoRouteRefusal(engine, env) : null;

  const base = {
    engine,
    label: ENGINE_SURFACES[engine]?.label ?? engine,
    configured,
    readiness: READINESS.UNVERIFIED,
    current: false,
    historical: false,
    reason: null,
    detail: null,
    operator_action: null,
    provider: plan.provider,
    adapter: plan.adapter,
    model: plan.model,
    config_version: plan.config_version,
    last_success_at: null,
    measured_at: null,
    ready_age_ms: null,
    expires_at: null,
    canary_observed_at: canary?.observed_at ?? null,
    canary_outcome: canary?.outcome ?? null,
    canary_kind: canary?.kind ?? null,
    canary: canary ?? null,
    provider_requests: 0,
  };

  if (!ENGINE_SURFACES[engine]) {
    return {
      ...base,
      readiness: READINESS.BLOCKED,
      reason: "unsupported_engine",
      detail: `${engine} is not an offered surface`,
      operator_action: `Choose one of the offered engines: ${ENGINE_KEYS.join(", ")}`,
    };
  }

  if (dataforseoRefusal) {
    return {
      ...base,
      readiness: READINESS.BLOCKED,
      reason: dataforseoRefusal.reason,
      detail: dataforseoRefusal.detail,
      operator_action: dataforseoRefusal.corrective_action,
    };
  }

  if (!configured) {
    const credNames = effectiveRoute === "dataforseo" ? ["DATAFORSEO_API_KEY"] : credentialNamesFor(engine);
    return {
      ...base,
      readiness: READINESS.BLOCKED,
      reason: "missing_credential",
      detail: `no credential route is configured for ${ENGINE_SURFACES[engine].label}`,
      operator_action: `Set ${credNames.join(" or ")}`,
    };
  }

  if (plan.refusal) {
    return {
      ...base,
      readiness: READINESS.BLOCKED,
      reason: plan.refusal.reason,
      detail: plan.refusal.detail,
      operator_action: plan.refusal.corrective_action,
    };
  }

  // A canary from a DIFFERENT configuration is history, not readiness. This is
  // the rotation rule (R01-14): the old success must not be presented as
  // evidence about the new credential, and the new one stays unverified until
  // its own check succeeds.
  if (canary && canary.config_version !== plan.config_version) {
    return {
      ...base,
      readiness: READINESS.UNVERIFIED,
      historical: true,
      reason: "config_changed",
      detail:
        "a canary was observed under a different configuration; its result is historical and does not verify the current one",
      operator_action: "Run a fresh canary for the current configuration",
    };
  }

  if (!canary || canary.outcome !== "valid" || !canary.observed_at) {
    if (!canary) {
      return {
        ...base,
        reason: "no_canary",
        detail: "the credential is present but no probe has ever verified it",
        operator_action: "Run a canary",
      };
    }
    return {
      ...base,
      readiness: READINESS.DEGRADED,
      reason: canary.kind || "canary_failed",
      detail: canary.failure?.message ?? "the last canary produced no valid measurement",
      operator_action: canary.action ?? canary.failure?.action ?? operatorActionFor(canary.kind || canary.failure?.kind) ?? "Investigate the last failure, then run a bounded canary",
    };
  }

  const measuredMs = Date.parse(canary.observed_at);
  const ageMs = Number.isFinite(measuredMs) && Number.isFinite(nowMs) ? nowMs - measuredMs : null;
  const expired = ageMs === null || ageMs > ttlMs;

  return {
    ...base,
    readiness: expired ? READINESS.STALE : READINESS.READY,
    current: !expired,
    historical: false,
    reason: expired ? "canary_expired" : null,
    detail: expired
      ? `the last valid measurement is older than the ${ttlMs}ms readiness window`
      : null,
    operator_action: expired ? "Run a fresh canary" : null,
    last_success_at: canary.observed_at,
    measured_at: canary.observed_at,
    ready_age_ms: ageMs,
    expires_at: Number.isFinite(measuredMs) ? new Date(measuredMs + ttlMs).toISOString() : null,
  };
}

/**
 * READ every offered engine. PURE, and the shape a health poll should carry.
 *
 * `provider_requests: 0` is not decoration: it is the number this function made,
 * and R01-12 asserts a hundred calls to it leave the provider untouched.
 */
export function buildProviderReadiness({ engines = ENGINE_KEYS, env = {}, canaries = {}, now, ttlMs = READY_TTL_MS, opts = {} }) {
  const reports = {};
  const summary = { ready: [], unverified: [], degraded: [], blocked: [], stale: [] };
  for (const engine of engines) {
    const report = readinessForEngine({ engine, env, canary: canaries?.[engine] ?? null, now, ttlMs, opts: opts[engine] || opts });
    reports[engine] = report;
    const bucket = summary[report.readiness];
    if (bucket) bucket.push(engine);
  }

  return {
    observed_at: now,
    ttl_ms: ttlMs,
    engines: reports,
    summary,
    degraded_reason: degradedReason(summary, reports),
    // The measured count of provider calls this READ made. Pinned to 0 by the
    // code path itself: nothing in this module reaches a network.
    provider_requests: 0,
  };
}

/**
 * One sentence for the surface that most needs an operator, or null.
 *
 * Blocked outranks stale, which outranks degraded: a deployment with a broken
 * credential must not be summarised by a merely aged canary on another engine.
 */
function degradedReason(summary, reports) {
  for (const [bucket, lead] of [
    [summary.blocked, "is blocked"],
    [summary.stale, "has no current measurement"],
    [summary.degraded, "is degraded"],
  ]) {
    if (bucket.length === 0) continue;
    const engine = bucket[0];
    const report = reports[engine];
    return `${report.label} ${lead}: ${report.detail || report.reason}; ${report.operator_action || "investigate"}`;
  }
  return null;
}
