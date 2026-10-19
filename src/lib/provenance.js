/**
 * R06 — Versioned Provenance Contract.
 *
 * Defines the shared observation envelope and validation rules across all
 * engine adapters and persistence boundaries. Ensures model identity,
 * search telemetry, capture windows, and provider request IDs survive
 * wrappers without field dropping (resolving regression A11).
 */

export const PROVENANCE_SCHEMA_VERSION = "r06-provenance-v1";

export const SEARCH_STATE = Object.freeze({
  OBSERVED_USED: "observed_used",
  OBSERVED_NOT_USED: "observed_not_used",
  UNKNOWN: "unknown",
});

export const MEASUREMENT_METHOD = Object.freeze({
  MODEL_API: "model_api",
  CONSUMER_CAPTURE: "consumer_capture",
  GOOGLE_SERP: "google_serp",
  UNKNOWN: "unknown",
});

export const LOCATION_VERIFICATION = Object.freeze({
  VERIFIED_EGRESS: "verified_egress",
  PROVIDER_ATTESTED: "provider_attested",
  UNVERIFIED: "unverified",
  MISMATCH: "mismatch",
});

/**
 * Secret and private pattern masks for sanitization/redaction before logging or export.
 */
const REDACTION_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(?:api[_-]?key|secret|password|token|authorization)["']?\s*[:=]\s*["']?[A-Za-z0-9\-._~+/]+=*["']?/gi,
  /(?:cookie|set-cookie)["']?\s*[:=]\s*["']?[^"';\n]+["']?/gi,
];

/**
 * Redacts secrets, auth headers, and session tokens from provider bodies or logs.
 */
export function redactSecrets(data) {
  if (data === null || data === undefined) return data;
  if (typeof data === "string") {
    let sanitized = data;
    for (const pattern of REDACTION_PATTERNS) {
      sanitized = sanitized.replace(pattern, "[REDACTED]");
    }
    return sanitized;
  }
  if (Array.isArray(data)) {
    return data.map(redactSecrets);
  }
  if (typeof data === "object") {
    const out = {};
    for (const [k, v] of Object.entries(data)) {
      const lower = k.toLowerCase();
      if (
        lower.includes("secret") ||
        lower.includes("key") ||
        lower.includes("token") ||
        lower.includes("auth") ||
        lower.includes("cookie")
      ) {
        out[k] = "[REDACTED]";
      } else {
        out[k] = redactSecrets(v);
      }
    }
    return out;
  }
  return data;
}

/**
 * Creates and normalizes a versioned observation provenance envelope.
 */
export function createObservationEnvelope(input = {}) {
  const startedAt = input.started_at ? new Date(input.started_at).toISOString() : new Date().toISOString();
  const completedAt = input.completed_at ? new Date(input.completed_at).toISOString() : new Date().toISOString();

  // Validate timing interval
  const startedMs = new Date(startedAt).getTime();
  const completedMs = new Date(completedAt).getTime();
  if (Number.isFinite(startedMs) && Number.isFinite(completedMs) && completedMs < startedMs) {
    throw Object.assign(new Error("Invalid capture window: completed_at cannot be earlier than started_at"), {
      code: "INVALID_CAPTURE_WINDOW",
    });
  }

  const durationMs = completedMs >= startedMs ? completedMs - startedMs : null;

  // Search state resolution: distinguish absent (unknown) from explicit 0 (observed_not_used)
  let searchState = SEARCH_STATE.UNKNOWN;
  if (input.search_state) {
    searchState = input.search_state;
  } else if (input.search_requests !== undefined && input.search_requests !== null) {
    searchState = Number(input.search_requests) > 0 ? SEARCH_STATE.OBSERVED_USED : SEARCH_STATE.OBSERVED_NOT_USED;
  } else if (input.search_used === true) {
    searchState = SEARCH_STATE.OBSERVED_USED;
  } else if (input.search_used === false) {
    searchState = SEARCH_STATE.OBSERVED_NOT_USED;
  }

  // Model identity preservation: requested model vs observed (returned) model
  const requestedModel = input.requested_model ? String(input.requested_model).trim() : null;
  const returnedModel = input.returned_model ? String(input.returned_model).trim() : null;
  const modelUnknownReason = !returnedModel ? (input.model_unknown_reason || "response_model_unreported") : null;

  // Evidence access and retention
  const retentionExpiresAt = input.retention_expires_at || null;
  const isExpired = retentionExpiresAt ? new Date(retentionExpiresAt).getTime() <= Date.now() : false;

  return {
    schema_version: PROVENANCE_SCHEMA_VERSION,
    observation_id: input.observation_id || null,
    attempt_id: input.attempt_id || null,
    attempt_number: Number.isInteger(input.attempt_number) ? input.attempt_number : 1,
    surface: input.surface || "unknown",
    gateway: input.gateway || "direct",
    method: input.method || MEASUREMENT_METHOD.MODEL_API,

    // Model identity: NEVER substitute requested_model into returned_model!
    requested_model: requestedModel,
    returned_model: returnedModel,
    model_unknown_reason: modelUnknownReason,

    // Location identity: requested vs observed
    requested_location: input.requested_location || "in",
    observed_location: input.observed_location || null,
    language:input.language || null,device:input.device || null,session_policy:input.session_policy || null,
    location_verification: input.location_verification || (input.observed_location ? LOCATION_VERIFICATION.PROVIDER_ATTESTED : LOCATION_VERIFICATION.UNVERIFIED),

    // Telemetry and requests
    provider_request_id: input.provider_request_id || null,
    search_state: searchState,
    search_requests: Number.isFinite(input.search_requests) ? Number(input.search_requests) : null,
    parser_version: input.parser_version || "v1",

    // Cost and pricing
    cost: input.cost !== undefined ? input.cost : null,
    cost_source: input.cost_source || null,
    cost_state: input.cost_state || "unknown",
    cost_state_detail: input.cost_state_detail || null,

    // Timing window
    capture_window: {
      started_at: startedAt,
      completed_at: completedAt,
      duration_ms: durationMs,
    },

    // Retention and evidence
    evidence_identities: Array.isArray(input.evidence_identities) ? [...input.evidence_identities] : [],
    evidence_expired: isExpired,
    evidence_retention_date: retentionExpiresAt,
    retention_reason: isExpired ? (input.retention_reason || "retention_period_elapsed") : null,
  };
}

/**
 * Validates a provenance envelope against required schema invariants.
 */
export function validateObservationEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object") {
    throw new Error("Provenance envelope must be a non-null object");
  }
  if (envelope.schema_version !== PROVENANCE_SCHEMA_VERSION) {
    throw new Error(`Unsupported schema version: ${envelope.schema_version}`);
  }
  if (envelope.capture_window) {
    const { started_at, completed_at, duration_ms } = envelope.capture_window;
    if (started_at && completed_at) {
      const s = new Date(started_at).getTime();
      const c = new Date(completed_at).getTime();
      if (c < s) {
        throw new Error("Invalid capture_window: completed_at earlier than started_at");
      }
      if (duration_ms !== null && duration_ms < 0) {
        throw new Error("Invalid capture_window: negative duration");
      }
    }
  }
  return true;
}

/**
 * Scopes evidence access to workspace and observation ID.
 * Returns false if tenant or observation does not match.
 */
export function checkEvidenceAccess({ userWorkspace, evidenceWorkspace, observationId, evidenceObservationId }) {
  if (!userWorkspace || !evidenceWorkspace || userWorkspace !== evidenceWorkspace) {
    return { allowed: false, reason: "tenant_isolation_denied" };
  }
  if (observationId && evidenceObservationId && observationId !== evidenceObservationId) {
    return { allowed: false, reason: "observation_mismatch_denied" };
  }
  return { allowed: true, reason: null };
}
