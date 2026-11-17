import test from "node:test";
import assert from "node:assert/strict";

import { classifyProviderFailure, PROVIDER_FAILURE } from "../../shared/engines/providerFailure.js";
import { runCanary } from "../../shared/engines/providerReadiness.js";
import {
  ATTEMPT_DISPOSITION,
  CHARGE_STATE,
  DEFAULT_RETRY_POLICY,
  RETRY_REASON,
  baseDelayFor,
  delayFor,
  planRetry,
  reconcileCost,
  seededJitter,
} from "../attemptPolicy.js";

/**
 * R02-01..R02-06 and R02-21 — the retry/terminal policy, purely.
 *
 * The behaviour these replace is A08: "resuming probing after those 120
 * persisted failures performs ZERO retries". Retry used to be an accident of
 * each adapter's inner loop, so the level above had no policy to consult and
 * nothing to record. Every assertion here is about a DECISION, taken from a
 * fixture, with no clock the test does not own and no provider in reach.
 */

const FAKE = "EXAMPLE-NOT-A-REAL-CREDENTIAL-0000000000";
const NOW_MS = Date.parse("2026-10-16T10:00:00.000Z");
const DEADLINE_MS = NOW_MS + 15 * 60 * 1000;

/** A no-jitter policy, so an assertion about the delay is about the policy. */
const FLAT = Object.freeze({ max_attempts: 3, base_delay_ms: 1000, cap_delay_ms: 30_000, jitter_ratio: 0, seed: 7 });

function transientFailure({ retryAfter = null } = {}) {
  const failure = classifyProviderFailure({
    provider: "openrouter",
    error: Object.assign(new Error("The operation was aborted"), { name: "AbortError" }),
    nowMs: NOW_MS,
  });
  return { ...failure, retry_after_ms: retryAfter };
}

test("R02-01 — a transient timeout earns a bounded retry and increments the attempt count exactly once", () => {
  const failure = transientFailure();
  assert.equal(failure.kind, PROVIDER_FAILURE.TIMEOUT);
  assert.equal(failure.retryable, true);

  const decision = planRetry({ policy: FLAT, failure, attemptNumber: 1, nowMs: NOW_MS, deadlineMs: DEADLINE_MS });

  assert.equal(decision.retry, true);
  assert.equal(decision.attempt, 1, "the attempt that just finished");
  assert.equal(decision.next_attempt, 2, "exactly one increment, not a jump and not a repeat");
  assert.equal(decision.reason, RETRY_REASON.TRANSIENT_FAILURE);
  assert.equal(decision.delay_ms, 1000, "base × 2^0 with jitter disabled");
  assert.equal(decision.next_attempt_at, new Date(NOW_MS + 1000).toISOString());
  assert.equal(decision.terminal, false);
  assert.equal(decision.disposition, null, "a retryable attempt has no terminal disposition yet");
  assert.ok(decision.delay_ms <= FLAT.cap_delay_ms, "the delay is bounded by the cap");
});

test("R02-02 — a permanent credential rejection never retries the question, and emits a circuit action", () => {
  const failure = classifyProviderFailure({
    provider: "openrouter",
    status: 401,
    body: { error: { code: "invalid_api_key" } },
    nowMs: NOW_MS,
  });

  const decision = planRetry({ policy: FLAT, failure, attemptNumber: 1, nowMs: NOW_MS, deadlineMs: DEADLINE_MS });

  assert.equal(decision.retry, false, "no automatic question retry");
  assert.equal(decision.next_attempt, null, "there is nothing for a caller to dispatch");
  assert.equal(decision.delay_ms, null);
  assert.equal(decision.terminal, true);
  assert.equal(decision.disposition, ATTEMPT_DISPOSITION.BLOCKED);
  assert.equal(decision.reason, RETRY_REASON.PERMANENT_FAILURE);
  assert.deepEqual(decision.circuit_action, {
    action: "open",
    kind: PROVIDER_FAILURE.AUTHENTICATION,
    reason: failure.message,
  });

  // The same fault on a later attempt is still permanent — the ceiling is not
  // what stopped it.
  const later = planRetry({ policy: FLAT, failure, attemptNumber: 2, nowMs: NOW_MS, deadlineMs: DEADLINE_MS });
  assert.equal(later.reason, RETRY_REASON.PERMANENT_FAILURE);
  assert.equal(later.retry, false);

  // A status and a code can contradict each other, and the classifier settles
  // that against a retry. The kind still comes from the allowlisted code, so a
  // policy reading `kind` alone would find several of these "retryable" and
  // re-ask a provider that already refused.
  const contradictions = [
    { status: 401, code: "rate_limit_exceeded", kind: PROVIDER_FAILURE.RATE_LIMIT },
    { status: 403, code: "rate_limit_exceeded", kind: PROVIDER_FAILURE.RATE_LIMIT },
    { status: 400, code: "service_unavailable", kind: PROVIDER_FAILURE.TRANSIENT },
    { status: 429, code: "insufficient_quota", kind: PROVIDER_FAILURE.SPEND_LIMIT },
  ];
  for (const { status, code, kind } of contradictions) {
    const classified = classifyProviderFailure({
      provider: "openrouter",
      status,
      body: { error: { code } },
      nowMs: NOW_MS,
    });
    assert.equal(classified.kind, kind, `HTTP ${status} + ${code}`);
    assert.equal(classified.retryable, false, `HTTP ${status} + ${code} is explicitly not retryable`);

    const verdict = planRetry({ policy: FLAT, failure: classified, attemptNumber: 1, nowMs: NOW_MS, deadlineMs: DEADLINE_MS });
    assert.equal(verdict.retry, false, `HTTP ${status} + ${code} must not repeat the question`);
    assert.equal(verdict.next_attempt, null);
    assert.equal(verdict.terminal, true);
    assert.equal(verdict.reason, RETRY_REASON.PERMANENT_FAILURE);
  }

  // The kind table is only the default for a failure that carries no verdict,
  // which is the one case a policy is allowed to answer for itself.
  const noVerdict = planRetry({
    policy: FLAT,
    failure: { kind: PROVIDER_FAILURE.TRANSIENT },
    attemptNumber: 1,
    nowMs: NOW_MS,
    deadlineMs: DEADLINE_MS,
  });
  assert.equal(noVerdict.retry, true);
});

test("R02-02 — classifier → retry policy → canary: a contradictory permanent response is requested once, not three times", async () => {
  // The composition the audit's number comes from: runCanary classifies each
  // attempt and asks planRetry whether another is allowed. A canary that
  // re-derived retryability from the kind would spend three calls on a 401,
  // which is how one revoked credential became 34 identical rejections per
  // engine.
  const clock = { at: NOW_MS };
  const canaryPolicy = { max_attempts: 3, base_delay_ms: 0, cap_delay_ms: 0, jitter_ratio: 0, seed: 0 };
  const env = { LLM_API_KEY: FAKE, LLM_BASE_URL: "https://openrouter.ai/api/v1" };
  const run = (probe, policy) =>
    runCanary({
      engine: "chatgpt",
      env,
      probe,
      now: () => clock.at,
      sleep: async (ms) => {
        clock.at += ms;
      },
      deadlineMs: NOW_MS + 600_000,
      policy,
    });

  const contradiction = { status: 401, body: { error: { code: "rate_limit_exceeded" } } };
  const refusing = async () => {
    refusing.calls += 1;
    return { valid: false, failure: contradiction };
  };
  refusing.calls = 0;

  const result = await run(refusing, canaryPolicy);
  assert.equal(refusing.calls, 1, "a response the classifier rejected for retry is requested exactly once");
  assert.equal(result.requests, 1);
  assert.equal(result.observation, null);
  assert.equal(result.canary.kind, PROVIDER_FAILURE.RATE_LIMIT, "the contradictory pair is still named as the kind it claimed");
  assert.equal(result.canary.failure.retryable, false, "the verdict that stopped the loop is on the record");
  assert.equal(result.canary.attempt_history[0].retryable, false);
  assert.equal(result.canary.attempt_history[0].stop_reason, RETRY_REASON.PERMANENT_FAILURE);

  // The control: the same composition still retries a failure the classifier
  // allows, so the count above is the verdict's doing and not a canary that
  // could never retry anything.
  const transient = async () => {
    transient.calls += 1;
    return { valid: false, failure: { status: 503 } };
  };
  transient.calls = 0;

  const retried = await run(transient, { ...canaryPolicy, max_attempts: 2 });
  assert.equal(transient.calls, 2, "an allowed transient failure is retried up to the attempt ceiling");
  assert.equal(retried.canary.kind, PROVIDER_FAILURE.TRANSIENT);
  assert.equal(retried.canary.attempt_history.at(-1).stop_reason, RETRY_REASON.ATTEMPTS_EXHAUSTED);
});

test("R02-03 — a valid no-AIO answer is terminal, and nothing can retry it to force an overview", () => {
  const noAio = { disposition: ATTEMPT_DISPOSITION.VALID_NO_AIO, valid: true, no_aio: true };
  const decision = planRetry({ policy: FLAT, observation: noAio, failure: null, attemptNumber: 1, nowMs: NOW_MS, deadlineMs: DEADLINE_MS });

  assert.equal(decision.terminal, true);
  assert.equal(decision.retry, false, "a low trigger rate is a finding, not a reason to ask again");
  assert.equal(decision.disposition, ATTEMPT_DISPOSITION.VALID_NO_AIO);
  assert.equal(decision.reason, RETRY_REASON.OBSERVATION_TERMINAL);
  assert.equal(decision.next_attempt, null);

  // No option exists that turns a valid measurement into a retry. Passing the
  // one a caller might reach for changes nothing at all.
  const insisting = planRetry({
    policy: FLAT,
    observation: noAio,
    failure: null,
    attemptNumber: 1,
    nowMs: NOW_MS,
    deadlineMs: DEADLINE_MS,
    prefer_overview: true,
    force_overview: true,
    retry_on_no_aio: true,
  });
  assert.deepEqual(insisting, decision, "there is no knob that retries a valid measurement");

  // A real answer is terminal in exactly the same way.
  const answered = planRetry({
    policy: FLAT,
    observation: { disposition: ATTEMPT_DISPOSITION.ANSWERED, valid: true },
    attemptNumber: 2,
    nowMs: NOW_MS,
    deadlineMs: DEADLINE_MS,
  });
  assert.equal(answered.terminal, true);
  assert.equal(answered.disposition, ATTEMPT_DISPOSITION.ANSWERED);
});

test("R02-04 — at the attempt ceiling, the failure is terminally exhausted and nothing more is requested", () => {
  const failure = transientFailure();
  const decision = planRetry({
    policy: FLAT,
    failure,
    attemptNumber: FLAT.max_attempts,
    nowMs: NOW_MS,
    deadlineMs: DEADLINE_MS,
  });

  assert.equal(decision.retry, false);
  assert.equal(decision.terminal, true);
  assert.equal(decision.disposition, ATTEMPT_DISPOSITION.EXHAUSTED);
  assert.equal(decision.reason, RETRY_REASON.ATTEMPTS_EXHAUSTED);
  assert.equal(decision.delay_ms, null);
  assert.equal(decision.next_attempt, null, "no extra request is authorised");
  assert.equal(decision.circuit_action, null, "a spent attempt budget is not a provider-wide block");

  // One below the ceiling the same failure still retries, so the ceiling is
  // what stopped it rather than the kind.
  const oneBelow = planRetry({ policy: FLAT, failure, attemptNumber: FLAT.max_attempts - 1, nowMs: NOW_MS, deadlineMs: DEADLINE_MS });
  assert.equal(oneBelow.retry, true);
});

test("R02-05 — a retry time beyond the scan deadline is not retryable in this window, with no early call", () => {
  const failure = classifyProviderFailure({
    provider: "openrouter",
    status: 429,
    headers: { "retry-after": "600" },
    nowMs: NOW_MS,
  });
  assert.equal(failure.retry_after_ms, 600_000);

  const decision = planRetry({
    policy: FLAT,
    failure,
    attemptNumber: 1,
    nowMs: NOW_MS,
    deadlineMs: NOW_MS + 60_000, // the window closes in a minute
  });

  assert.equal(decision.retry, false);
  assert.equal(decision.terminal, false, "the observation is deferred, not exhausted");
  assert.equal(decision.disposition, ATTEMPT_DISPOSITION.NOT_RETRYABLE_IN_WINDOW);
  assert.equal(decision.reason, RETRY_REASON.RETRY_AFTER_BEYOND_DEADLINE);
  assert.equal(decision.delay_ms, null, "the delay is not quietly shortened to fit");
  assert.equal(decision.next_attempt_at, null);
  assert.equal(decision.next_attempt, null, "so there is no early call to make");
  assert.equal(decision.retry_after_ms, 600_000, "the provider's own time is still reported");

  // The same failure inside a window that CAN hold it retries, at the
  // provider's time rather than the local curve.
  const roomy = planRetry({ policy: FLAT, failure, attemptNumber: 1, nowMs: NOW_MS, deadlineMs: NOW_MS + 3_600_000 });
  assert.equal(roomy.retry, true);
  assert.equal(roomy.delay_ms, 600_000);
  assert.equal(roomy.bounded_by, "provider_retry_after");
});

test("R02-06 — seeded property checks: delays stay inside their limits, the policy is monotone, and the seed reproduces it", () => {
  const policy = { ...DEFAULT_RETRY_POLICY, seed: 1 };

  // Monotone policy: the un-jittered curve never decreases as attempts pile up.
  let previous = 0;
  for (let attempt = 1; attempt <= 40; attempt += 1) {
    const curve = baseDelayFor(policy, attempt);
    assert.ok(curve >= previous, `base delay fell at attempt ${attempt}`);
    assert.ok(curve <= policy.cap_delay_ms, `base delay exceeded the cap at attempt ${attempt}`);
    previous = curve;
  }
  assert.equal(baseDelayFor(policy, 1), policy.base_delay_ms);
  assert.equal(baseDelayFor(policy, 40), policy.cap_delay_ms, "the cap is reached and held");

  // Bounds and reproducibility, over a sweep wide enough to catch a mixer that
  // produces the same jitter for consecutive seeds.
  const seen = new Set();
  for (let seed = 0; seed < 500; seed += 1) {
    for (let attempt = 1; attempt <= 20; attempt += 1) {
      const { delay_ms } = delayFor({ policy: { ...policy, seed }, attemptNumber: attempt });
      assert.ok(Number.isInteger(delay_ms), `delay ${delay_ms} is not a whole millisecond`);
      assert.ok(delay_ms >= 0 && delay_ms <= policy.cap_delay_ms, `seed ${seed} attempt ${attempt} escaped the bounds: ${delay_ms}`);
      const again = delayFor({ policy: { ...policy, seed }, attemptNumber: attempt }).delay_ms;
      assert.equal(again, delay_ms, "the same seed must reproduce the same delay, or a failure cannot be explained");
      seen.add(`${delay_ms}`);
    }
  }
  assert.ok(seen.size > 50, `jitter produced only ${seen.size} distinct delays across 10,000 draws — it is not jittering`);

  // The jitter is inside the declared ratio, and seed 0 is a real draw rather
  // than a special case that disables it.
  const ratio = policy.jitter_ratio;
  for (const seed of [0, 1, 2, 99]) {
    const attempt = 3;
    const curve = baseDelayFor(policy, attempt);
    const jitter = seededJitter(seed, attempt, ratio);
    assert.ok(Math.abs(jitter) <= ratio + Number.EPSILON, `jitter ${jitter} exceeded ±${ratio}`);
    assert.equal(delayFor({ policy: { ...policy, seed }, attemptNumber: attempt }).delay_ms, Math.round(curve * (1 + jitter)));
  }
  // Different seeds are different draws — a constant would satisfy every bound
  // above while proving nothing about reproducibility.
  const draws = new Set([0, 1, 2, 3, 4].map((seed) => delayFor({ policy: { ...policy, seed }, attemptNumber: 2 }).delay_ms));
  assert.ok(draws.size > 1, "every seed produced the same delay");
});

test("R02-21 — a possibly-billed failed request keeps the charge unknown, and is never reported as free", () => {
  const dispatchedAndFailed = reconcileCost({ dispatched: true, cost: null });
  assert.equal(dispatchedAndFailed.cost, null, "a charge nobody observed is null, not 0");
  assert.notEqual(dispatchedAndFailed.cost, 0);
  assert.equal(dispatchedAndFailed.cost_state, CHARGE_STATE.UNKNOWN_BILLED);
  assert.match(dispatchedAndFailed.detail, /may still have billed/);

  // A request that never left is the one case where no charge is possible.
  const neverSent = reconcileCost({ dispatched: false, cost: null });
  assert.equal(neverSent.cost, null);
  assert.equal(neverSent.cost_state, CHARGE_STATE.NOT_DISPATCHED);
  assert.notEqual(neverSent.cost_state, dispatchedAndFailed.cost_state, "two different nothings must not read alike");

  // A provider-reported zero is a MEASUREMENT and survives as one.
  const freeButMeasured = reconcileCost({ dispatched: true, cost: 0 });
  assert.equal(freeButMeasured.cost, 0);
  assert.equal(freeButMeasured.cost_state, CHARGE_STATE.MEASURED);
  assert.notEqual(freeButMeasured.cost_state, dispatchedAndFailed.cost_state, "measured free ≠ unknown");
});

test("R02-21 — a canary that failed after dispatch reports an unknown charge, end to end", async () => {
  const clock = { at: NOW_MS };
  const result = await runCanary({
    engine: "chatgpt",
    env: { LLM_API_KEY: FAKE, LLM_BASE_URL: "https://openrouter.ai/api/v1" },
    probe: async () => {
      throw Object.assign(new Error("socket hang up"), { name: "TypeError" });
    },
    now: () => clock.at,
    sleep: async (ms) => {
      clock.at += ms;
    },
    deadlineMs: NOW_MS + 600_000,
    policy: { max_attempts: 1, base_delay_ms: 0, cap_delay_ms: 0, jitter_ratio: 0, seed: 0 },
  });

  assert.equal(result.requests, 1);
  assert.equal(result.observation, null);
  assert.equal(result.canary.charge.cost, null);
  assert.equal(result.canary.charge.cost_state, CHARGE_STATE.UNKNOWN_BILLED);
  assert.equal(result.canary.charge.cost_state === CHARGE_STATE.MEASURED, false);

  // A refused plan never left the process, so it is not billed at all.
  const refused = await runCanary({ engine: "chatgpt", env: {}, probe: async () => ({ valid: true }), now: () => clock.at });
  assert.equal(refused.requests, 0);
  assert.equal(refused.charge.cost_state, CHARGE_STATE.NOT_DISPATCHED);
});
