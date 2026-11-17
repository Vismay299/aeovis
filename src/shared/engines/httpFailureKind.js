/**
 * Is a failed vendor call worth trying again? (R2.2.10, hoisted here by R2.2.13)
 *
 * Every HTTP engine adapter in this directory opened its retry loop with the
 * same dead guard: `if (status === 429 || status >= 500) { ...retry... }` and
 * then `throw` for every other status — inside a `try` whose own `catch`
 * retried unconditionally. The throw landed in the catch, which backed off and
 * went round again, so the guard decided nothing. Measured on
 * src/shared/engines/openai.js before this module existed: a 401 cost 3 calls and
 * 3013ms, and the one failure an operator can actually fix looked exactly like
 * vendor flakiness.
 *
 *   transient — rate limit, upstream fault, timeout, severed connection. The
 *               same request may well succeed in a second. Retry it.
 *   permanent — the vendor understood the request and refused it: bad or
 *               revoked key (401), forbidden (403), malformed request (400,
 *               404, 422). No amount of backoff changes the answer. Fail on
 *               the FIRST response and say why.
 *
 * This lives in its own module, rather than being re-declared per adapter,
 * because a second vocabulary for the same question is the defect this ledger
 * keeps finding: two engines disagreeing about whether a 403 is worth retrying
 * is invisible until a scan burns its budget on a revoked key. R2.2.10 wrote it
 * in src/shared/engines/perplexity.js, which still re-exports these names so its
 * callers and tests keep working; src/shared/engines/openai.js imports them from
 * here. There is exactly one definition.
 */

export const FAILURE_KIND = Object.freeze({
  TRANSIENT: "transient",
  PERMANENT: "permanent",
});

/** Statuses below 500 that are still worth another attempt. */
const TRANSIENT_STATUSES = new Set([
  408, // Request Timeout
  425, // Too Early
  429, // Too Many Requests
]);

/**
 * Classify an HTTP status.
 *
 * The default for something we cannot read as a status is TRANSIENT, not
 * PERMANENT: giving up early on a failure we do not understand throws away a
 * measurement, which is the more expensive mistake. We stop retrying only when
 * we can positively identify a refusal.
 *
 * @param {number} status
 * @returns {"transient"|"permanent"}
 */
export function classifyHttpStatus(status) {
  const code = Number(status);
  if (!Number.isFinite(code)) return FAILURE_KIND.TRANSIENT;
  if (code >= 500) return FAILURE_KIND.TRANSIENT;
  if (TRANSIENT_STATUSES.has(code)) return FAILURE_KIND.TRANSIENT;
  if (code >= 400) return FAILURE_KIND.PERMANENT;
  return FAILURE_KIND.TRANSIENT;
}

/**
 * The kind of a thrown failure. Only errors an adapter tagged carry a verdict;
 * anything else (AbortError from the timeout, a socket reset, a truncated body
 * that fails JSON.parse) is transport noise and therefore transient.
 *
 * @param {unknown} error
 * @returns {"transient"|"permanent"}
 */
export function failureKindOf(error) {
  const kind = error?.failureKind;
  return kind === FAILURE_KIND.PERMANENT || kind === FAILURE_KIND.TRANSIENT
    ? kind
    : FAILURE_KIND.TRANSIENT;
}

/** @param {unknown} error @returns {boolean} */
export function isRetryableFailure(error) {
  return failureKindOf(error) === FAILURE_KIND.TRANSIENT;
}

/**
 * Tag an Error with the verdict for its HTTP status, so the retry loop reads a
 * classification off the error instead of re-testing the status where it can no
 * longer see the response.
 *
 * @template {Error} E
 * @param {E} error
 * @param {number} status
 * @returns {E}
 */
export function tagHttpFailure(error, status) {
  error.status = status;
  error.failureKind = classifyHttpStatus(status);
  return error;
}
