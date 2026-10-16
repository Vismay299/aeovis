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

import { VENDORS, credentialStatus } from "../vendorRegistry.js";
import { getLlmBaseUrl, getLlmProvider } from "../llmConfig.js";
import { getOpenRouterEngineModel, isOpenRouterEngineConfigured } from "./openRouterProbe.js";
import { getOpenAiModel } from "./openai.js";
import { getPerplexityModel } from "./perplexity.js";
import { resolveSerpGeo } from "./serpGeo.js";
import { PROVIDER_FAILURE, classifyProviderFailure, operatorActionFor } from "./providerFailure.js";
import { DEFAULT_RETRY_POLICY, planRetry, reconcileCost } from "../attemptPolicy.js";

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
 * src/lib/vendorRegistry.js wherever the registry already describes the
 * credential, so this file does not become a second list of variable names — a
 * new vendor or a renamed canonical variable must not make readiness and
 * /api/health disagree.
 *
 * GEMINI IS THE ONE EXCEPTION, and it is the audit finding in miniature:
 * the registry's `gemini` entry describes the shared-gateway route that
 * ChatGPT and Perplexity take, but `src/lib/engines/gemini.js` has no gateway
 * fallback at all — it reads GEMINI_API_KEY and returns "not configured"
 * without it. Readiness therefore asks the ADAPTER's question per surface, and
 * `direct_variables` records the native keys the adapter's own predicate reads.
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
    provider: "openrouter",
    required_groups: Object.freeze([
      Object.freeze({ env: Object.freeze(["OPENAI_API_KEY"]) }),
      Object.freeze({ registry: "openai" }),
    ]),
    direct_variables: Object.freeze(["OPENAI_API_KEY"]),
    gateway: "openrouter",
  }),
  perplexity: Object.freeze({
    label: "Perplexity",
    provider: "openrouter",
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
    // No registry route on purpose: see the header. The registry's gemini entry
    // is about model ENGINES behind the shared gateway, which this adapter does
    // not implement.
    required_groups: Object.freeze([Object.freeze({ env: Object.freeze(["GEMINI_API_KEY"]) })]),
    direct_variables: Object.freeze(["GEMINI_API_KEY"]),
    gateway: null,
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

/** Is any one credential route for this engine fully configured? */
function routeSatisfied(engine, env) {
  const surface = ENGINE_SURFACES[engine];
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

/**
 * One-way digests of the credentials a surface would use, so a rotation is
 * detectable without the value ever being stored, logged or printed.
 *
 * Returns the NAME of each variable alongside its digest, because an operator
 * needs to know which variable moved without being told what it moved to.
 */
export function credentialFingerprint(engine, env = {}) {
  const parts = [];
  for (const name of credentialNamesFor(engine)) {
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
 * reported as history rather than as current readiness.
 */
export function configVersion(engine, env = {}) {
  const surface = ENGINE_SURFACES[engine];
  if (!surface) return null;
  const fingerprint = credentialFingerprint(engine, env);
  const route = directKeyPresent(engine, env) ? "direct" : "gateway";
  return [
    "v1",
    surface.provider,
    route,
    surface.gateway ? getLlmProvider(getLlmBaseUrl(env)) : "n/a",
    resolvedModel(engine, env) || "unknown-model",
    fingerprint || "unconfigured",
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
 * @returns {{provider: string|null, account: string|null}}
 */
export function circuitIdentity(engine, env = {}) {
  const surface = ENGINE_SURFACES[engine];
  return {
    provider: surface?.provider ?? null,
    account: credentialFingerprint(engine, env),
  };
}

/**
 * Validate one engine's configuration WITHOUT contacting anything (R01.02/R01-03).
 *
 * @param {string} engine
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ok: boolean, configured: boolean, missing: string[], reason: string|null,
 *            detail: string|null, corrective_action: string|null,
 *            provider_requests: 0}}
 */
export function validateEngineConfig(engine, env = {}) {
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
  const plan = planEngineCanary(engine, env);
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
export function planEngineCanary(engine, env = {}) {
  const surface = ENGINE_SURFACES[engine];
  const empty = {
    engine,
    dispatch: false,
    adapter: null,
    provider: surface?.provider ?? null,
    gateway: surface?.gateway ?? null,
    model: null,
    geo: engine === "aio" ? resolveSerpGeo(env) : null,
    config_version: null,
    config_identity: {
      provider: surface?.provider ?? null,
      adapter: null,
      gateway: surface?.gateway ?? null,
      model: null,
      credential_variables: credentialNamesFor(engine),
      credential_fingerprint: null,
    },
    dispatch_plan: [],
    provider_requests: 0,
    refusal: null,
    circuit_identity: circuitIdentity(engine, env),
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

  const adapter = directKeyPresent(engine, env) || !surface.gateway ? "vendor_api" : "shared_gateway";

  if (adapter === "shared_gateway") {
    const gateway = getLlmProvider(getLlmBaseUrl(env));
    const model = resolvedModel(engine, env);
    if (gateway !== "openrouter") {
      return {
        ...empty,
        model,
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
        model,
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
      adapter,
      model,
      config_version: configVersion(engine, env),
      config_identity: {
        provider: surface.provider,
        adapter,
        gateway,
        model,
        credential_variables: credentialNamesFor(engine),
        credential_fingerprint: credentialFingerprint(engine, env),
      },
      dispatch_plan: [{ adapter, provider: surface.provider }],
    };
  }

  // A native-key path. The gateway is not consulted at all here — a missing
  // direct key is handled by `routeSatisfied`, and an engine routed natively
  // must not be refused for a gateway problem it will never encounter.
  const model = resolvedModel(engine, env);
  return {
    ...empty,
    dispatch: true,
    adapter,
    model,
    config_version: configVersion(engine, env),
    config_identity: {
      provider: surface.provider,
      adapter,
      gateway: null,
      model,
      credential_variables: credentialNamesFor(engine),
      credential_fingerprint: credentialFingerprint(engine, env),
    },
    dispatch_plan: [{ adapter, provider: surface.provider }],
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
    const outcome = await runWithinDeadline({ probe, engine, query, remainingMs });
    const attemptEndedAt = now();

    if (outcome.deadline_exceeded) {
      lastClassification = classifyProviderFailure({
        provider: plan.provider,
        error: Object.assign(new Error(`canary exceeded its deadline after ${remainingMs}ms`), {
          name: "TimeoutError",
        }),
      });
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
    charge: reconcileCost({ dispatched: true, cost: null }),
  };

  return {
    engine,
    dispatched: true,
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
export function readinessForEngine({ engine, env = {}, canary = null, now, ttlMs = READY_TTL_MS }) {
  const plan = planEngineCanary(engine, env);
  const nowMs = Date.parse(now);
  const configured = ENGINE_SURFACES[engine] ? routeSatisfied(engine, env) : false;

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

  if (!configured) {
    return {
      ...base,
      readiness: READINESS.BLOCKED,
      reason: "missing_credential",
      detail: `no credential route is configured for ${ENGINE_SURFACES[engine].label}`,
      operator_action: `Set ${credentialNamesFor(engine).join(" or ")}`,
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
      operator_action: canary.action ?? operatorActionFor(canary.kind),
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
export function buildProviderReadiness({ engines = ENGINE_KEYS, env = {}, canaries = {}, now, ttlMs = READY_TTL_MS }) {
  const reports = {};
  const summary = { ready: [], unverified: [], degraded: [], blocked: [], stale: [] };
  for (const engine of engines) {
    const report = readinessForEngine({ engine, env, canary: canaries?.[engine] ?? null, now, ttlMs });
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
