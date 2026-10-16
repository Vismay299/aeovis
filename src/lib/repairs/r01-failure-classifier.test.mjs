import test from "node:test";
import assert from "node:assert/strict";

import {
  FAILURE_KIND,
  classifyHttpStatus,
} from "../engines/httpFailureKind.js";
import {
  PROVIDER_FAILURE,
  classifyProviderFailure,
  operatorActionFor,
  parseRetryAfterMs,
  isRetryableProviderFailure,
  sanitizeProviderText,
} from "../engines/providerFailure.js";
import { ATTEMPT_DISPOSITION, planRetry } from "../attemptPolicy.js";
import { isValidMeasurement } from "../engines/providerReadiness.js";

/**
 * R01-05..R01-08 — the failure classifier, which is where "configured
 * credentials reported healthy" actually starts.
 *
 * Every assertion below calls `classifyProviderFailure` on a fixture and reads
 * the verdict, because the defect was never in one adapter's retry loop: it was
 * that a 401, a 403, a credit-limited 429 and a busy 429 all arrived
 * downstream as the same undifferentiated failure, so nothing could say which
 * one an operator should fix.
 *
 * NO NETWORK, NO CREDENTIALS. The provider bodies are literals built here, and
 * the fake credential is unmistakably fake so that the sanitisation assertions
 * mean something.
 */

/** An unmistakably fake key, so "it never appears" is a real assertion. */
const FAKE_KEY = "EXAMPLE-NOT-A-REAL-KEY-0000000000";

const NOW = Date.parse("2026-10-16T10:00:00.000Z");

test("R01-05 — a 401 is a credential rejection, is never retried, and names the provider", () => {
  const c = classifyProviderFailure({
    provider: "openrouter",
    status: 401,
    body: { error: { code: "invalid_api_key", message: "Incorrect API key provided" } },
    nowMs: NOW,
  });

  assert.equal(c.kind, PROVIDER_FAILURE.AUTHENTICATION);
  assert.equal(c.retryable, false, "a revoked key is not a reason to ask twice more");
  assert.equal(c.opens_circuit, true, "the dependents on this credential have to stop too");
  assert.equal(c.action, "repair_credentials");
  assert.equal(c.provider_code, "invalid_api_key");
  assert.match(c.message, /openrouter/, "an operator must not have to guess which provider was refused");

  const decision = planRetry({ failure: c, attemptNumber: 1, nowMs: NOW, deadlineMs: NOW + 600_000 });
  assert.equal(decision.retry, false, "no automatic retry");
  assert.equal(decision.next_attempt, null);
  assert.equal(decision.terminal, true);
  assert.equal(decision.disposition, ATTEMPT_DISPOSITION.BLOCKED);
  assert.deepEqual(decision.circuit_action, {
    action: "open",
    kind: PROVIDER_FAILURE.AUTHENTICATION,
    reason: c.message,
  });
});

test("R01-05 — a bare 401 with no provider code is still a credential rejection, read off the status", () => {
  const c = classifyProviderFailure({ provider: "openai", status: 401, nowMs: NOW });
  assert.equal(c.kind, PROVIDER_FAILURE.AUTHENTICATION);
  assert.equal(c.evidence, "status");
  assert.equal(c.provider_code, null);
  assert.equal(c.retryable, false);
});

test("R01-05 — the operator message and detail carry no credential value out of the provider body", () => {
  const c = classifyProviderFailure({
    provider: "openrouter",
    status: 401,
    body: { error: { code: "invalid_api_key", message: `Incorrect API key provided: ${FAKE_KEY}` } },
    headers: { authorization: `Bearer ${FAKE_KEY}` },
    nowMs: NOW,
  });

  assert.equal(c.provider_code, "invalid_api_key", "the allowlisted code still identifies the cause");
  assert.doesNotMatch(c.message, /EXAMPLE-NOT-A-REAL-KEY/);
  assert.doesNotMatch(c.detail ?? "", /EXAMPLE-NOT-A-REAL-KEY/);
  // The redaction is what removes it, not the absence of the string in the body.
  assert.match(c.detail ?? "", /\[redacted\]/);
  assert.equal(sanitizeProviderText(`Bearer ${FAKE_KEY}`), "Bearer [redacted]");
});

test("R01-05 — retry eligibility stays the shared classifier's verdict, narrowed and never widened", () => {
  // The one place two vocabularies could silently disagree. Every bare status
  // is checked against httpFailureKind.classifyHttpStatus, in both directions.
  for (const status of [400, 401, 402, 403, 404, 408, 418, 422, 425, 429, 451, 500, 503, 504]) {
    const shared = classifyHttpStatus(status) === FAILURE_KIND.TRANSIENT;
    const c = classifyProviderFailure({ provider: "p", status, nowMs: NOW });
    assert.equal(
      c.retryable,
      shared,
      `HTTP ${status}: the richer vocabulary must not overrule the shared retry verdict`
    );
  }
  // ...and a provider code may only ever make a transient-LOOKING failure
  // permanent, never the reverse.
  const narrowed = classifyProviderFailure({
    provider: "openai",
    status: 429,
    body: { error: { code: "insufficient_quota" } },
    nowMs: NOW,
  });
  assert.equal(classifyHttpStatus(429), FAILURE_KIND.TRANSIENT, "the status alone is retryable");
  assert.equal(narrowed.kind, PROVIDER_FAILURE.SPEND_LIMIT);
  assert.equal(narrowed.retryable, false, "a spent key is not throttling");
});

test("R01-06 — a key/credit limit is budget-blocked, not temporary throttling", () => {
  for (const code of ["insufficient_quota", "credit_limit_exceeded", "billing_hard_limit_reached", "key_limit_exceeded"]) {
    const limited = classifyProviderFailure({
      provider: "openai",
      status: 429,
      body: { error: { code, message: "You exceeded your current quota" } },
      nowMs: NOW,
    });
    const throttled = classifyProviderFailure({
      provider: "openai",
      status: 429,
      body: { error: { message: "Too many requests" } },
      nowMs: NOW,
    });

    assert.equal(limited.kind, PROVIDER_FAILURE.SPEND_LIMIT, `${code} is a budget limit`);
    assert.equal(throttled.kind, PROVIDER_FAILURE.RATE_LIMIT, "the same status without a limit code is throttling");
    assert.notEqual(limited.kind, throttled.kind);
    assert.notEqual(
      operatorActionFor(limited.kind),
      operatorActionFor(throttled.kind),
      "reviewing limits and waiting for a reset are different operator actions"
    );
    assert.equal(limited.retryable, false);
    assert.equal(throttled.retryable, true);
    assert.equal(limited.opens_circuit, true, "a spent key stops the dependents");
    assert.equal(throttled.opens_circuit, false, "throttling clears by itself");
  }
});

test("R01-06 — the reset time is UNKNOWN unless the provider actually said one", () => {
  const limited = classifyProviderFailure({
    provider: "openai",
    status: 429,
    body: { error: { code: "insufficient_quota" } },
    nowMs: NOW,
  });

  assert.equal(limited.reset_observed, false);
  assert.equal(limited.reset_source, null);
  assert.equal(limited.retry_after_ms, null);
  assert.notEqual(limited.retry_after_ms, 0, "an unobserved reset must not be a measured zero");

  const decision = planRetry({
    failure: limited,
    attemptNumber: 1,
    nowMs: NOW,
    deadlineMs: NOW + 600_000,
    policy: { max_attempts: 3, base_delay_ms: 1000, cap_delay_ms: 30_000, jitter_ratio: 0, seed: 7 },
  });
  assert.equal(decision.retry, false, "a budget limit never earns a retry, whatever the clock says");
});

test("R01-07 — a 429 with Retry-After is retryable throttling carrying the parsed retry time", () => {
  const seconds = classifyProviderFailure({
    provider: "openrouter",
    status: 429,
    headers: { "retry-after": "45" },
    body: { error: { message: "rate limit exceeded" } },
    nowMs: NOW,
  });

  assert.equal(seconds.kind, PROVIDER_FAILURE.RATE_LIMIT);
  assert.equal(seconds.retryable, true);
  assert.equal(seconds.retry_after_ms, 45_000);
  assert.equal(seconds.reset_observed, true);
  assert.equal(seconds.reset_source, "header:retry-after");
  assert.equal(seconds.opens_circuit, false);
  assert.doesNotMatch(seconds.message, /credit|quota|billing/i, "no account-credit failure may be invented from a 429");

  // The same header in its HTTP-date form, which providers also send.
  const at = new Date(NOW + 90_000).toUTCString();
  const dated = classifyProviderFailure({ provider: "openrouter", status: 429, headers: { "retry-after": at }, nowMs: NOW });
  assert.equal(dated.retry_after_ms, 90_000);
  assert.equal(parseRetryAfterMs(at, NOW), 90_000);

  // A `Retry-After` the provider did not send is not a value to guess at.
  assert.equal(parseRetryAfterMs("soon", NOW), null);
  assert.equal(parseRetryAfterMs("", NOW), null);
  assert.equal(parseRetryAfterMs(undefined, NOW), null);
});

test("R01-07 — the provider's retry time is honoured over the local backoff curve", () => {
  const throttled = classifyProviderFailure({
    provider: "openrouter",
    status: 429,
    headers: { "retry-after": "600" },
    nowMs: NOW,
  });

  const decision = planRetry({
    failure: throttled,
    attemptNumber: 1,
    nowMs: NOW,
    deadlineMs: NOW + 3_600_000,
    policy: { max_attempts: 3, base_delay_ms: 1000, cap_delay_ms: 30_000, jitter_ratio: 0, seed: 7 },
  });

  assert.equal(decision.retry, true);
  assert.equal(decision.delay_ms, 600_000, "waiting 1s against a 10-minute Retry-After just earns another 429");
  assert.equal(decision.bounded_by, "provider_retry_after");
  assert.equal(isRetryableProviderFailure(throttled.kind), true);
});

test("R01-08 — a challenge and a permission refusal are distinct kinds, from the same HTTP 403", () => {
  const permission = classifyProviderFailure({
    provider: "brightdata",
    status: 403,
    body: { error: { code: "permission_denied" } },
    nowMs: NOW,
  });
  const challenge = classifyProviderFailure({
    provider: "brightdata",
    status: 403,
    body: { error: { code: "challenge_required", message: "access challenge presented" } },
    nowMs: NOW,
  });
  const captchaText = classifyProviderFailure({
    provider: "brightdata",
    status: 403,
    body: { body: "<html>Please complete the CAPTCHA to continue</html>" },
    nowMs: NOW,
  });
  const bare = classifyProviderFailure({ provider: "brightdata", status: 403, nowMs: NOW });

  assert.equal(permission.kind, PROVIDER_FAILURE.PERMISSION);
  assert.equal(challenge.kind, PROVIDER_FAILURE.CHALLENGE);
  assert.equal(captchaText.kind, PROVIDER_FAILURE.CHALLENGE, "a challenge is recognised from the page text too");
  assert.equal(bare.kind, PROVIDER_FAILURE.PERMISSION, "a bare 403 is a refusal, and is never guessed to be a challenge");

  const kinds = new Set([permission.kind, challenge.kind, bare.kind]);
  assert.equal(kinds.size, 2, "a 403 does not collapse into one universal cause");
  assert.notEqual(permission.message, challenge.message);
  assert.notEqual(permission.action, challenge.action);
  assert.equal(challenge.opens_circuit, false, "an access challenge is not a credential fault");
  assert.equal(permission.opens_circuit, true);
  assert.equal(challenge.retryable, false);
});

test("R01-08 — a challenge is never recorded as a brand non-mention", () => {
  const challenge = classifyProviderFailure({
    provider: "brightdata",
    status: 403,
    body: { error: { code: "captcha_required" } },
    nowMs: NOW,
  });

  // The audit's A01 shape: a failed collection read as "the answer did not
  // mention you". Both fields are pinned, because either one alone is enough
  // for a downstream denominator to count the challenge as a measured absence.
  assert.equal(challenge.brand_absence, false);
  assert.equal(challenge.observation, null);
  assert.equal(isValidMeasurement(challenge), false);

  const decision = planRetry({ failure: challenge, attemptNumber: 1, nowMs: NOW, deadlineMs: NOW + 600_000 });
  assert.equal(decision.retry, false);
  assert.equal(decision.terminal, true);
  assert.equal(decision.disposition, ATTEMPT_DISPOSITION.EXHAUSTED, "an access barrier is not a provider-wide block");
  assert.equal(decision.circuit_action, null, "a challenge must not stop the engines that share the credential");
});

test("R01-08 — a rate limit and a spend limit are also distinct from each other and from permission", () => {
  const cases = [
    [429, null, PROVIDER_FAILURE.RATE_LIMIT],
    [429, "insufficient_quota", PROVIDER_FAILURE.SPEND_LIMIT],
    [402, null, PROVIDER_FAILURE.SPEND_LIMIT],
    [403, "insufficient_scope", PROVIDER_FAILURE.PERMISSION],
    [401, null, PROVIDER_FAILURE.AUTHENTICATION],
    [400, null, PROVIDER_FAILURE.REQUEST],
    [404, null, PROVIDER_FAILURE.REQUEST],
    [503, null, PROVIDER_FAILURE.TRANSIENT],
  ];
  for (const [status, code, expected] of cases) {
    const c = classifyProviderFailure({
      provider: "p",
      status,
      body: code ? { error: { code } } : null,
      nowMs: NOW,
    });
    assert.equal(c.kind, expected, `HTTP ${status}${code ? ` code ${code}` : ""}`);
  }
});

test("R01-08 — a provider-capacity envelope is retained as a failure, with its own operator action", () => {
  const capacity = classifyProviderFailure({
    provider: "brightdata",
    status: 200,
    headers: { "x-brd-error": "no_ready_cookies" },
    body: { headers: { "x-brd-error": "no_ready_cookies" }, body: "" },
    nowMs: NOW,
  });

  assert.equal(capacity.kind, PROVIDER_FAILURE.PROVIDER_CAPACITY);
  assert.equal(capacity.action, "investigate_provider_capacity");
  assert.equal(capacity.retryable, true, "a session pool can come back");
  assert.equal(capacity.opens_circuit, false, "not a credential or budget fault");
  assert.equal(capacity.brand_absence, false, "an envelope with no page is not 'the engine found no overview'");
  assert.equal(capacity.observation, null);
});
