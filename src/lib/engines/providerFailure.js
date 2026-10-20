/**
 * R01.2a/b — the ONE failure classifier for provider calls.
 *
 * The audit's first finding is a vocabulary problem, not a network problem:
 * "configured credentials were reported healthy while every persisted call
 * failed authentication or key limits". A 401 from a revoked key, a 403 from a
 * consent wall, a 429 from a key over its credit limit and a 429 from a busy
 * moment were all one undifferentiated "transient-ish error" three layers
 * apart, so nothing downstream could tell an operator what to fix — and
 * `httpFailureKind.js` had only two answers to give (transient/permanent) for
 * a question that has at least eight distinct causes.
 *
 * This module answers the RICHER question — what KIND of failure is this, what
 * does an operator do about it, may it be retried, and did the provider tell us
 * when to come back — while the RETRY verdict itself stays exactly where it
 * was. `retryable` here is derived from `classifyHttpStatus`/`failureKindOf` in
 * httpFailureKind.js, never re-decided: a second opinion about whether a 403 is
 * worth retrying is the defect that module's own header warns about, and it is
 * invisible until a scan burns its budget on a revoked key.
 *
 * WHY A BARE 403 AND A BARE 429 ARE NOT ONE CAUSE EACH: they are TWO causes
 * each, and the provider says which. `403` alone is a refusal by policy
 * (PERMISSION); `403` carrying a challenge/consent/CAPTCHA code or text is an
 * ACCESS CHALLENGE, which the backlog requires to stay distinguishable because
 * one is fixed by a permission grant and the other by a human walking through a
 * login. `429` alone is throttling (RATE_LIMIT, retryable, with the provider's
 * reset time if it gave one); `429` carrying a spend-limit code is a key or
 * credit limit (SPEND_LIMIT, NOT retryable — retrying a spent key is how the
 * production incident produced 60/74/102 identical key-limit errors per engine).
 * The kind is only ever taken from the allowlist below, so a classifier cannot
 * invent a category from prose it half-recognised.
 *
 * Messages are built here rather than at the call site so that naming the
 * provider and stripping credential material is not something every adapter has
 * to remember. `sanitizeProviderText` is deliberately belt-and-braces: a
 * provider body that echoes the request's Authorization header must not reach a
 * log or a persisted row, and "it never echoes that" is not an argument a
 * previous incident leaves available.
 */

import { FAILURE_KIND, classifyHttpStatus, failureKindOf } from "./httpFailureKind.js";

/**
 * The closed vocabulary. Every classification returns one of these, so a caller
 * switching on the kind cannot silently fall through on a new spelling.
 *
 * REQUEST is the one kind beyond the backlog's list, and it exists so that
 * 400/404/422 do not have to be reported as "permission" — a malformed request
 * is a permanent refusal (same retry verdict as permission) but an operator
 * fixes it in the request body, not in an access grant.
 */
export const PROVIDER_FAILURE = Object.freeze({
  AUTHENTICATION: "authentication",
  PERMISSION: "permission",
  CHALLENGE: "challenge",
  SPEND_LIMIT: "spend_limit",
  RATE_LIMIT: "rate_limit",
  TRANSIENT: "transient",
  TIMEOUT: "timeout",
  PARSE: "parse",
  REQUEST: "request",
  PROVIDER_CAPACITY: "provider_capacity",
});

/**
 * Per-kind policy: may it be retried, does it open a provider circuit, and what
 * does an operator DO. `action` is the backlog's R01.4b list spelled as tokens
 * (repair credentials, review limits, wait for reset, investigate provider
 * capacity) so a runbook can be generated from it instead of from prose.
 *
 * `opens_circuit` is true only for the permanent credential/budget faults the
 * backlog names (R02.5a). A challenge does NOT open a circuit: it is a fact
 * about one attempt's access state, and stopping dependent engines for it would
 * be guessing that a credential is broken.
 *
 * PARSE is retryable on purpose: R04 requires the retry policy be exhausted
 * before a terminal parse failure, and requires the LAST attempt to satisfy the
 * same validation as the first. What parse may never do is become a
 * measurement — see `brand_absence` below.
 */
const POLICY = Object.freeze({
  [PROVIDER_FAILURE.AUTHENTICATION]: Object.freeze({
    retryable: false,
    opens_circuit: true,
    action: "repair_credentials",
    label: "credential rejected",
  }),
  [PROVIDER_FAILURE.PERMISSION]: Object.freeze({
    retryable: false,
    opens_circuit: true,
    action: "repair_permissions",
    label: "refused by permission policy",
  }),
  [PROVIDER_FAILURE.CHALLENGE]: Object.freeze({
    retryable: false,
    opens_circuit: false,
    action: "review_access_challenge",
    label: "access challenge (CAPTCHA / consent / login) stood in the way",
  }),
  [PROVIDER_FAILURE.SPEND_LIMIT]: Object.freeze({
    retryable: false,
    opens_circuit: true,
    action: "review_limits",
    label: "key or credit limit reached",
  }),
  [PROVIDER_FAILURE.RATE_LIMIT]: Object.freeze({
    retryable: true,
    opens_circuit: false,
    action: "wait_for_reset",
    label: "temporary throttling",
  }),
  [PROVIDER_FAILURE.TRANSIENT]: Object.freeze({
    retryable: true,
    opens_circuit: false,
    action: "retry",
    label: "transient upstream failure",
  }),
  [PROVIDER_FAILURE.TIMEOUT]: Object.freeze({
    retryable: true,
    opens_circuit: false,
    action: "retry",
    label: "timed out",
  }),
  [PROVIDER_FAILURE.PARSE]: Object.freeze({
    retryable: true,
    opens_circuit: false,
    action: "retry",
    label: "response body could not be read as a result",
  }),
  [PROVIDER_FAILURE.REQUEST]: Object.freeze({
    retryable: false,
    opens_circuit: false,
    action: "repair_request_shape",
    label: "request shape refused",
  }),
  [PROVIDER_FAILURE.PROVIDER_CAPACITY]: Object.freeze({
    retryable: true,
    opens_circuit: false,
    action: "investigate_provider_capacity",
    label: "provider could not serve this request path",
  }),
});

/** Every kind, in table order. Frozen so a caller cannot grow the vocabulary at runtime. */
export const PROVIDER_FAILURE_KINDS = Object.freeze(Object.keys(POLICY));

/**
 * The provider-code allowlist (R01.2a). Codes only — never prose — because a
 * substring match over an error body is how "insufficient_scope" ends up read
 * as "insufficient_quota" and a permissions fix gets filed as a billing one.
 * Keys are normalised (lower-case, non-alphanumerics collapsed to `_`) so
 * `insufficientQuota`, `insufficient-quota` and `INSUFFICIENT_QUOTA` are one
 * entry here rather than three guesses at a call site.
 */
const PROVIDER_CODE_KINDS = Object.freeze({
  // authentication — the credential was understood and refused
  invalid_api_key: PROVIDER_FAILURE.AUTHENTICATION,
  invalid_authentication: PROVIDER_FAILURE.AUTHENTICATION,
  api_key_invalid: PROVIDER_FAILURE.AUTHENTICATION,
  authentication_error: PROVIDER_FAILURE.AUTHENTICATION,
  authentication_failed: PROVIDER_FAILURE.AUTHENTICATION,
  unauthorized: PROVIDER_FAILURE.AUTHENTICATION,
  invalid_token: PROVIDER_FAILURE.AUTHENTICATION,
  token_expired: PROVIDER_FAILURE.AUTHENTICATION,
  // permission — the credential was accepted and this action is not allowed
  permission_denied: PROVIDER_FAILURE.PERMISSION,
  permission_error: PROVIDER_FAILURE.PERMISSION,
  insufficient_scope: PROVIDER_FAILURE.PERMISSION,
  forbidden: PROVIDER_FAILURE.PERMISSION,
  not_authorized: PROVIDER_FAILURE.PERMISSION,
  // challenge — an access barrier, not a credential fault
  challenge_required: PROVIDER_FAILURE.CHALLENGE,
  access_challenge: PROVIDER_FAILURE.CHALLENGE,
  captcha_required: PROVIDER_FAILURE.CHALLENGE,
  captcha: PROVIDER_FAILURE.CHALLENGE,
  consent_required: PROVIDER_FAILURE.CHALLENGE,
  login_required: PROVIDER_FAILURE.CHALLENGE,
  // spend — key or credit limits, permanent until a human acts
  insufficient_quota: PROVIDER_FAILURE.SPEND_LIMIT,
  quota_exceeded: PROVIDER_FAILURE.SPEND_LIMIT,
  quota_reached: PROVIDER_FAILURE.SPEND_LIMIT,
  credit_limit_exceeded: PROVIDER_FAILURE.SPEND_LIMIT,
  credit_limit_reached: PROVIDER_FAILURE.SPEND_LIMIT,
  billing_hard_limit_reached: PROVIDER_FAILURE.SPEND_LIMIT,
  billing_not_active: PROVIDER_FAILURE.SPEND_LIMIT,
  key_limit_exceeded: PROVIDER_FAILURE.SPEND_LIMIT,
  budget_exhausted: PROVIDER_FAILURE.SPEND_LIMIT,
  // rate — temporary, and the provider may have said when to return
  rate_limit_exceeded: PROVIDER_FAILURE.RATE_LIMIT,
  rate_limited: PROVIDER_FAILURE.RATE_LIMIT,
  too_many_requests: PROVIDER_FAILURE.RATE_LIMIT,
  request_limit_reached: PROVIDER_FAILURE.RATE_LIMIT,
  // provider capacity — the request path is unavailable, not the credential
  no_ready_cookies: PROVIDER_FAILURE.PROVIDER_CAPACITY,
  ready_cookies_unavailable: PROVIDER_FAILURE.PROVIDER_CAPACITY,
  proxy_session_error: PROVIDER_FAILURE.PROVIDER_CAPACITY,
  zone_rejected: PROVIDER_FAILURE.PROVIDER_CAPACITY,
  zone_not_found: PROVIDER_FAILURE.PROVIDER_CAPACITY,
  invalid_zone: PROVIDER_FAILURE.PROVIDER_CAPACITY,
  no_active_zone: PROVIDER_FAILURE.PROVIDER_CAPACITY,
  session_quota_exhausted: PROVIDER_FAILURE.PROVIDER_CAPACITY,
  // transient — upstream trouble the same request may survive
  service_unavailable: PROVIDER_FAILURE.TRANSIENT,
  internal_error: PROVIDER_FAILURE.TRANSIENT,
  server_error: PROVIDER_FAILURE.TRANSIENT,
  overloaded: PROVIDER_FAILURE.TRANSIENT,
  upstream_error: PROVIDER_FAILURE.TRANSIENT,
  // timeout — the deadline, stated by the provider
  upstream_timeout: PROVIDER_FAILURE.TIMEOUT,
  gateway_timeout: PROVIDER_FAILURE.TIMEOUT,
  timeout: PROVIDER_FAILURE.TIMEOUT,
  // parse — a body that arrived and could not be read
  invalid_response: PROVIDER_FAILURE.PARSE,
  malformed_response: PROVIDER_FAILURE.PARSE,
  unparseable_response: PROVIDER_FAILURE.PARSE,
});

/** Header names that mean "come back after <x>" or "the window resets at <t>". */
const RETRY_AFTER_HEADERS = Object.freeze(["retry-after", "x-ratelimit-reset", "x-rate-limit-reset"]);

/**
 * Text that identifies an access challenge when the provider sent no code.
 * Deliberately narrow: "challenge" and "captcha" and a consent/login wall are
 * access states. Everything else about a 403 stays a permission refusal, and a
 * wider net here would relabel ordinary permission failures as challenges —
 * which is how a challenge stops being actionable.
 */
const CHALLENGE_TEXT = /(captcha|recaptcha|hcaptcha|are you a robot|access challenge|challenge required|consent (?:wall|required|page)|login (?:wall|required)|sign in to continue|verify you are human)/i;

/** Text that identifies a credential rejection when the status arrived unlabelled. */
const AUTH_TEXT = /(invalid api key|incorrect api key|api key not valid|invalid_api_key|unauthori[sz]ed|credential[s]? (?:rejected|revoked)|authentication (?:error|failed))/i;

/** Text that identifies a spend/credit limit when the status arrived unlabelled. */
const SPEND_TEXT = /(insufficient (?:quota|credits|balance)|quota exceeded|credit limit|billing hard limit|out of credits|exceeded your current quota)/i;

/** Text that identifies temporary throttling. */
const RATE_TEXT = /(rate limit|too many requests|slow down|throttl)/i;

/** Text that identifies provider-side capacity/session trouble. */
const CAPACITY_TEXT = /(no[ _-]ready[ _-]cookies|session pool|proxy session error|zone (?:rejected|not found|suspended|disabled))/i;

const MAX_DETAIL_CHARS = 240;

/**
 * Strip anything credential-shaped out of provider text before it is logged or
 * persisted.
 *
 * Patterns, not an allowlist of one vendor's key format: the value that leaked
 * into a transcript last time was a vendor key pasted next to a prefix, and the
 * next one will have a different shape. Over-redacting a long opaque token is
 * the correct direction of error here — an operator loses a hint, nobody loses
 * a credential.
 *
 * @param {unknown} text
 * @returns {string|null} trimmed, redacted, or null when there was nothing.
 */
export function sanitizeProviderText(text) {
  if (text === null || text === undefined) return null;
  let out = typeof text === "string" ? text : safeStringify(text);
  if (!out) return null;
  out = out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|pk|rk|api|key|token|secret|brd|pplx|xoxb|ghp|glpat)[_-][A-Za-z0-9._-]{4,}/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, "[redacted]")
    .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, "[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  if (!out) return null;
  return out.length > MAX_DETAIL_CHARS ? `${out.slice(0, MAX_DETAIL_CHARS)}…` : out;
}

/** JSON for objects, `String()` for everything else, and never a bare throw. */
function safeStringify(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch (err) {
    // A circular provider body is not worth failing a classification over, and
    // it must not become the string "undefined" quietly: say what happened.
    return `[unserialisable provider body: ${err?.message || "unknown"}]`;
  }
}

/** A body as searchable text, with absent and string forms both handled. */
function bodyTextOf(body) {
  if (body === null || body === undefined) return "";
  return typeof body === "string" ? body : safeStringify(body) || "";
}

/** Normalise a candidate code: lower-case, punctuation to `_`. */
function normalizeCode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  return raw.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

/** Read a header case-insensitively from a plain object or a Headers-like. */
function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === "function") {
    const viaGet = headers.get(name);
    if (viaGet !== null && viaGet !== undefined) return viaGet;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (String(key).toLowerCase() === name) return value;
  }
  return null;
}

/**
 * Turn one `Retry-After`-style value into milliseconds from now.
 *
 * Both the delta-seconds and the HTTP-date form are accepted because providers
 * send both, and a value that parses to neither returns null rather than 0:
 * "no reset was observed" and "the reset is right now" lead an operator to
 * different actions and must not be the same number.
 *
 * @param {unknown} value seconds, or an HTTP-date
 * @param {number} nowMs reference clock for the HTTP-date form
 * @returns {number|null}
 */
export function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return Math.max(0, at - nowMs);
  return null;
}

/**
 * The provider's own "come back after this", from headers first (authoritative)
 * and the body second.
 *
 * `reset_source` is returned alongside the number so evidence of WHERE the time
 * came from survives to the row — an unobserved reset (null) and an observed
 * zero are different facts, and a number with no provenance is how an invented
 * backoff gets read as the provider's instruction.
 *
 * @returns {{retry_after_ms: number|null, reset_source: string|null, reset_observed: boolean}}
 */
export function retryAfterFrom({ headers = null, body = null, nowMs = Date.now() } = {}) {
  for (const name of RETRY_AFTER_HEADERS) {
    const raw = headerValue(headers, name);
    if (raw === null) continue;
    if (name === "x-ratelimit-reset" || name === "x-rate-limit-reset") {
      // Epoch SECONDS in this header's convention, so it is a clock time, not a
      // delay. Converted explicitly instead of fed to parseRetryAfterMs, which
      // would read the same digits as a delta.
      const epochSeconds = Number(String(raw).trim());
      if (Number.isFinite(epochSeconds) && epochSeconds > 0) {
        return {
          retry_after_ms: Math.max(0, Math.round(epochSeconds * 1000 - nowMs)),
          reset_source: `header:${name}`,
          reset_observed: true,
        };
      }
      continue;
    }
    const ms = parseRetryAfterMs(raw, nowMs);
    if (ms !== null) return { retry_after_ms: ms, reset_source: `header:${name}`, reset_observed: true };
  }

  for (const [key, unit] of [
    ["retry_after_ms", "ms"],
    ["retry_after_seconds", "s"],
    ["retry_after", "s"],
    ["resets_at", "at"],
  ]) {
    for (const container of [body, body?.error, body?.meta]) {
      const raw = container?.[key];
      if (raw === null || raw === undefined || raw === "") continue;
      let ms = null;
      if (unit === "ms") {
        const n = Number(raw);
        ms = Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
      } else if (unit === "s") {
        ms = parseRetryAfterMs(raw, nowMs);
      } else {
        const epochSeconds = Number(raw);
        ms = Number.isFinite(epochSeconds)
          ? Math.max(0, Math.round(epochSeconds * 1000 - nowMs))
          : parseRetryAfterMs(raw, nowMs);
      }
      if (ms !== null) {
        return { retry_after_ms: ms, reset_source: `body:${key}`, reset_observed: true };
      }
    }
  }

  return { retry_after_ms: null, reset_source: null, reset_observed: false };
}

/**
 * The allowlisted provider code for this failure, or null.
 *
 * Candidates are read from structured fields first — the same provider sends
 * `code`, `error.code`, `type` and `x-brd-error` in different versions of its
 * own API — then from the error message as a whole-token match, which is how a
 * thrown `Bright Data proxy session error: no_ready_cookies` is recognised
 * without brightdata.js having to re-classify its own error.
 */
function providerCodeFrom({ body = null, error = null, headers = null } = {}) {
  const candidates = [
    error?.providerCode,
    error?.error_code,
    error?.code,
    error?.reason,
    typeof body === "string" ? null : body?.error_code,
    typeof body === "string" ? null : body?.code,
    typeof body === "string" ? null : body?.type,
    typeof body === "string" ? null : body?.error?.code,
    typeof body === "string" ? null : body?.error?.type,
    typeof body === "string" ? null : body?.error?.reason,
    headerValue(headers, "x-brd-error"),
    headerValue(headers, "x-brd-error-code"),
  ];
  for (const candidate of candidates) {
    const code = normalizeCode(candidate);
    if (code && PROVIDER_CODE_KINDS[code]) return code;
  }
  const haystack = `${error?.message || ""} ${bodyTextOf(body)}`;
  for (const match of haystack.matchAll(/[A-Za-z][A-Za-z0-9_-]{3,}/g)) {
    const code = normalizeCode(match[0]);
    if (code && PROVIDER_CODE_KINDS[code]) return code;
  }
  return null;
}

/** Status as a finite number, or null. A status we cannot read is not a status. */
function toStatus(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Is this error the shape a deadline produces? */
function isTimeoutError(error) {
  if (!error) return false;
  if (error.name === "AbortError" || error.name === "TimeoutError") return true;
  return /(abort|timed? ?out|deadline exceeded)/i.test(String(error.message || ""));
}

/** Is this error the shape an unreadable body produces? */
function isParseError(error) {
  if (!error) return false;
  if (error instanceof SyntaxError) return true;
  return /(not valid json|unexpected token|unexpected end of json|malformed|invalid json)/i.test(
    String(error.message || "")
  );
}

/**
 * Decide the kind, in priority order: an explicit code beats prose; prose beats
 * the bare status; the bare status beats nothing.
 */
function kindFor({ code, status, bodyText, error, parseError }) {
  if (parseError || isParseError(error)) return PROVIDER_FAILURE.PARSE;
  if (isTimeoutError(error)) return PROVIDER_FAILURE.TIMEOUT;
  if (code) return PROVIDER_CODE_KINDS[code];
  if (CHALLENGE_TEXT.test(bodyText)) return PROVIDER_FAILURE.CHALLENGE;
  if (AUTH_TEXT.test(bodyText)) return PROVIDER_FAILURE.AUTHENTICATION;
  if (SPEND_TEXT.test(bodyText)) return PROVIDER_FAILURE.SPEND_LIMIT;
  if (CAPACITY_TEXT.test(bodyText)) return PROVIDER_FAILURE.PROVIDER_CAPACITY;
  if (RATE_TEXT.test(bodyText)) return PROVIDER_FAILURE.RATE_LIMIT;
  switch (status) {
    case 401:
      return PROVIDER_FAILURE.AUTHENTICATION;
    case 402:
      return PROVIDER_FAILURE.SPEND_LIMIT; // "payment required" is a limit, not throttling
    case 403:
      return PROVIDER_FAILURE.PERMISSION;
    case 408:
      return PROVIDER_FAILURE.TIMEOUT;
    case 425:
      // "Too Early" is httpFailureKind's other transient status below 400; it
      // has to be named here or the richer vocabulary would call it a request
      // fault and quietly narrow a retry the shared classifier allows.
      return PROVIDER_FAILURE.TRANSIENT;
    case 429:
      return PROVIDER_FAILURE.RATE_LIMIT;
    default:
      if (status !== null && status >= 500) return PROVIDER_FAILURE.TRANSIENT;
      if (status !== null && status >= 400) return PROVIDER_FAILURE.REQUEST;
      return PROVIDER_FAILURE.TRANSIENT;
  }
}

/**
 * Classify one provider failure.
 *
 * @param {object} input
 * @param {string|null} [input.provider] which provider/gateway answered; named in the message
 * @param {number|null} [input.status] HTTP status, when one exists
 * @param {object|null} [input.headers] response headers (plain object or Headers)
 * @param {object|string|null} [input.body] parsed body, raw text, or provider envelope
 * @param {unknown} [input.error] the thrown error, when the failure never reached a status
 * @param {unknown} [input.parseError] set when a 200 body could not be read as a result
 * @param {number} [input.nowMs] clock, for HTTP-date reset values
 * @returns {{
 *   kind: string, retryable: boolean, opens_circuit: boolean, action: string,
 *   provider: string|null, status: number|null, provider_code: string|null,
 *   retry_after_ms: number|null, reset_observed: boolean, reset_source: string|null,
 *   evidence: string, brand_absence: false, observation: null, message: string, detail: string|null
 * }}
 */
export function classifyProviderFailure({
  provider = null,
  status = null,
  headers = null,
  body = null,
  error = null,
  parseError = null,
  nowMs = Date.now(),
} = {}) {
  const httpStatus = toStatus(status ?? error?.status ?? null);
  const code = providerCodeFrom({ body, error, headers });
  const bodyText = bodyTextOf(body);
  const detail = sanitizeProviderText(
    [error?.message, code ? `code=${code}` : null, bodyText || null].filter(Boolean).join(" | ")
  );
  const kind = kindFor({
    code,
    status: httpStatus,
    bodyText: `${bodyText} ${error?.message || ""}`,
    error,
    parseError,
  });
  const policy = POLICY[kind];
  const timing = retryAfterFrom({ headers, body: typeof body === "string" ? null : body, nowMs });

  // The retry verdict is the shared classifier's, narrowed — never widened. A
  // permanent status cannot be made retryable by a provider code claiming
  // "rate limit", but a transient-looking status CAN be made permanent by a
  // spend-limit code, because that is the one direction the richer vocabulary
  // is allowed to correct: asking a spent key again is not a retry, it is a
  // repeat of the incident.
  const sharedVerdict = httpStatus === null ? null : classifyHttpStatus(httpStatus);
  const retryable =
    policy.retryable && (sharedVerdict === null || sharedVerdict === FAILURE_KIND.TRANSIENT);

  const evidence = code
    ? "provider_code"
    : error
      ? "error"
      : httpStatus !== null
        ? "status"
        : "none";

  return {
    kind,
    retryable,
    opens_circuit: policy.opens_circuit,
    action: policy.action,
    provider: provider || error?.provider || null,
    status: httpStatus,
    provider_code: code,
    retry_after_ms: timing.retry_after_ms,
    reset_observed: timing.reset_observed,
    reset_source: timing.reset_source,
    evidence,
    // A provider failure is never a statement about the brand. Pinned as a
    // field, not a comment, because the audit's A01 shape (a failed collection
    // read as "the answer did not mention you") starts exactly here.
    brand_absence: false,
    // A failure produces no observation. `valid_no_aio` needs affirmative valid
    // SERP evidence (R04.1b); a challenge or a timeout has none.
    observation: null,
    message: providerFailureMessage({ provider, httpStatus, code, policy, timing }),
    detail,
  };
}

/**
 * Classify a failure that arrived as one of the engine adapters' result
 * envelopes rather than as a thrown error.
 *
 * The adapters return `{ error, error_kind, ... }` and do NOT carry the HTTP
 * status, which is exactly the gap that makes a 401 and a 403 the same
 * "permanent" downstream. When the caller can hand over the raw ingredients
 * (`status`/`headers`/`body`) they win outright and this is a pass-through.
 * When it cannot, the classification is marked `evidence: "coarse"` and is
 * derived only from the message — so an operator reading the row can see that
 * the kind came from prose and not from a status the provider actually sent.
 *
 * @param {string|null} provider
 * @param {{error?: unknown, error_kind?: string|null, citations_state_reason?: string|null}|null} envelope
 * @param {{status?: number|null, headers?: object|null, body?: unknown}} [raw]
 */
export function classifyProviderFailureEnvelope(provider, envelope = null, raw = {}) {
  if (raw && (raw.status !== undefined || raw.body !== undefined || raw.headers !== undefined)) {
    return classifyProviderFailure({
      provider,
      status: raw.status ?? null,
      headers: raw.headers ?? null,
      body: raw.body ?? null,
      nowMs: raw.nowMs,
    });
  }
  const message = envelope?.error || envelope?.error_kind || null;
  if (!message) {
    return classifyProviderFailure({ provider, error: null, nowMs: raw?.nowMs });
  }
  // Legacy adapters persisted only their literal "HTTP NNN" message. This
  // remains coarse evidence, but must not turn a recorded 401 into a retry.
  const legacyStatus = String(message).match(/\bHTTP\s+([45]\d{2})\b/i);
  const classification = classifyProviderFailure({ provider, status:legacyStatus ? Number(legacyStatus[1]) : null,
    error: new Error(String(message)), nowMs: raw?.nowMs });
  if (envelope?.error_kind === FAILURE_KIND.PERMANENT) classification.retryable=false;
  return { ...classification, evidence: "coarse" };
}

/**
 * Human-readable, provider-naming, credential-free operator sentence.
 *
 * It carries the status and the allowlisted code and NOTHING from the body, and
 * the provider's reset time only when one was actually observed — the two facts
 * an operator acts on. The raw body travels separately in `detail`, already
 * redacted, for the case where the code alone does not identify the fix.
 */
function providerFailureMessage({ provider, httpStatus, code, policy, timing }) {
  const where = provider ? `${provider}: ` : "";
  const status = httpStatus === null ? "" : ` (HTTP ${httpStatus}${code ? `, code ${code}` : ""})`;
  const reset = timing.reset_observed
    ? `; retry after ${timing.retry_after_ms}ms per ${timing.reset_source}`
    : "";
  return `${where}${policy.label}${status}${reset}`;
}

/**
 * The failure kind of anything thrown, in this vocabulary — the same default
 * discipline as httpFailureKind.failureKindOf: a failure we cannot read stays
 * RETRYABLE, because discarding a recoverable measurement is the more expensive
 * mistake, and only a positively identified refusal stops the loop.
 *
 * @param {unknown} error
 * @returns {string} one of PROVIDER_FAILURE_KINDS
 */
export function providerFailureKindOf(error) {
  const kind = error?.providerFailureKind;
  if (PROVIDER_FAILURE_KINDS.includes(kind)) return kind;
  return failureKindOf(error) === FAILURE_KIND.PERMANENT
    ? PROVIDER_FAILURE.REQUEST
    : PROVIDER_FAILURE.TRANSIENT;
}

/** @param {string} kind @returns {boolean} may this be attempted again? */
export function isRetryableProviderFailure(kind) {
  return POLICY[kind]?.retryable === true;
}

/** @param {string} kind @returns {boolean} is this a permanent credential/budget fault? */
export function opensProviderCircuit(kind) {
  return POLICY[kind]?.opens_circuit === true;
}

/** @param {string} kind @returns {string|null} the operator action token */
export function operatorActionFor(kind) {
  return POLICY[kind]?.action ?? null;
}
