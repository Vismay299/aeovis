import test from "node:test";
import assert from "node:assert/strict";

import {
  ENGINE_KEYS,
  READINESS,
  READY_TTL_MS,
  buildProviderReadiness,
  circuitIdentity,
  configVersion,
  credentialFingerprint,
  credentialNamesFor,
  planEngineCanary,
  readinessForEngine,
  runCanary,
  validateEngineConfig,
} from "../engines/providerReadiness.js";
import { OPENAI_PROVIDER } from "../engines/openai.js";
import { PERPLEXITY_PROVIDER } from "../engines/perplexity.js";

/**
 * R01-01/R01-02/R01-03/R01-14 — readiness is not the same question as "is a
 * variable set".
 *
 * Every fixture here passes an explicit `env` object rather than touching
 * `process.env`, so the assertions describe the deployment being tested and not
 * whatever shell ran the suite. No provider is contacted: the modules under
 * test are pure, and `runCanary` is only ever given a probe stub.
 */

/** Unmistakably fake, and never asserted on as a value — only as an absence. */
const FAKE = "EXAMPLE-NOT-A-REAL-CREDENTIAL-0000000000";
const NOW_MS = Date.parse("2026-10-16T10:00:00.000Z");
const NOW = new Date(NOW_MS).toISOString();

const SHARED_GATEWAY_ENV = Object.freeze({ LLM_API_KEY: FAKE, LLM_BASE_URL: "https://openrouter.ai/api/v1" });

/** A probe stub that counts its calls, so "zero provider requests" is measured. */
function countingProbe(result = { valid: true, answer: "fixture answer" }) {
  const probe = async () => {
    probe.calls += 1;
    return typeof result === "function" ? result(probe.calls) : result;
  };
  probe.calls = 0;
  return probe;
}

test("R01-01 — a present credential yields configured + unverified, and invents no success timestamp", async () => {
  for (const env of [SHARED_GATEWAY_ENV, { BRIGHTDATA_API_KEY: FAKE }]) {
    const engine = env.BRIGHTDATA_API_KEY ? "aio" : "chatgpt";
    const report = readinessForEngine({ engine, env, canary: null, now: NOW });

    assert.equal(report.configured, true, "the credential IS present");
    assert.equal(report.readiness, READINESS.UNVERIFIED, "presence is not proof that it works");
    assert.notEqual(report.readiness, READINESS.READY);
    assert.equal(report.last_success_at, null, "no success was observed, so there is no timestamp to report");
    assert.equal(report.measured_at, null);
    assert.equal(report.ready_age_ms, null, "an age nobody measured is null, never a number");
    assert.equal(report.current, false);
    assert.equal(report.reason, "no_canary");
    assert.equal(report.canary, null);
    assert.equal(report.provider_requests, 0, "resolving readiness must never dispatch");
  }

  // The same claim through the aggregate a health read would carry.
  const aggregate = buildProviderReadiness({
    engines: ["chatgpt", "aio"],
    env: { ...SHARED_GATEWAY_ENV, BRIGHTDATA_API_KEY: FAKE },
    canaries: {},
    now: NOW,
  });
  assert.deepEqual(aggregate.summary.unverified, ["chatgpt", "aio"]);
  assert.deepEqual(aggregate.summary.ready, [], "nothing is advertised ready off a variable");
  assert.equal(aggregate.provider_requests, 0);

  // ...and a canary that never ran cannot make it ready either.
  const noProbe = countingProbe();
  const result = await runCanary({ engine: "chatgpt", env: {}, probe: noProbe, now: () => NOW_MS });
  assert.equal(noProbe.calls, 0);
  assert.equal(result.readiness, READINESS.BLOCKED);
});

test("R01-02 — a missing required variable blocks the engine by name, with zero provider requests", async () => {
  const env = { GEMINI_API_KEY: FAKE };

  const verdict = validateEngineConfig("chatgpt", env);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "missing_credential");
  // Both ROUTES are named, because either one is a fix: the native key or the
  // shared gateway credential.
  assert.deepEqual(verdict.missing, ["OPENAI_API_KEY", "LLM_API_KEY"], "the variables that are the fix are named");
  assert.equal(verdict.provider_requests, 0);
  assert.match(verdict.corrective_action, /LLM_API_KEY/);
  assert.deepEqual(credentialNamesFor("chatgpt"), ["OPENAI_API_KEY", "LLM_API_KEY"]);

  // The aio surface names its own variable, and an unknown engine is refused
  // rather than silently treated as unconfigured.
  assert.deepEqual(validateEngineConfig("aio", {}).missing, ["BRIGHTDATA_API_KEY"]);
  assert.equal(validateEngineConfig("shopping", env).reason, "unsupported_engine");
  // Every OFFERED surface, with nothing configured, blocks and names a fix —
  // there is no engine whose absence of a credential is silent.
  for (const key of ENGINE_KEYS) {
    const blocked = validateEngineConfig(key, {});
    assert.equal(blocked.reason, "missing_credential", `${key} must block, not shrug`);
    assert.ok(blocked.missing.length > 0, `${key} must name the variable`);
  }

  // Zero provider requests, measured: the canary cannot dispatch a blocked engine.
  const probe = countingProbe();
  const result = await runCanary({ engine: "chatgpt", env, probe, now: () => NOW_MS });
  assert.equal(probe.calls, 0, "a blocked engine must not reach the provider");
  assert.equal(result.dispatched, false);
  assert.equal(result.requests, 0);
  assert.equal(result.canary, null, "a canary that was refused produces no record to read as evidence");
  assert.equal(result.readiness, READINESS.BLOCKED);
  assert.equal(result.refusal.reason, "missing_credential");

  // ...and the report contains the NAME of the fix and no credential value.
  const report = readinessForEngine({ engine: "chatgpt", env, canary: null, now: NOW });
  assert.equal(report.readiness, READINESS.BLOCKED);
  assert.match(report.operator_action, /LLM_API_KEY/);
  assert.doesNotMatch(JSON.stringify(report), /EXAMPLE-NOT-A-REAL-CREDENTIAL/);
});

test("R01-03 — an unsupported gateway is refused before dispatch, naming the pair and the fix", async () => {
  const env = { ...SHARED_GATEWAY_ENV, LLM_BASE_URL: "https://api.xiaomimimo.com/v1" };
  const plan = planEngineCanary("chatgpt", env);

  assert.equal(plan.dispatch, false, "the refusal happens before anything is sent");
  assert.deepEqual(plan.dispatch_plan, [], "there is no target to dispatch to");
  assert.equal(plan.refusal.reason, "unsupported_gateway");
  assert.match(plan.refusal.detail, /mimo/, "the SELECTED gateway is named, not just a failure code");
  assert.match(plan.refusal.corrective_action, /LLM_BASE_URL/);
  assert.match(plan.refusal.corrective_action, /OPENAI_API_KEY/, "and the native alternative is offered");

  const probe = countingProbe();
  const result = await runCanary({ engine: "chatgpt", env, probe, now: () => NOW_MS });
  assert.equal(probe.calls, 0);
  assert.equal(result.dispatched, false);
  assert.equal(result.readiness, READINESS.BLOCKED);
});

test("R01-03 — an unsupported model id is refused before dispatch, naming the pair and the fix", async () => {
  const env = { ...SHARED_GATEWAY_ENV, OPENROUTER_OPENAI_MODEL: "gpt-6-luna" };
  const plan = planEngineCanary("chatgpt", env);

  assert.equal(plan.dispatch, false);
  assert.equal(plan.refusal.reason, "unsupported_model");
  assert.match(plan.refusal.detail, /gpt-6-luna/, "the selected model is named");
  assert.match(plan.refusal.detail, /openrouter/, "and with it the gateway it was selected on");
  assert.match(plan.refusal.corrective_action, /provider\/model/);

  // The supported spelling of the same pair is accepted, so the refusal pins
  // the pair and not "models are unsupported".
  const supported = planEngineCanary("chatgpt", { ...SHARED_GATEWAY_ENV, OPENROUTER_OPENAI_MODEL: "openai/gpt-6-luna" });
  assert.equal(supported.dispatch, true);
  assert.equal(supported.model, "openai/gpt-6-luna");
});

test("R01-14 — a rotated credential makes the previous result historical, and the new one unverified", async () => {
  const envA = { LLM_API_KEY: "EXAMPLE-KEY-A", LLM_BASE_URL: "https://openrouter.ai/api/v1" };
  const envB = { LLM_API_KEY: "EXAMPLE-KEY-B", LLM_BASE_URL: "https://openrouter.ai/api/v1" };

  const clock = { at: NOW_MS };
  const probe = countingProbe();
  const run = await runCanary({
    engine: "chatgpt",
    env: envA,
    probe,
    now: () => clock.at,
    deadlineMs: NOW_MS + 60_000,
  });
  assert.equal(run.readiness, READINESS.READY);

  const readyA = readinessForEngine({ engine: "chatgpt", env: envA, canary: run.canary, now: NOW });
  assert.equal(readyA.readiness, READINESS.READY);
  assert.equal(readyA.last_success_at, run.canary.observed_at, "the observed time, not a fabricated one");
  assert.equal(readyA.historical, false);

  // The credential rotates. The old success is now evidence about a
  // configuration that no longer exists.
  const afterRotation = readinessForEngine({ engine: "chatgpt", env: envB, canary: run.canary, now: NOW });
  assert.equal(afterRotation.readiness, READINESS.UNVERIFIED, "B has never been verified");
  assert.equal(afterRotation.historical, true);
  assert.equal(afterRotation.reason, "config_changed");
  assert.equal(afterRotation.last_success_at, null, "the old success is not current readiness");
  assert.equal(afterRotation.canary_outcome, "valid", "...but the observation survives as history");
  assert.equal(afterRotation.canary_observed_at, run.canary.observed_at);
  assert.notEqual(afterRotation.config_version, run.canary.config_version);

  // B earns its own readiness through its own check, and only then.
  const runB = await runCanary({
    engine: "chatgpt",
    env: envB,
    probe,
    now: () => clock.at,
    deadlineMs: NOW_MS + 60_000,
  });
  const readyB = readinessForEngine({ engine: "chatgpt", env: envB, canary: runB.canary, now: NOW });
  assert.equal(readyB.readiness, READINESS.READY);
  assert.equal(readyB.historical, false);
  assert.equal(readyB.last_success_at, runB.canary.observed_at);

  // The configuration identity distinguishes the two without ever carrying the
  // credential itself.
  const versionA = configVersion("chatgpt", envA);
  const versionB = configVersion("chatgpt", envB);
  assert.notEqual(versionA, versionB);
  assert.doesNotMatch(versionA, /EXAMPLE-KEY-A/);
  assert.doesNotMatch(versionB, /EXAMPLE-KEY-B/);
});

test("R01-14 — a valid measurement older than the readiness window is stale, not current", async () => {
  const probe = countingProbe();
  const run = await runCanary({
    engine: "chatgpt",
    env: SHARED_GATEWAY_ENV,
    probe,
    now: () => NOW_MS,
    deadlineMs: NOW_MS + 60_000,
  });

  const readAt = NOW_MS + READY_TTL_MS + 1;
  const report = readinessForEngine({
    engine: "chatgpt",
    env: SHARED_GATEWAY_ENV,
    canary: run.canary,
    now: new Date(readAt).toISOString(),
  });

  assert.equal(report.readiness, READINESS.STALE);
  assert.equal(report.current, false);
  assert.equal(report.reason, "canary_expired");
  assert.equal(report.ready_age_ms, READY_TTL_MS + 1, "the real age is reported, not hidden");
  assert.equal(report.last_success_at, run.canary.observed_at, "stale is not the same as never measured");
  assert.match(report.operator_action, /canary/i);
});

test("R01-03 — an unknown engine is refused as unsupported, never reported as merely unverified", () => {
  const report = readinessForEngine({ engine: "shopping", env: {}, canary: null, now: NOW });
  assert.equal(report.readiness, READINESS.BLOCKED);
  assert.equal(report.reason, "unsupported_engine");
  assert.equal(report.configured, false);

  const aggregate = buildProviderReadiness({
    engines: ["shopping"],
    env: { ...SHARED_GATEWAY_ENV, BRIGHTDATA_API_KEY: FAKE },
    canaries: {},
    now: NOW,
  });
  assert.deepEqual(aggregate.summary.blocked, ["shopping"]);
  assert.match(aggregate.degraded_reason, /not an offered surface/);
});

test("R01-14 — a deprecated credential alias is the effective account, and rotating it invalidates the old read", async () => {
  const envA = { OPENROUTER_API_KEY: "EXAMPLE-LEGACY-A", LLM_BASE_URL: "https://openrouter.ai/api/v1" };
  const envB = { OPENROUTER_API_KEY: "EXAMPLE-LEGACY-B", LLM_BASE_URL: "https://openrouter.ai/api/v1" };

  // The adapter accepts the alias, so the identity must name and see the
  // variable that actually carries the value — a legacy-only deployment is not
  // "unconfigured".
  assert.match(credentialFingerprint("chatgpt", envA), /^OPENROUTER_API_KEY#/);
  assert.notEqual(configVersion("chatgpt", envA), configVersion("chatgpt", envB));
  assert.match(configVersion("chatgpt", envA), /OPENROUTER_API_KEY#/);
  assert.doesNotMatch(configVersion("chatgpt", envA), /EXAMPLE-LEGACY-A/, "the version never carries the value");

  // Two different legacy-key accounts must not collapse into one unidentified
  // circuit, or the first one's failure would block the second.
  assert.notEqual(circuitIdentity("chatgpt", envA).account, circuitIdentity("chatgpt", envB).account);
  assert.equal(circuitIdentity("chatgpt", envA).provider, "openrouter");

  // The rotation is what makes the previous result historical, not ready.
  const clock = { at: NOW_MS };
  const run = await runCanary({
    engine: "chatgpt",
    env: envA,
    probe: countingProbe(),
    now: () => clock.at,
    deadlineMs: NOW_MS + 60_000,
  });
  assert.equal(run.readiness, READINESS.READY);

  const afterRotation = readinessForEngine({ engine: "chatgpt", env: envB, canary: run.canary, now: NOW });
  assert.equal(afterRotation.readiness, READINESS.UNVERIFIED, "B has never been verified");
  assert.equal(afterRotation.historical, true);
  assert.equal(afterRotation.reason, "config_changed");
  assert.equal(afterRotation.last_success_at, null, "the old success is not current readiness");
});

test("R01-14 — the canonical credential name outranks its alias in the effective identity", () => {
  const canonical = {
    LLM_API_KEY: "EXAMPLE-CANONICAL",
    OPENROUTER_API_KEY: "EXAMPLE-IGNORED-ALIAS",
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
  };

  // The adapter reads canonical first, so the fingerprint must too; the alias is
  // present but is NOT the account that will be called.
  assert.match(credentialFingerprint("chatgpt", canonical), /^LLM_API_KEY#/);
  assert.doesNotMatch(credentialFingerprint("chatgpt", canonical), /OPENROUTER_API_KEY/);
  assert.match(configVersion("chatgpt", canonical), /:LLM_API_KEY#/);
});

test("R01-14 — provider identity follows the selected route, native versus shared", () => {
  const sharedEnv = SHARED_GATEWAY_ENV;

  // The native probe calls api.openai.com, so its provider is the adapter's own
  // OpenAI constant — not the shared gateway's.
  const chatNative = planEngineCanary("chatgpt", { OPENAI_API_KEY: FAKE });
  assert.equal(chatNative.adapter, "vendor_api");
  assert.equal(chatNative.provider, OPENAI_PROVIDER);
  assert.equal(chatNative.circuit_identity.provider, OPENAI_PROVIDER);
  assert.equal(chatNative.gateway, null, "a native route consults no gateway");
  assert.equal(chatNative.config_identity.provider, OPENAI_PROVIDER);

  const chatShared = planEngineCanary("chatgpt", sharedEnv);
  assert.equal(chatShared.adapter, "shared_gateway");
  assert.equal(chatShared.provider, "openrouter");
  assert.equal(chatShared.circuit_identity.provider, "openrouter");
  assert.equal(chatShared.config_identity.provider, "openrouter");

  // The same for Perplexity, whose native probe calls api.perplexity.ai.
  const pplxNative = planEngineCanary("perplexity", { PERPLEXITY_API_KEY: FAKE });
  assert.equal(pplxNative.adapter, "vendor_api");
  assert.equal(pplxNative.provider, PERPLEXITY_PROVIDER);
  const pplxShared = planEngineCanary("perplexity", sharedEnv);
  assert.equal(pplxShared.adapter, "shared_gateway");
  assert.equal(pplxShared.provider, "openrouter");

  // A native route is a different identity from the shared one: different
  // provider, different account, different config version.
  assert.notEqual(chatNative.config_version, chatShared.config_version);
  assert.notEqual(chatNative.circuit_identity.account, chatShared.circuit_identity.account);

  // The native branch takes precedence when both credentials are set, which is
  // the branch src/lib/engines/openai.js takes.
  const both = planEngineCanary("chatgpt", { ...sharedEnv, OPENAI_API_KEY: FAKE });
  assert.equal(both.adapter, "vendor_api");
  assert.equal(both.provider, OPENAI_PROVIDER);
  assert.match(both.config_identity.credential_fingerprint, /^OPENAI_API_KEY#/);
});
