import test from "node:test";
import assert from "node:assert/strict";

import {
  PROVIDER_FAILURE,
  classifyProviderFailure,
} from "./providerFailure.js";
import { AmbiguousCallError } from "../spend/errors.ts";
import { resultDecision } from "../../server/db/probeDispatch.js";
import { runCanary } from "./providerReadiness.js";

test("F02-AC-23: DataForSEO balance failures map to spend_limit and open circuit", () => {
  for (const code of ["dataforseo_40200", "dataforseo_40210", "dataforseo_http_402"]) {
    const err = new Error("Balance issue");
    err.details = { providerCode: code };

    const c = classifyProviderFailure({
      provider: "dataforseo",
      error: err,
    });

    assert.equal(c.kind, PROVIDER_FAILURE.SPEND_LIMIT, `code ${code} must map to spend_limit`);
    assert.equal(c.opens_circuit, true, `code ${code} must open circuit`);
    assert.equal(c.retryable, false, `code ${code} must not be retryable`);
    assert.equal(c.action, "review_limits");
    assert.equal(c.provider, "dataforseo");
    assert.equal(c.provider_code, code);
  }
});

test("F02-AC-23: DataForSEO 401 failures map to authentication and open circuit", () => {
  for (const code of ["dataforseo_40100", "dataforseo_http_401"]) {
    const err = new Error("Auth failed");
    err.providerCode = code;

    const c = classifyProviderFailure({
      provider: "dataforseo",
      error: err,
    });

    assert.equal(c.kind, PROVIDER_FAILURE.AUTHENTICATION, `code ${code} must map to authentication`);
    assert.equal(c.opens_circuit, true, `code ${code} must open circuit`);
    assert.equal(c.retryable, false, `code ${code} must not be retryable`);
    assert.equal(c.action, "repair_credentials");
    assert.equal(c.provider, "dataforseo");
    assert.equal(c.provider_code, code);
  }
});

test("F02-AC-23: DataForSEO backend codes map to transient and do not open circuit", () => {
  const transientCodes = [
    "dataforseo_40101",
    "dataforseo_40103",
    "dataforseo_50000",
    "dataforseo_50301",
    "dataforseo_50302",
    "dataforseo_50303",
    "dataforseo_50304",
    "dataforseo_50401",
    "dataforseo_50402",
  ];

  for (const code of transientCodes) {
    const err = new Error("Upstream error");
    err.details = { providerCode: code };

    const c = classifyProviderFailure({
      provider: "dataforseo",
      error: err,
    });

    assert.equal(c.kind, PROVIDER_FAILURE.TRANSIENT, `code ${code} must map to transient`);
    assert.equal(c.opens_circuit, false, `code ${code} must not open circuit`);
    assert.equal(c.retryable, true, `code ${code} must be retryable`);
    assert.equal(c.action, "retry");
  }
});

test("F02-AC-23: DataForSEO rate limit maps to rate_limit and does not open circuit", () => {
  const err = new Error("Rate limited");
  err.details = { providerCode: "dataforseo_http_429" };

  const c = classifyProviderFailure({
    provider: "dataforseo",
    error: err,
  });

  assert.equal(c.kind, PROVIDER_FAILURE.RATE_LIMIT);
  assert.equal(c.opens_circuit, false);
  assert.equal(c.retryable, true);
  assert.equal(c.action, "wait_for_reset");
});

test("F02-AC-23: DataForSEO invalid request codes map to request", () => {
  for (const code of ["dataforseo_40501", "dataforseo_50100"]) {
    const err = new Error("Invalid request field");
    err.details = { providerCode: code };

    const c = classifyProviderFailure({
      provider: "dataforseo",
      error: err,
    });

    assert.equal(c.kind, PROVIDER_FAILURE.REQUEST, `code ${code} must map to request`);
    assert.equal(c.opens_circuit, false);
    assert.equal(c.retryable, false);
    assert.equal(c.action, "repair_request_shape");
  }
});

test("F02-AC-23: DataForSEO timeout code maps to the timeout failure kind", () => {
  const err = new Error("DataForSEO timed out");
  err.details = { providerCode: "dataforseo_timeout" };

  const c = classifyProviderFailure({
    provider: "dataforseo",
    error: err,
  });

  assert.equal(c.kind, PROVIDER_FAILURE.TIMEOUT);
  assert.equal(c.opens_circuit, false);
});

test("ambiguous DataForSEO POST outcomes keep their failure kind and never retry", async () => {
  const cases = [
    {
      name: "timeout",
      error: new AmbiguousCallError("POST timed out", {
        status: 504,
        code: "dataforseo_timeout",
      }),
      kind: PROVIDER_FAILURE.TIMEOUT,
    },
    {
      name: "transport",
      error: new AmbiguousCallError("POST transport outcome unknown", {
        cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET" }),
      }),
      kind: PROVIDER_FAILURE.TRANSIENT,
    },
    {
      name: "HTTP 5xx",
      error: new AmbiguousCallError("POST may have been billed", {
        status: 503,
        code: "dataforseo_unavailable",
        details: { providerCode: "dataforseo_http_503" },
      }),
      kind: PROVIDER_FAILURE.TRANSIENT,
    },
    {
      name: "unreadable response",
      error: new AmbiguousCallError("POST response could not be read"),
      kind: PROVIDER_FAILURE.TRANSIENT,
    },
  ];

  for (const row of cases) {
    const failure = classifyProviderFailure({ provider: "dataforseo", error: row.error });
    assert.equal(failure.kind, row.kind, `${row.name} retains its mapped kind`);
    assert.equal(failure.ambiguous_call, true, `${row.name} is marked ambiguous`);
    assert.equal(failure.retryable, false, `${row.name} is terminal`);

    const decision = resultDecision(
      {
        engine: "chatgpt",
        error: row.error.message,
        provider_failure: { ...failure, retryable: true },
      },
      1,
      Date.now() + 60_000,
      Date.now(),
    );
    assert.equal(decision.state, "failed", `${row.name} is terminal in durable dispatch`);
    assert.equal(decision.next_at, null, `${row.name} has no retry time`);
  }
});

test("readiness canary stops after one ambiguous DataForSEO outcome", async () => {
  const error = new AmbiguousCallError("POST response could not be read");
  const failure = classifyProviderFailure({ provider: "dataforseo", error });
  let probes = 0;
  let sleeps = 0;
  const nowMs = Date.now();

  const result = await runCanary({
    engine: "chatgpt",
    env: { OPENAI_API_KEY: "test-key" },
    now: () => nowMs,
    deadlineMs: nowMs + 60_000,
    probe: async () => {
      probes += 1;
      return {
        valid: false,
        error: error.message,
        provider_failure: { ...failure, retryable: true },
      };
    },
    sleep: async () => {
      sleeps += 1;
    },
  });

  assert.equal(result.requests, 1);
  assert.equal(probes, 1);
  assert.equal(sleeps, 0);
  assert.equal(result.attempts[0].kind, PROVIDER_FAILURE.TRANSIENT);
  assert.equal(result.attempts[0].retryable, false);
});
