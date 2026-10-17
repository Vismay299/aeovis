/**
 * R10 — Geography, Language, Device, and Surface Measurement Context.
 *
 * Implements:
 *   1. Explicit requested context (country, city, language, device, surface, session policy)
 *   2. Adapter-specific capability matrix and parameter mapping
 *   3. Separation of requested location from observed/egress verification
 *   4. Freezing context to prevent cross-context comparisons or silent fallback overrides
 */

export const DEFAULT_SERP_GEO = "in";
export const DEFAULT_LANGUAGE = "en";
export const DEFAULT_DEVICE = "desktop";
export const DEFAULT_SESSION_POLICY = "fresh_anonymous";

export const SUPPORTED_COUNTRIES = Object.freeze(["in", "us", "uk", "sg", "ae", "ca", "au"]);
export const SUPPORTED_DEVICES = Object.freeze(["desktop", "mobile"]);
export const SUPPORTED_SESSION_POLICIES = Object.freeze(["fresh_anonymous", "fixed_session"]);

/**
 * Adapter capability matrix for location and context control.
 */
export const ADAPTER_CAPABILITIES = Object.freeze({
  aio: {
    countryControl: true,
    cityControl: true,
    languageControl: true,
    deviceControl: true,
    observedLocationAttested: true,
  },
  chatgpt_direct: {
    countryControl: false,
    cityControl: false,
    languageControl: false,
    deviceControl: false,
    observedLocationAttested: false,
  },
  chatgpt_gateway: {
    countryControl: true,
    cityControl: false,
    languageControl: false,
    deviceControl: false,
    observedLocationAttested: false,
  },
  perplexity_direct: {
    countryControl: false,
    cityControl: false,
    languageControl: false,
    deviceControl: false,
    observedLocationAttested: false,
  },
  perplexity_sonar: {
    countryControl: false,
    cityControl: false,
    languageControl: false,
    deviceControl: false,
    observedLocationAttested: false,
  },
});

/**
 * Resolves the SERP geo for a probe (backward compatible).
 */
export function resolveSerpGeo(override, env = process.env) {
  if (typeof override === "string" && override.trim()) {
    return override.trim().toLowerCase();
  }
  const targetEnv = override && typeof override === "object" && !Array.isArray(override) ? override : env;
  return (targetEnv.SERP_GEO || "").trim().toLowerCase() || DEFAULT_SERP_GEO;
}

/**
 * Freezes and validates the full measurement context for an observation or panel.
 */
export function resolveMeasurementContext(input = {}) {
  let country = input.country !== undefined ? String(input.country || "").trim().toLowerCase() : null;
  if (!country) {
    country = resolveSerpGeo(null, input.env || process.env);
  }

  if (!SUPPORTED_COUNTRIES.includes(country)) {
    throw Object.assign(
      new Error(`Unsupported or invalid country code "${country}". Supported: ${SUPPORTED_COUNTRIES.join(", ")}`),
      { code: "INVALID_COUNTRY_CODE", country }
    );
  }

  let language = input.language !== undefined ? String(input.language || "").trim().toLowerCase() : DEFAULT_LANGUAGE;
  if (!language) language = DEFAULT_LANGUAGE;

  let device = input.device !== undefined ? String(input.device || "").trim().toLowerCase() : DEFAULT_DEVICE;
  if (!SUPPORTED_DEVICES.includes(device)) {
    device = DEFAULT_DEVICE;
  }

  let sessionPolicy = input.session_policy || input.sessionPolicy || DEFAULT_SESSION_POLICY;
  if (!SUPPORTED_SESSION_POLICIES.includes(sessionPolicy)) {
    sessionPolicy = DEFAULT_SESSION_POLICY;
  }

  const surface = input.surface || input.engine || "aio";
  const city = input.city ? String(input.city).trim() : null;

  return {
    country,
    city,
    language,
    device,
    surface,
    session_policy: sessionPolicy,
    user_selected: Boolean(input.country || input.language || input.device),
  };
}

/**
 * Builds outgoing parameters for an adapter branch based on frozen context.
 */
export function buildAdapterContextParams(engine, context, branch = "default") {
  const ctx = resolveMeasurementContext(context);
  const adapterKey = `${engine}_${branch}` in ADAPTER_CAPABILITIES ? `${engine}_${branch}` : engine;
  const capability = ADAPTER_CAPABILITIES[adapterKey] || { countryControl: false };

  if (engine === "aio" || engine === "brightdata") {
    return {
      country: ctx.country,
      gl: ctx.country,
      hl: ctx.language,
      device: ctx.device,
      city: ctx.city,
    };
  }

  if (engine === "chatgpt" && branch === "gateway") {
    return {
      user_location: {
        type: "approximate",
        country: ctx.country.toUpperCase(),
      },
    };
  }

  if (engine === "chatgpt" && branch === "direct") {
    return {
      unsupported_location_control: true,
      requested_country: ctx.country,
    };
  }

  if (engine === "perplexity") {
    return {
      unsupported_location_control: true,
      requested_country: ctx.country,
    };
  }

  return {
    country: ctx.country,
    language: ctx.language,
  };
}

/**
 * Builds observation key dimensions ensuring distinct identities across markets/devices.
 */
export function buildObservationContextKey(ctx) {
  const c = resolveMeasurementContext(ctx);
  return `${c.surface}:${c.country}:${c.language}:${c.device}:${c.session_policy}`;
}

/**
 * Verifies observed location against requested location.
 * Mismatches prevent claiming verified location.
 */
export function qualifyLocationAttestation(requestedContext, observedLocation) {
  const requested = resolveMeasurementContext(requestedContext);
  if (!observedLocation) {
    return {
      verified: false,
      state: "unverified",
      label: `Requested ${requested.country.toUpperCase()}; location unverified`,
    };
  }

  const observedCountry = String(observedLocation.country || observedLocation).trim().toLowerCase();
  if (observedCountry !== requested.country) {
    return {
      verified: false,
      state: "mismatch",
      label: `Location mismatch: requested ${requested.country.toUpperCase()}, observed ${observedCountry.toUpperCase()}`,
      mismatch: true,
    };
  }

  return {
    verified: true,
    state: "verified_egress",
    label: `Verified ${requested.country.toUpperCase()}`,
    mismatch: false,
  };
}

/**
 * Checks comparability between two measurement contexts.
 * Disallows silent cross-country or cross-device trend comparisons.
 */
export function assertContextComparability(contextA, contextB) {
  const a = resolveMeasurementContext(contextA);
  const b = resolveMeasurementContext(contextB);

  if (a.country !== b.country) {
    throw Object.assign(
      new Error(`Incompatible measurement comparison: country "${a.country}" cannot be compared to "${b.country}"`),
      { code: "INCOMPATIBLE_COUNTRY_COMPARISON" }
    );
  }

  if (a.device !== b.device) {
    throw Object.assign(
      new Error(`Incompatible measurement comparison: device "${a.device}" cannot be compared to "${b.device}"`),
      { code: "INCOMPATIBLE_DEVICE_COMPARISON" }
    );
  }

  return true;
}

/**
 * Enforces fallback policy between requested market and fallback provider (R10-10).
 * Prevents silent cross-country substitutions (e.g. falling back to US on India failure).
 */
export function handleProviderFallback(requestedContext, fallbackContext) {
  const req = resolveMeasurementContext(requestedContext);
  const fb = resolveMeasurementContext(fallbackContext);

  if (req.country !== fb.country) {
    throw Object.assign(
      new Error(
        `Silent market substitution blocked: requested market "${req.country}" cannot fallback to "${fb.country}". Fallback must be explicit and marked incompatible.`
      ),
      {
        code: "INCOMPATIBLE_MARKET_FALLBACK",
        requested_country: req.country,
        fallback_country: fb.country,
      }
    );
  }

  return fb;
}

/**
 * Resumes execution using the checkpoint's frozen context (R10-09).
 * Ensures that changes to environment defaults do not rewrite in-flight observation identity.
 */
export function resumeCheckpointContext(checkpoint, newEnv = process.env) {
  if (!checkpoint || !checkpoint.measurement_context) {
    throw new Error("Checkpoint lacks frozen measurement_context");
  }

  // Always retain frozen context; never re-evaluate from newEnv defaults
  return resolveMeasurementContext(checkpoint.measurement_context);
}

