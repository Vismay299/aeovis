import test from "node:test";
import assert from "node:assert/strict";

import { brightDataSearch, resetRenderedAioMemo } from "../engines/brightdata.js";
import { isOpenRouterEngineConfigured } from "../engines/openRouterProbe.js";
import { buildHealthPayload } from "../health.js";
import { VENDORS } from "../vendorRegistry.js";
import {
  CANARY_QUERY,
  READINESS,
  buildProviderReadiness,
  planEngineCanary,
  readinessForEngine,
  runCanary,
  validateEngineConfig,
} from "../engines/providerReadiness.js";
import { PROVIDER_FAILURE } from "../engines/providerFailure.js";

/**
 * R01-04/R01-09/R01-10/R01-11/R01-12 — the canary itself, and the reads that
 * must never become one.
 *
 * These are the I-level cases: real modules wired to controlled provider
 * substitutes. R01-09 in particular drives the REAL Bright Data adapter with a
 * stubbed `fetch`, so the envelope shape under test is the one production code
 * produces (`proxySessionError` in src/lib/engines/brightdata.js) rather than a
 * re-description of it in a fixture.
 */

const FAKE = "EXAMPLE-NOT-A-REAL-CREDENTIAL-0000000000";
const NOW_MS = Date.parse("2026-10-16T10:00:00.000Z");

const SHARED_GATEWAY_ENV = Object.freeze({
  LLM_API_KEY: FAKE,
  LLM_BASE_URL: "https://openrouter.ai/api/v1",
});

/**
 * A clock and a sleep that agree, so a backoff delay costs no wall-clock time
 * and "the delay fit inside the deadline" is arithmetic rather than a race.
 */
function fakeClock(startMs = NOW_MS) {
  const state = { at: startMs, sleeps: [] };
  return {
    now: () => state.at,
    sleep: async (ms) => {
      state.sleeps.push(ms);
      state.at += ms;
    },
    get at() {
      return state.at;
    },
    get sleeps() {
      return state.sleeps;
    },
  };
}

/** A probe stub whose per-call answers are scripted, and whose calls are counted. */
function scriptedProbe(answers) {
  const probe = async () => {
    probe.calls += 1;
    const next = answers[Math.min(probe.calls, answers.length) - 1];
    return typeof next === "function" ? next(probe.calls) : next;
  };
  probe.calls = 0;
  return probe;
}

test("R01-04 — a shared gateway with no direct vendor keys selects the shared adapter, exactly once", async () => {
  for (const engine of ["chatgpt", "perplexity"]) {
    const plan = planEngineCanary(engine, SHARED_GATEWAY_ENV);

    assert.equal(plan.refusal, null, `${engine}: a missing direct key must not disable the shared route`);
    assert.equal(plan.dispatch, true);
    assert.equal(plan.adapter, "shared_gateway");
    assert.equal(plan.dispatch_plan.length, 1, "one adapter, so one paid call per prompt");
    assert.equal(plan.provider_requests, 0, "planning is not dispatching");

    // The adapter's OWN predicate agrees with the plan — one definition of
    // "is this engine callable", not a second opinion computed here.
    assert.equal(isOpenRouterEngineConfigured(engine, SHARED_GATEWAY_ENV), true);

    // One shared credential serves every gateway-routed engine.
    assert.equal(plan.config_identity.credential_variables.includes("LLM_API_KEY"), true);
    assert.match(plan.config_identity.credential_fingerprint, /^LLM_API_KEY#/, "the carrying variable is named");
    assert.deepEqual(planEngineCanary(engine, SHARED_GATEWAY_ENV).dispatch_plan, plan.dispatch_plan, "stable");
  }

  // The offered Gemini surface also uses the shared gateway. The standalone
  // native utility is not the scan adapter.
  const gemini = validateEngineConfig("gemini", SHARED_GATEWAY_ENV);
  assert.equal(gemini.ok, true);
  assert.equal(planEngineCanary("gemini",SHARED_GATEWAY_ENV).provider,"openrouter");
});

test("R01-09 — a Bright Data capacity envelope stays a failure with no no-AIO answer and no geography change", async () => {
  resetRenderedAioMemo();
  const savedEnv = {
    BRIGHTDATA_API_KEY: process.env.BRIGHTDATA_API_KEY,
    BRIGHTDATA_SERP_ZONE: process.env.BRIGHTDATA_SERP_ZONE,
    SERP_GEO: process.env.SERP_GEO,
  };
  const realFetch = globalThis.fetch;
  const requested = [];
  process.env.BRIGHTDATA_API_KEY = FAKE;
  // Set the zone so the adapter never fires its own discovery call: every
  // request counted below is the SERP probe.
  process.env.BRIGHTDATA_SERP_ZONE = "serp_test";
  process.env.SERP_GEO = "in";
  globalThis.fetch = async (url, init) => {
    requested.push({ url: String(url), body: JSON.parse(init.body) });
    // The documented envelope: HTTP 200, an empty body, and the real cause in a
    // header. This is what `proxySessionError` exists to catch.
    return new Response(JSON.stringify({ headers: { "x-brd-error": "no_ready_cookies" }, body: "" }), {
      status: 200,
    });
  };

  try {
    const env = { BRIGHTDATA_API_KEY: FAKE, BRIGHTDATA_SERP_ZONE: "serp_test", SERP_GEO: "in" };
    const clock = fakeClock();
    const result = await runCanary({
      engine: "aio",
      env,
      query: CANARY_QUERY,
      now: clock.now,
      sleep: clock.sleep,
      deadlineMs: NOW_MS + 600_000,
      probe: async () => {
        const serp = await brightDataSearch(CANARY_QUERY, { attempts: 1, backoffMs: 0 });
        return { valid: Boolean(serp?.organic || serp?.general), no_aio: !serp?.ai_overview };
      },
    });

    // A capacity failure is retryable, so the canary spends its bounded attempt
    // ceiling on it — three attempts, three requests, and no more.
    assert.equal(result.requests, 3, "the attempt ceiling bounds a capacity failure");
    // The first attempt asks for the rendered AI Overview, finds the cookie pool
    // empty and falls back once to the standard SERP; the remembered empty pool
    // sends the later attempts straight to the standard SERP. Every request is
    // still counted, and none rescues the failure.
    assert.equal(requested.length, 4, "every provider request is counted, including the one fallback");
    for (const attempt of result.attempts) {
      assert.equal(attempt.kind, PROVIDER_FAILURE.PROVIDER_CAPACITY);
      assert.equal(attempt.provider_code, "no_ready_cookies", "the provider's own code is preserved");
    }
    assert.equal(result.observation, null, "an envelope with no page is not a measurement of anything");
    assert.notEqual(result.readiness, READINESS.READY);
    assert.equal(result.canary.deadline_exceeded, false);
    assert.equal(result.attempts[2].stop_reason, "attempts_exhausted");

    // No no-AIO success anywhere in the record, and no brand-absence claim.
    assert.equal(result.canary.observation, null);
    assert.equal(result.canary.failure.brand_absence, false);
    assert.equal(
      result.attempts.some((attempt) => attempt.kind === null),
      false,
      "no attempt may be recorded as a success"
    );

    // Geography: requested and observed stay separate, and no attempt was
    // rewritten to rescue the failure.
    assert.equal(result.canary.location.requested, "in");
    assert.equal(result.canary.location.observed, null);
    assert.equal(result.canary.location.status, "unverified");
    for (const attempt of requested) {
      assert.equal(attempt.url, "https://api.brightdata.com/request");
      assert.match(attempt.body.url, /gl=in/, "the frozen geography is what was sent, on every attempt");
      assert.equal(attempt.body.country, "in", "and it is the same geography the proxy was told to use");
    }
    assert.match(requested[0].body.url, /brd_ai_overview=2/, "rendered mode is tried first");
    assert.ok(requested.slice(1).every((attempt) => !/brd_ai_overview/.test(attempt.body.url)), "then the standard SERP");
    assert.equal(process.env.SERP_GEO, "in", "nothing silently switched the market");

    // A failed request may still have been billed, and is not reported as free.
    assert.equal(result.charge.cost, null);
    assert.equal(result.charge.cost_state, "unknown_billed");

    const read = readinessForEngine({ engine: "aio", env, canary: result.canary, now: new Date(NOW_MS).toISOString() });
    assert.equal(read.readiness, READINESS.DEGRADED);
    assert.equal(read.operator_action, "investigate_provider_capacity");
    assert.equal(read.provider_requests, 0);
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("R01-10 — a 503 then a valid fixture keeps BOTH calls and reads ready off the final measurement", async () => {
  const clock = fakeClock();
  const probe = scriptedProbe([
    { valid: false, failure: { status: 503, body: "upstream exploded" } },
    { valid: true, answer: "fixture answer" },
  ]);

  const result = await runCanary({
    engine: "chatgpt",
    env: SHARED_GATEWAY_ENV,
    probe,
    now: clock.now,
    sleep: clock.sleep,
    deadlineMs: NOW_MS + 600_000,
  });

  assert.equal(probe.calls, 2, "the retry really was dispatched");
  assert.equal(result.attempts.length, 2, "and the attempt history keeps the call that failed");
  assert.equal(result.attempts[0].ok, false);
  assert.equal(result.attempts[0].kind, PROVIDER_FAILURE.TRANSIENT);
  assert.equal(result.attempts[0].status, 503);
  assert.equal(result.attempts[1].ok, true);
  assert.equal(result.observation.valid, true);
  assert.equal(result.canary.kind, null, "a successful measurement has no failure kind");
  assert.equal(result.canary.outcome, "valid");

  // Within budget: the delay fit, and the observed time is the clock's, not a
  // wall-clock stamp taken from somewhere else.
  assert.equal(clock.sleeps.length, 1);
  assert.ok(clock.sleeps[0] >= 0 && clock.sleeps[0] <= 30_000, `delay ${clock.sleeps[0]} stayed inside the cap`);
  assert.ok(clock.at <= NOW_MS + 600_000);
  assert.equal(result.canary.observed_at, new Date(clock.at).toISOString());

  const read = readinessForEngine({
    engine: "chatgpt",
    env: SHARED_GATEWAY_ENV,
    canary: result.canary,
    now: new Date(clock.at).toISOString(),
  });
  assert.equal(read.readiness, READINESS.READY, "readiness reflects the LAST measurement, not the first failure");
  assert.equal(read.last_success_at, result.canary.observed_at);
  assert.equal(read.provider_requests, 0);
});

test("R01-11 — a body that never arrives is aborted by the deadline and cannot leave readiness ready", async () => {
  const clock = fakeClock();
  let lateSettled = false;
  const probe = async () => {
    // Headers arrived, the body never will — the R04.17 shape. The rejection
    // lands after the canary has already given up, which is exactly the case
    // that must not retroactively become a measurement.
    await new Promise((resolve) => setTimeout(resolve, 60));
    lateSettled = true;
    throw Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
  };

  const result = await runCanary({
    engine: "chatgpt",
    env: SHARED_GATEWAY_ENV,
    probe,
    now: clock.now,
    sleep: clock.sleep,
    deadlineMs: NOW_MS + 30,
  });

  assert.equal(result.canary.deadline_exceeded, true);
  assert.equal(result.attempts[0].kind, PROVIDER_FAILURE.TIMEOUT);
  assert.equal(result.observation, null);
  assert.notEqual(result.readiness, READINESS.READY);
  assert.equal(result.canary.requests, 1, "one dispatch: a hung request must not be multiplied by a retry loop");

  // The late rejection is absorbed and changes nothing.
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(lateSettled, true, "the abandoned probe did settle");

  const read = readinessForEngine({
    engine: "chatgpt",
    env: SHARED_GATEWAY_ENV,
    canary: result.canary,
    now: new Date(clock.at).toISOString(),
  });
  assert.equal(read.readiness, READINESS.DEGRADED);
  assert.equal(read.last_success_at, null);
});

test("R01-11 — a malformed 200 is rejected by the parser on every attempt and never becomes a valid no-AIO", async () => {
  const clock = fakeClock();
  // A 200 whose shape is not a measurement: no `failure` carrier and no
  // affirmative validity, which is precisely the R04.1b rule.
  const probe = scriptedProbe([{ valid: false, text: "", citations: [] }]);

  const result = await runCanary({
    engine: "chatgpt",
    env: SHARED_GATEWAY_ENV,
    probe,
    now: clock.now,
    sleep: clock.sleep,
    deadlineMs: NOW_MS + 600_000,
  });

  assert.equal(probe.calls, 3, "the retry policy is exhausted first (R04.16), on the same validation as the first");
  assert.equal(result.attempts.length, 3);
  for (const attempt of result.attempts) {
    assert.equal(attempt.ok, false);
    assert.equal(attempt.kind, PROVIDER_FAILURE.PARSE);
  }
  assert.equal(result.attempts[2].stop_reason, "attempts_exhausted");
  assert.equal(result.observation, null, "a malformed 200 is never a valid no-AIO result");
  assert.notEqual(result.readiness, READINESS.READY);

  const read = readinessForEngine({
    engine: "chatgpt",
    env: SHARED_GATEWAY_ENV,
    canary: result.canary,
    now: new Date(clock.at).toISOString(),
  });
  assert.equal(read.readiness, READINESS.DEGRADED);
});

test("R01-12 — a hundred health reads make exactly zero provider requests and leave the canary untouched", async () => {
  const clock = fakeClock();
  const probe = scriptedProbe([{ valid: true, answer: "fixture answer" }]);

  const run = await runCanary({
    engine: "aio",
    env: { BRIGHTDATA_API_KEY: FAKE },
    probe,
    now: clock.now,
    sleep: clock.sleep,
    deadlineMs: NOW_MS + 600_000,
  });
  assert.equal(probe.calls, 1, "the canary itself dispatched once, which is the whole point of it existing");

  const observedAt = run.canary.observed_at;
  const env = { BRIGHTDATA_API_KEY: FAKE };
  for (let read = 0; read < 100; read += 1) {
    const report = buildProviderReadiness({ engines: ["aio"], env, canaries: { aio: run.canary }, now: new Date(clock.at).toISOString() });
    assert.equal(report.provider_requests, 0, `read ${read} dispatched`);
    assert.equal(report.engines.aio.readiness, READINESS.READY);
    assert.equal(report.engines.aio.canary_observed_at, observedAt, "the last observed canary is unchanged");
  }
  assert.equal(probe.calls, 1, "a hundred reads added no provider request");
});

test("R01-12 — a health payload carrying readiness stays dispatch-free, and a blocked surface degrades it", async () => {
  // Every required vendor configured, so the ONLY thing that can degrade the
  // endpoint below is the readiness report — not an unrelated missing variable.
  const env = {
    ...Object.fromEntries(VENDORS.flatMap((vendor) => vendor.env.map((name) => [name, "set"]))),
    LLM_API_KEY: FAKE,
    BRIGHTDATA_API_KEY: FAKE,
    OPENROUTER_GEMINI_MODEL: "invalid-model-id",
  };

  const blocked = buildProviderReadiness({ engines: ["aio", "gemini"], env, canaries: {}, now: new Date(NOW_MS).toISOString() });
  assert.deepEqual(blocked.summary.blocked, ["gemini"], "the surface whose adapter cannot be configured");

  for (let read = 0; read < 100; read += 1) {
    const payload = buildHealthPayload({
      db: { ok: true, latency_ms: 4 },
      env,
      ticks: [],
      now: new Date(NOW_MS).toISOString(),
      providerReadiness: blocked,
    });
    // The evidence that health dispatched nothing is the readiness report's own
    // request counter. An independent probe object here would be vacuous: this
    // function takes no probe, so an assertion on one could never fail.
    assert.equal(
      payload.provider_readiness.provider_requests,
      0,
      "an ordinary health poll reads the readiness report and dispatches no canary"
    );
    assert.equal(
      payload.status,
      "degraded",
      "an endpoint answering ok while a surface cannot be configured is the audit finding, not a health check"
    );
  }

  // The positive control: the same environment with nothing blocked is ok
  // again, so the degradation above pins the readiness and not the env shape.
  const healthy = buildProviderReadiness({ engines: ["aio"], env, canaries: {}, now: new Date(NOW_MS).toISOString() });
  assert.deepEqual(healthy.summary.blocked, []);
  const payload = buildHealthPayload({
    db: { ok: true },
    env,
    ticks: [],
    now: new Date(NOW_MS).toISOString(),
    providerReadiness: healthy,
  });
  assert.equal(payload.status, "ok");
  assert.equal(payload.provider_readiness.observed_at, new Date(NOW_MS).toISOString());

  // And a caller that passes no readiness gets "we did not look", not a claim.
  const anonymous = buildHealthPayload({ db: { ok: true }, env, ticks: [], now: new Date(NOW_MS).toISOString() });
  assert.equal(anonymous.provider_readiness, null);
  assert.equal(anonymous.status, "ok");
});

test("R01-11 — an already-expired deadline refuses before any dispatch", async () => {
  const probe = scriptedProbe([{ valid: true, answer: "fixture answer" }]);

  const result = await runCanary({
    engine: "chatgpt",
    env: { OPENAI_API_KEY: FAKE },
    probe,
    // The clock is already past the deadline, the reviewer's exact shape.
    now: () => 10_000,
    deadlineMs: 9_999,
  });

  assert.equal(probe.calls, 0, "a canary cannot dispatch once its own deadline has passed");
  assert.equal(result.requests, 0);
  assert.equal(result.dispatched, false);
  assert.equal(result.attempts.length, 0, "no dispatch means no attempt to record");
  assert.equal(result.canary.deadline_exceeded, true);
  assert.equal(result.canary.outcome, "failed");
  assert.equal(result.canary.kind, PROVIDER_FAILURE.TIMEOUT);
  assert.notEqual(result.readiness, READINESS.READY, "no ready canary may exist outside its deadline");
  assert.equal(result.canary.charge.cost_state, "not_dispatched", "nothing left the process, so nothing can be billed");
});

test("R01-11 — a measurement that lands after the deadline is rejected, not reported ready", async () => {
  const state = { at: NOW_MS };
  let calls = 0;
  const probe = async () => {
    calls += 1;
    // The probe answers affirmatively, but only after consuming more than the
    // whole budget: a fast resolution can win the deadline race, and this is the
    // result that must not become current readiness.
    state.at = NOW_MS + 5_000;
    return { valid: true, answer: "late fixture answer" };
  };

  const result = await runCanary({
    engine: "chatgpt",
    env: SHARED_GATEWAY_ENV,
    probe,
    now: () => state.at,
    deadlineMs: NOW_MS + 1_000,
  });

  assert.equal(calls, 1, "the late call did happen and is recorded");
  assert.equal(result.observation, null, "a late answer is not a current measurement");
  assert.notEqual(result.readiness, READINESS.READY);
  assert.equal(result.canary.deadline_exceeded, true);
  assert.equal(result.canary.kind, PROVIDER_FAILURE.TIMEOUT);
});

test("R01-10 — a backoff that overruns the deadline earns no further dispatch", async () => {
  const state = { at: NOW_MS };
  const probe = scriptedProbe([{ valid: false, failure: { status: 503, body: "upstream exploded" } }]);

  const result = await runCanary({
    engine: "chatgpt",
    env: SHARED_GATEWAY_ENV,
    probe,
    now: () => state.at,
    // The injected backoff lands the clock PAST the deadline, the way a real
    // delay plus scheduling slop can, so the retry must be refused even though
    // the policy believed the delay fit.
    sleep: async (ms) => {
      state.at += ms + 500;
    },
    deadlineMs: NOW_MS + 1_200,
    policy: { max_attempts: 5, base_delay_ms: 1_000, cap_delay_ms: 30_000, jitter_ratio: 0, seed: 7 },
  });

  assert.equal(probe.calls, 1, "one dispatch, then the deadline — never a second request");
  assert.equal(result.requests, 1);
  assert.equal(result.canary.deadline_exceeded, true);
  assert.equal(result.attempts[0].kind, PROVIDER_FAILURE.TRANSIENT);
  assert.notEqual(result.readiness, READINESS.READY);
});
