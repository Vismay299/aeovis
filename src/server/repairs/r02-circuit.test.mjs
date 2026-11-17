import test from "node:test";
import assert from "node:assert/strict";

import { classifyProviderFailure, PROVIDER_FAILURE } from "../../shared/engines/providerFailure.js";
import { planEngineCanary, runCanary } from "../../shared/engines/providerReadiness.js";
import {
  CIRCUIT_STATE,
  DISPATCH_REFUSAL,
  circuitKey,
  createCircuitBreaker,
  createDispatchGate,
  createSpendLedger,
  dependentEnginesByProvider,
} from "../providerCircuit.js";

/**
 * R02-17/R02-18 and the OFFLINE halves of R02-19/R02-20.
 *
 * The audit's number is 34: one revoked shared credential produced 34 identical
 * rejections per engine in a single scan, because nothing above the individual
 * probe knew that the failure was about the ACCOUNT. These tests drive a
 * dependent-engine loop through the gate and count what actually reached the
 * provider stub, which is the only form of evidence that distinguishes "we
 * stopped" from "we said we stopped".
 *
 * WHAT THESE TESTS DO NOT PROVE, said here rather than left to be inferred: the
 * in-process breaker and ledger are not the durable, cross-process objects
 * R02.5a/R02.5b require. A database row with a conditional update and a real
 * concurrent reservation race are cases R02-07..R02-16, R02-19, R02-20 and
 * R02-22, and they remain BLOCKED (no database in this pass). The decision
 * layer below is what they will be built on, and the wiring note in the repair
 * report names the seam.
 */

const FAKE = "EXAMPLE-NOT-A-REAL-CREDENTIAL-0000000000";
const NOW_MS = Date.parse("2026-10-16T10:00:00.000Z");

const ENV = Object.freeze({
  LLM_API_KEY: FAKE,
  LLM_BASE_URL: "https://openrouter.ai/api/v1",
  BRIGHTDATA_API_KEY: FAKE,
  BRIGHTDATA_SERP_ZONE: "serp_test",
  GEMINI_API_KEY: FAKE,
});

function clockAt(startMs = NOW_MS) {
  const state = { at: startMs };
  return {
    now: () => state.at,
    advance: (ms) => {
      state.at += ms;
      return state.at;
    },
    get at() {
      return state.at;
    },
  };
}

function credentialRejection(provider = "openrouter") {
  return classifyProviderFailure({
    provider,
    status: 401,
    body: { error: { code: "invalid_api_key", message: "Incorrect API key provided" } },
    nowMs: NOW_MS,
  });
}

/** A probe stub that counts real dispatches, so a refusal cannot hide one. */
function countingProbe(answer = { valid: true, answer: "fixture answer" }) {
  const probe = async () => {
    probe.calls += 1;
    return answer;
  };
  probe.calls = 0;
  return probe;
}

test("R02-17 — a shared gateway credential failure stops the dependent engines, naming provider and config", async () => {
  const clock = clockAt();
  const gate = createDispatchGate({ now: clock.now, cooldownMs: 5 * 60 * 1000 });
  const plans = Object.fromEntries(
    ["chatgpt", "perplexity", "gemini", "aio"].map((engine) => [engine, planEngineCanary(engine, ENV)])
  );

  // Which engines actually depend on the shared gateway is derived from the
  // dispatch plans, not hardcoded here.
  const groups = dependentEnginesByProvider(Object.values(plans));
  const gatewayIdentity = plans.chatgpt.circuit_identity;
  const gatewayKey = circuitKey(gatewayIdentity);
  assert.deepEqual(groups.get(gatewayKey)?.sort(), ["chatgpt", "gemini", "perplexity"]);
  assert.equal(
    circuitKey(plans.perplexity.circuit_identity),
    gatewayKey,
    "one shared credential is one shared circuit, whatever model each engine sent"
  );
  assert.equal(plans.gemini.provider, "openrouter", "The offered Gemini scan uses the same gateway circuit");

  const probe = countingProbe();
  const seen = [];
  for (const engine of ["chatgpt", "perplexity"]) {
    const plan = plans[engine];
    const verdict = gate.authorizeDispatch({ ...plan.circuit_identity, owner: "worker-1" });
    if (!verdict.allowed) {
      seen.push({ engine, refused: verdict });
      continue;
    }
    // Authorised: this is where a worker would fetch. It is stubbed, and counted.
    await probe({ engine });
    gate.recordFailure({ ...plan.circuit_identity, classification: credentialRejection(plan.provider) });
    seen.push({ engine, dispatched: true });
  }

  assert.equal(probe.calls, 1, "only the first dependent engine was allowed to spend a call");
  assert.deepEqual(seen[0], { engine: "chatgpt", dispatched: true });

  const refusal = seen[1].refused;
  assert.equal(seen[1].engine, "perplexity");
  assert.equal(refusal.allowed, false);
  assert.equal(refusal.refusal.kind, DISPATCH_REFUSAL.CIRCUIT_OPEN);
  assert.equal(refusal.refusal.provider, "openrouter");
  assert.equal(refusal.refusal.account, gatewayIdentity.account);
  assert.ok(
    refusal.reason.includes(gatewayIdentity.account),
    `the reason must name the account the circuit is scoped to: ${refusal.reason}`
  );
  assert.match(refusal.reason, /openrouter/);
  assert.match(refusal.reason, /authentication/);

  // ...and the shared breaker is genuinely shared: the identity came from the
  // plans, so the second engine did not get its own private circuit.
  assert.equal(gate.breakerFor(gatewayIdentity).state(), CIRCUIT_STATE.OPEN);
});

test("R02-18 — with the gateway circuit open, Google's independent work proceeds and is not blocked", async () => {
  const clock = clockAt();
  const gate = createDispatchGate({ now: clock.now });
  const gateway = planEngineCanary("chatgpt", ENV);
  const google = planEngineCanary("aio", ENV);

  assert.notEqual(
    circuitKey({ provider: google.provider, configVersion: google.config_version }),
    circuitKey({ provider: gateway.provider, configVersion: gateway.config_version }),
    "an unrelated provider must not share the gateway's circuit identity"
  );

  gate.recordFailure({
    provider: gateway.provider,
    configVersion: gateway.config_version,
    classification: credentialRejection(gateway.provider),
  });

  // The dependent engine is stopped...
  assert.equal(
    gate.authorizeDispatch({ provider: gateway.provider, configVersion: gateway.config_version, owner: "worker-b" }).allowed,
    false
  );

  // ...and Google is not. The authorisation is real: a canary for the
  // independent provider runs and produces a measurement.
  const authorized = gate.authorizeDispatch({
    provider: google.provider,
    configVersion: google.config_version,
    owner: "worker-b",
  });
  assert.equal(authorized.allowed, true);
  assert.equal(authorized.refusal, null);

  const probe = countingProbe({ valid: true, answer: "fixture answer" });
  const result = await runCanary({
    engine: "aio",
    env: ENV,
    probe,
    now: clock.now,
    sleep: async (ms) => clock.advance(ms),
    deadlineMs: NOW_MS + 600_000,
  });

  assert.equal(probe.calls, 1);
  assert.equal(result.observation.valid, true);
  assert.equal(result.canary.config_version, google.config_version);
  // The gateway is still open, which is what makes the success above meaningful.
  assert.equal(gate.breakerFor({ provider: gateway.provider, configVersion: gateway.config_version }).state(), CIRCUIT_STATE.OPEN);
});

test("R02-19 — OFFLINE HALF: contenders for a half-open recovery check produce exactly one canary claim", () => {
  // The D case (R02-19) needs real concurrent transactions and stays BLOCKED.
  // This proves the decision layer the durable claim must implement: one owner,
  // and no recovery stampede.
  const clock = clockAt();
  const breaker = createCircuitBreaker({
    provider: "openrouter",
    configVersion: "v1:cfg-a",
    now: clock.now,
    cooldownMs: 60_000,
  });

  breaker.record(credentialRejection());
  assert.equal(breaker.state(), CIRCUIT_STATE.OPEN);
  assert.equal(breaker.claimHalfOpenCanary("worker-1"), false, "not before the cooldown has elapsed");

  clock.advance(60_000);
  const contenders = ["worker-1", "worker-2", "worker-3", "worker-4", "worker-5"];
  const winners = contenders.filter((owner) => breaker.claimHalfOpenCanary(owner));

  assert.equal(winners.length, 1, `exactly one canary, got ${winners.join(", ")}`);
  assert.equal(breaker.state(), CIRCUIT_STATE.HALF_OPEN);
  assert.equal(breaker.snapshot().canary_owner, winners[0]);

  assert.equal(breaker.verdict(winners[0]).allowed, true, "the canary may dispatch");
  for (const other of contenders.filter((owner) => owner !== winners[0])) {
    const verdict = breaker.verdict(other);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.refusal.kind, DISPATCH_REFUSAL.HALF_OPEN_CANARY_IN_FLIGHT);
  }
  // Re-claiming as the SAME owner is idempotent, not a second canary.
  assert.equal(breaker.claimHalfOpenCanary(winners[0]), true);
  assert.equal(breaker.claimHalfOpenCanary("worker-9"), false);

  // A successful canary closes the circuit for everyone.
  breaker.close();
  assert.equal(breaker.state(), CIRCUIT_STATE.CLOSED);
  assert.equal(breaker.verdict("worker-9").allowed, true);
});

test("R02 policy — a transient failure never opens a circuit, and a permanent one always does", () => {
  const transient = classifyProviderFailure({ provider: "openrouter", status: 503, nowMs: NOW_MS });
  const throttled = classifyProviderFailure({ provider: "openrouter", status: 429, headers: { "retry-after": "5" }, nowMs: NOW_MS });
  const challenged = classifyProviderFailure({
    provider: "brightdata",
    status: 403,
    body: { error: { code: "captcha_required" } },
    nowMs: NOW_MS,
  });

  for (const classification of [transient, throttled, challenged]) {
    const breaker = createCircuitBreaker({ provider: classification.provider, account: "acct-1" });
    const action = breaker.record(classification);
    assert.equal(action.action, "none", `${classification.kind} must not stop dependent engines`);
    assert.equal(breaker.state(), CIRCUIT_STATE.CLOSED);
  }

  for (const kind of [PROVIDER_FAILURE.AUTHENTICATION, PROVIDER_FAILURE.PERMISSION, PROVIDER_FAILURE.SPEND_LIMIT]) {
    const breaker = createCircuitBreaker({ provider: "openrouter", account: "acct-1" });
    const action = breaker.record({ kind, message: "fixture" });
    assert.equal(action.action, "open");
    assert.equal(breaker.state(), CIRCUIT_STATE.OPEN);
    assert.equal(action.kind, kind);
    assert.match(action.reason, /openrouter/, "the reason names the provider");
    assert.match(action.reason, /acct-1/, "and the account it applies to");
    assert.equal(action.key, "openrouter::acct-1");
  }

  // The identity is provider + ACCOUNT, not the model-carrying config version:
  // a revoked shared key must stop every engine that routes through it, and a
  // rotation must get a circuit of its own rather than inheriting the dead one.
  const shared = createCircuitBreaker({ provider: "openrouter", account: "acct-1" });
  const rotated = createCircuitBreaker({ provider: "openrouter", account: "acct-2" });
  shared.record({ kind: PROVIDER_FAILURE.AUTHENTICATION });
  assert.equal(shared.state(), CIRCUIT_STATE.OPEN);
  assert.equal(rotated.state(), CIRCUIT_STATE.CLOSED, "a different credential is not blocked by the old circuit");
});

test("R02 policy — reservations stay inside the cap, and a refusal is recorded before any network call", async () => {
  // R02-20 is a D-level case (a real concurrent race against a durable ledger)
  // and is registered BLOCKED in r01-r02-blocked.test.mjs. The name above does
  // not carry its id on purpose: passing this offline half is not passing the
  // durable case, and a test named for it would report exactly that false pass.
  // What is provable offline is the part a caller can get wrong: the cap arithmetic,
  // the record of every refusal, and the ordering of the check against the call.
  const clock = clockAt();
  const ledger = createSpendLedger({ capUsd: 1.0, now: clock.now });

  assert.equal(ledger.reserve({ id: "pair-1", amountUsd: 0.6 }).authorized, true);
  const exactlyAtCap = ledger.reserve({ id: "pair-2", amountUsd: 0.4 });
  assert.equal(exactlyAtCap.authorized, true, "a reservation that lands exactly on the cap is still within it");
  assert.equal(exactlyAtCap.remaining_usd, 0);

  const refused = ledger.reserve({ id: "pair-3", amountUsd: 0.01 });
  assert.equal(refused.authorized, false);
  assert.equal(refused.reason, DISPATCH_REFUSAL.SPEND_RESERVED);
  assert.equal(refused.record.requested_usd, 0.01);
  assert.equal(ledger.state().committed_usd, 1.0);
  assert.ok(ledger.state().committed_usd <= ledger.cap_usd, "authorized reservations never exceed the cap");
  assert.equal(ledger.state().refusals.length, 1, "the refusal is recorded, not merely returned");

  // An unknown charge stays unknown and keeps its reservation.
  const unknown = ledger.settle({ id: "pair-2", costUsd: null });
  assert.equal(unknown.cost_usd, null);
  assert.equal(unknown.cost_state, "unknown_billed");
  assert.equal(ledger.state().committed_usd, 1.0);

  // A measured charge replaces the estimate, freeing the difference.
  ledger.settle({ id: "pair-1", costUsd: 0.2 });
  assert.equal(ledger.state().committed_usd, 0.6);
  assert.equal(ledger.reserve({ id: "pair-4", amountUsd: 0.3 }).authorized, true);

  // Settling an id that was never reserved is a failure, not a silent no-op.
  assert.throws(() => ledger.settle({ id: "pair-none", costUsd: 1 }), /no reservation/);

  // The ordering: the gate's refusal is recorded and the caller's request is
  // never made. `probe` is the only thing that could reach a provider.
  const probe = countingProbe();
  const gate = createDispatchGate({ now: clock.now, spendLedger: ledger });
  const verdict = gate.authorizeDispatch({
    provider: "brightdata",
    configVersion: "cfg-aio",
    owner: "worker-1",
    reservation: { id: "pair-5", amountUsd: 0.9 },
  });

  assert.equal(verdict.allowed, false);
  assert.equal(verdict.refusal.kind, DISPATCH_REFUSAL.SPEND_RESERVED);
  assert.match(verdict.reason, /brightdata/);
  assert.match(verdict.reason, /cap/);
  assert.equal(probe.calls, 0, "a refused reservation must not be followed by a request");
  assert.equal(ledger.state().refusals.at(-1).id, "pair-5", "the refusal is already on the record");

  // A reservation that fits is authorised and the request may proceed. It has to
  // fit against what is still COMMITTED — 0.2 (settled pair-1) + 0.4 (pair-2,
  // charge unknown so its estimate stands) + 0.3 (pair-4) = 0.9 of the 1.0 cap —
  // so the amount that lands exactly on the cap is 0.10, not 0.20.
  const ok = gate.authorizeDispatch({
    provider: "brightdata",
    configVersion: "cfg-aio",
    owner: "worker-1",
    reservation: { id: "pair-6", amountUsd: 0.1 },
  });
  assert.equal(ok.allowed, true);
  assert.equal(ok.reservation.reserved_usd, 0.1);
  assert.equal(ok.reservation.remaining_usd, 0);
  if (ok.allowed) await probe();
  assert.equal(probe.calls, 1);
});

test("R02-17 — a gate refuses rather than dispatching when it is asked about an unnamed provider", () => {
  const gate = createDispatchGate();
  assert.throws(() => gate.authorizeDispatch({ provider: null }), /provider is required/);
  assert.throws(() => createCircuitBreaker({}), /provider is required/);
});
