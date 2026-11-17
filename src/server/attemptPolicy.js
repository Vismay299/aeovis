/**
 * R02.3a/b + R02.4b — the pure retry/terminal policy for one (prompt, surface)
 * pair.
 *
 * Two production facts make this module necessary, and both are in the audit:
 *
 *   1. "The worker treats the existence of a persisted (job, engine, question)
 *      row as completion" and "resuming probing after those 120 persisted
 *      failures performs ZERO retries" (A08). Retry was an implicit property of
 *      an adapter's own loop, so the level above had no policy at all.
 *   2. A valid no-AIO answer and a credential rejection must not share a fate.
 *      Retrying a 401 is what produced 34 identical credential errors per
 *      engine; refusing to retry a 503 throws away a measurement that the very
 *      next call may return.
 *
 * So the module is PURE and it answers one question with one shape: given the
 * attempt that just finished, may another be dispatched, when, and if not, what
 * is the terminal disposition. Nothing here touches a clock it does not own,
 * reads a database, or performs I/O, which is what makes the deadlines, the
 * ceilings and the seeded jitter testable without sleeping for real.
 *
 * BACKOFF: bounded, seeded, and combined with the provider's own reset time.
 * The un-jittered base is monotone in the attempt number (`baseDelayFor`), the
 * jitter is a deterministic function of (seed, attempt) so a failing run can be
 * explained and reproduced, and the effective delay is the jittered backoff
 * RAISED to the provider's Retry-After when one was observed — a provider that
 * says "come back in 20 minutes" is not overruled by a 2-second local curve.
 * The cap bounds the jittered curve; the observed reset time is allowed to
 * exceed it, because ignoring it would just earn another 429.
 */

import { isRetryableProviderFailure, opensProviderCircuit } from "../shared/engines/providerFailure.js";

/**
 * Terminal dispositions for a logical observation (backlog §D). Exclusive on
 * purpose: `planned = answered + valid_no_aio + failed + not_attempted`, so a
 * retry history can grow attempts without growing the denominator.
 */
export const ATTEMPT_DISPOSITION = Object.freeze({
  ANSWERED: "answered",
  VALID_NO_AIO: "valid_no_aio",
  EXHAUSTED: "exhausted",
  BLOCKED: "blocked",
  NOT_RETRYABLE_IN_WINDOW: "not_retryable_in_window",
});

/** Why a retry decision came out the way it did. Machine tokens; detail carries prose. */
export const RETRY_REASON = Object.freeze({
  TRANSIENT_FAILURE: "transient_failure",
  PERMANENT_FAILURE: "permanent_failure",
  OBSERVATION_TERMINAL: "observation_terminal",
  ATTEMPTS_EXHAUSTED: "attempts_exhausted",
  RETRY_AFTER_BEYOND_DEADLINE: "retry_after_beyond_deadline",
});

export const DEFAULT_RETRY_POLICY = Object.freeze({
  /** Total attempts allowed for one logical observation, including the first. */
  max_attempts: 3,
  /** First backoff step. Doubled per attempt, then capped. */
  base_delay_ms: 1000,
  /** Ceiling for the jittered backoff curve. */
  cap_delay_ms: 30_000,
  /** Jitter as a fraction of the step, applied symmetrically. 0 disables it. */
  jitter_ratio: 0.25,
  /** The seed that makes a run reproducible. Changing it changes the delays, not the bounds. */
  seed: 1,
});

/**
 * The un-jittered backoff for an attempt: base × 2^(attempt-1), capped.
 *
 * Exported because it is the MONOTONE half of "bounded backoff with seeded
 * jitter": jitter exists precisely to make individual delays differ, so the
 * monotone policy can only be asserted about this curve.
 */
export function baseDelayFor(policy, attemptNumber) {
  const step = Math.max(0, Number(attemptNumber) - 1);
  const raw = (policy?.base_delay_ms ?? 0) * 2 ** step;
  const cap = policy?.cap_delay_ms ?? 0;
  return Math.min(raw, cap);
}

/**
 * Deterministic jitter in [−ratio, +ratio], from (seed, attempt).
 *
 * A hash rather than `Math.random()`: a property failure has to be
 * REPRODUCIBLE from the seed, and a test that reschedules its own arithmetic on
 * every run cannot tell a bound violation from a different draw.
 *
 * The finalizer is MurmurHash3's `fmix32`, and the avalanche is the whole
 * reason it is here rather than a bare xorshift: sequential seeds (0, 1, 2, …)
 * differ only in their low bits, and a mixer without a full avalanche returns
 * near-identical draws for all of them. That was measured, not assumed — with
 * a three-step xorshift, seeds 0 through 4 produced the SAME whole-millisecond
 * delay at every attempt, which would have let a bounds violation hide inside
 * this function for the entire seed sweep that exists to find it.
 */
export function seededJitter(seed, attemptNumber, ratio) {
  const amount = Number(ratio);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  let x = ((Number(seed) >>> 0) ^ Math.imul(Number(attemptNumber) >>> 0, 0x9e3779b1)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  x >>>= 0;
  const unit = x / 0xffffffff; // [0, 1]
  return (unit * 2 - 1) * amount;
}

/** Milliseconds until this attempt may be retried; null when there is none to give. */
export function delayFor({ policy = DEFAULT_RETRY_POLICY, attemptNumber, providerRetryAfterMs = null } = {}) {
  const curve = baseDelayFor(policy, attemptNumber);
  const jittered = Math.max(0, Math.round(curve * (1 + seededJitter(policy.seed, attemptNumber, policy.jitter_ratio))));
  const cap = policy.cap_delay_ms ?? 0;
  const bounded = Math.min(jittered, cap);
  const provider = Number.isFinite(providerRetryAfterMs) && providerRetryAfterMs >= 0 ? providerRetryAfterMs : null;
  if (provider === null) return { delay_ms: bounded, bounded_by: "policy_cap" };
  if (provider <= bounded) return { delay_ms: bounded, bounded_by: "policy_cap" };
  return { delay_ms: provider, bounded_by: "provider_retry_after" };
}

/**
 * Is this observation already a terminal, valid measurement?
 *
 * A valid no-AIO SERP is a MEASUREMENT — "the engine answered and there was no
 * overview" — so retrying it to try to force an overview is manufacturing a
 * result. The same is true of an answer. Both are terminal, and no option
 * exists to ask otherwise: `planRetry` ignores unknown options entirely, and a
 * test passes `{ prefer_overview: true }` to prove it.
 */
export function isTerminalObservation(observation) {
  if (!observation) return false;
  if (observation.valid !== true) return false;
  return (
    observation.disposition === ATTEMPT_DISPOSITION.ANSWERED ||
    observation.disposition === ATTEMPT_DISPOSITION.VALID_NO_AIO
  );
}

/** Which disposition a terminal outcome has, or null when the attempt is not one. */
function terminalDispositionOf(failure) {
  if (!failure) return ATTEMPT_DISPOSITION.BLOCKED;
  return opensProviderCircuit(failure.kind)
    ? ATTEMPT_DISPOSITION.BLOCKED
    : ATTEMPT_DISPOSITION.EXHAUSTED;
}

/**
 * Decide the next move for one logical observation.
 *
 * @param {object} input
 * @param {object} [input.policy]
 * @param {{disposition?: string, valid?: boolean}|null} [input.observation] a measurement, if one was obtained
 * @param {{kind: string, retryable?: boolean, retry_after_ms?: number|null}|null} [input.failure]
 * @param {number} input.attemptNumber the attempt that just finished (1-based)
 * @param {number} input.nowMs
 * @param {number} input.deadlineMs absolute deadline for the whole scan window
 * @returns {{
 *   attempt: number, next_attempt: number|null, retry: boolean, terminal: boolean,
 *   disposition: string|null, reason: string, delay_ms: number|null, bounded_by: string|null,
 *   deadline_known: boolean, next_attempt_at: string|null, retry_after_ms: number|null,
 *   circuit_action: object|null
 * }}
 */
export function planRetry({
  policy = DEFAULT_RETRY_POLICY,
  observation = null,
  failure = null,
  attemptNumber,
  nowMs,
  deadlineMs,
} = {}) {
  const attempt = Number.isFinite(Number(attemptNumber)) ? Number(attemptNumber) : 1;
  const base = {
    attempt,
    next_attempt: null,
    retry: false,
    terminal: false,
    disposition: null,
    reason: RETRY_REASON.TRANSIENT_FAILURE,
    delay_ms: null,
    bounded_by: null,
    deadline_known: false,
    next_attempt_at: null,
    retry_after_ms: failure?.retry_after_ms ?? null,
    circuit_action: null,
  };

  // A question already answered, or a SERP already confirmed to carry no
  // overview, is a terminal VALID observation. It is never retried, and no
  // caller option can make it so.
  if (isTerminalObservation(observation)) {
    return {
      ...base,
      terminal: true,
      disposition: observation.disposition,
      reason: RETRY_REASON.OBSERVATION_TERMINAL,
    };
  }

  const maxAttempts = policy?.max_attempts ?? DEFAULT_RETRY_POLICY.max_attempts;
  if (attempt >= maxAttempts) {
    return {
      ...base,
      terminal: true,
      disposition: terminalDispositionOf(failure),
      reason: RETRY_REASON.ATTEMPTS_EXHAUSTED,
      circuit_action: circuitActionFor(failure),
    };
  }

  // The classifier's verdict is AUTHORITATIVE and the kind table is the default
  // only for a failure that travelled without one. `classifyProviderFailure`
  // NARROWS retryability by the HTTP status as well as the kind — a 401 whose
  // body says "rate_limit_exceeded" classifies as `rate_limit` and is still
  // explicitly not retryable — so answering from `kind` alone would discard the
  // narrowing and re-ask a credential the provider already refused, which is the
  // audit's "34 identical credential errors per engine" deliberately rebuilt
  // here. The kind default stays as the fallback because a failure carrier from
  // an adapter need not have been through the classifier.
  const retryable = failure
    ? typeof failure.retryable === "boolean"
      ? failure.retryable
      : isRetryableProviderFailure(failure.kind)
    : false;

  // Nothing retryable: a permanent refusal emits a circuit action instead,
  // because the correct response to a revoked key is to stop the dependent
  // engines, not to ask the same question twice more.
  if (!retryable) {
    return {
      ...base,
      terminal: true,
      disposition: terminalDispositionOf(failure),
      reason: failure ? RETRY_REASON.PERMANENT_FAILURE : RETRY_REASON.OBSERVATION_TERMINAL,
      circuit_action: circuitActionFor(failure),
    };
  }

  const { delay_ms: delay, bounded_by } = delayFor({
    policy,
    attemptNumber: attempt,
    providerRetryAfterMs: failure.retry_after_ms ?? null,
  });

  // A deadline that is not a finite instant cannot be consulted, so it cannot
  // be used to refuse a retry — but the refusal to say "this fits" travels as
  // `deadline_known: false` rather than as a quiet yes.
  const deadlineKnown = Number.isFinite(nowMs) && Number.isFinite(deadlineMs);
  if (deadlineKnown && nowMs + delay > deadlineMs) {
    // Explicitly NOT retryable inside this window. The observation is neither
    // exhausted nor answered: it is a deferred failure, and claiming a retry
    // time it cannot honour (or dispatching early) is how a scan overruns its
    // own deadline.
    return {
      ...base,
      disposition: ATTEMPT_DISPOSITION.NOT_RETRYABLE_IN_WINDOW,
      reason: RETRY_REASON.RETRY_AFTER_BEYOND_DEADLINE,
      delay_ms: null,
      bounded_by,
      deadline_known: true,
    };
  }

  return {
    ...base,
    retry: true,
    next_attempt: attempt + 1,
    reason: RETRY_REASON.TRANSIENT_FAILURE,
    delay_ms: delay,
    bounded_by,
    deadline_known: deadlineKnown,
    next_attempt_at: deadlineKnown ? new Date(nowMs + delay).toISOString() : null,
  };
}

/**
 * The circuit action a failure implies, or null.
 *
 * Returned rather than performed: this module has no state, and a pure decision
 * that also mutated a breaker would be untestable in isolation. The caller hands
 * it to providerCircuit.
 */
function circuitActionFor(failure) {
  if (!failure || !opensProviderCircuit(failure.kind)) return null;
  return { action: "open", kind: failure.kind, reason: failure.message ?? null };
}

/**
 * What a failed-but-dispatched request cost (R02.4b, R02-21).
 *
 * A request that left this process and failed may still have been billed — the
 * provider's answer is unknown, and "we don't know" must not be reported as
 * "free". `cost: null` with `unknown_billed` says exactly that. A request that
 * never left (a refused reservation, a blocked circuit) is genuinely
 * `not_dispatched`, which is the one case where no charge is possible, and a
 * provider-reported figure — including a genuine 0 for a free model — stays
 * measured, because a measured zero is a fact and an unknown is not.
 */
export const CHARGE_STATE = Object.freeze({
  MEASURED: "measured",
  NOT_DISPATCHED: "not_dispatched",
  UNKNOWN_BILLED: "unknown_billed",
});

/** @returns {{cost: number|null, cost_state: string, detail: string|null}} */
export function reconcileCost({ dispatched, cost = null } = {}) {
  if (!dispatched) {
    return {
      cost: null,
      cost_state: CHARGE_STATE.NOT_DISPATCHED,
      detail: "no request left this process, so no charge is possible",
    };
  }
  if (typeof cost === "number" && Number.isFinite(cost)) {
    return { cost, cost_state: CHARGE_STATE.MEASURED, detail: null };
  }
  return {
    cost: null,
    cost_state: CHARGE_STATE.UNKNOWN_BILLED,
    detail: "the request was dispatched and its outcome is unknown; the provider may still have billed it",
  };
}
