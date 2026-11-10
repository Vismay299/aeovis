import test from "node:test";
import assert from "node:assert/strict";
import { dispatchCanaries } from "./providerCanary.js";
import { readProviderReadiness } from "../db/probeDispatch.js";
import {
  READINESS,
  planEngineCanary,
  readinessForEngine,
  validateEngineConfig,
} from "../engines/providerReadiness.js";

function createMockCanaryStore() {
  const observations = [];
  const claims = [];
  const finished = [];

  return {
    observations,
    claims,
    canaries: async () => {
      const byEngine = {};
      for (const f of finished) {
        const obs = observations.find((o) => o.id === f.id);
        byEngine[f.engine] = {
          config_version: obs?.config_version,
          observed_at: f.finished_at,
          outcome: ["answered", "valid_no_aio"].includes(f.state) ? "valid" : f.state,
          failure: f.failure,
        };
      }
      return byEngine;
    },
    circuits: async () => [],
    seed: async (rows) => {
      observations.push(...rows);
    },
    claim: async (id, budget) => {
      claims.push({ id, budget });
      return {
        granted: true,
        lease_token: `token-${id}`,
        attempt_no: 1,
      };
    },
    finish: async (id, token, result, decision) => {
      finished.push({
        id,
        engine: result.engine,
        state: decision.state,
        failure: decision.failure,
        finished_at: new Date().toISOString(),
      });
      return { accepted: true };
    },
  };
}

test("F02-AC-24: approved DataForSEO canaries run and Perplexity is blocked before dispatch", async () => {
  const env = {
    FEATURE_DATAFORSEO_ENGINES: "on",
    DATAFORSEO_API_KEY: "test-dfs-key",
    ANSWER_ENGINE_ROUTES: "chatgpt=dataforseo;aio=dataforseo;perplexity=dataforseo",
  };
  const store = createMockCanaryStore();
  const enginesCalled = [];

  const mockRegistry = [
    {
      name: "chatgpt",
      probe: async (_q, _b, _a, _d, _c, _s, opts) => {
        enginesCalled.push({ engine: "chatgpt", opts });
        return {
          engine: "chatgpt",
          answer_present: true,
          answer_text: "Accounting software should be easy to use and accurate.",
          cost: 0.004,
          gateway: "dataforseo",
          measurement_method: "consumer_capture",
          valid: true,
        };
      },
    },
    {
      name: "aio",
      probe: async (_q, _b, _a, _d, _c, _s, opts) => {
        enginesCalled.push({ engine: "aio", opts });
        return {
          engine: "aio",
          answer_present: true,
          answer_text: "Consider features, pricing, and scalability.",
          cost: 0.004,
          gateway: "dataforseo",
          valid: true,
        };
      },
    },
    {
      name: "perplexity",
      probe: async (_q, _b, _a, _d, _c, _s, opts) => {
        enginesCalled.push({ engine: "perplexity", opts });
        return {
          engine: "perplexity",
          answer_present: true,
          answer_text: "Cloud integration, payroll, and invoice tracking.",
          cost: 0.04,
          gateway: "dataforseo",
          valid: true,
        };
      },
    },
  ];

  const outcomes = await dispatchCanaries({
    engines: ["chatgpt", "aio", "perplexity"],
    slot: "dfs-canary-test-slot",
    maxRequests: 10,
    maxSpendUsd: 1,
    reserveUsd: 0.2,
    store,
    registry: mockRegistry,
    env,
    route: "dataforseo",
  });

  // Approved engines dispatch; the Perplexity DataForSEO route is refused before claim.
  assert.equal(outcomes.length, 3);
  assert.equal(outcomes.find((outcome) => outcome.engine === "chatgpt").state, "answered");
  assert.equal(outcomes.find((outcome) => outcome.engine === "aio").state, "answered");
  assert.equal(outcomes.find((outcome) => outcome.engine === "perplexity").state, "blocked");
  assert.equal(outcomes.find((outcome) => outcome.engine === "perplexity").reason, "engine_not_approved");

  // Request units are one per approved DataForSEO route.
  assert.equal(store.observations.length, 2);
  for (const obs of store.observations) {
    assert.equal(obs.context.request_units, 1, `Engine ${obs.engine} should use 1 request unit on dataforseo`);
  }

  // Only approved engines receive the DataForSEO route.
  assert.equal(enginesCalled.length, 2);
  for (const call of enginesCalled) {
    assert.equal(call.opts.route, "dataforseo");
  }
  assert.equal(enginesCalled.some((call) => call.engine === "perplexity"), false);

  // Check readProviderReadiness reflects readiness from canaries
  const readiness = await readProviderReadiness({ store, env });
  assert.equal(readiness.engines.chatgpt.readiness, "ready");
  assert.equal(readiness.engines.aio.readiness, "ready");
  assert.equal(readiness.engines.perplexity.readiness, READINESS.BLOCKED);
  assert.equal(readiness.engines.perplexity.reason, "engine_not_approved");
});

test("F02-AC-24: dispatchCanaries picks an approved dataforseo route from routeOrder", async () => {
  const env = {
    FEATURE_DATAFORSEO_ENGINES: "on",
    DATAFORSEO_API_KEY: "test-dfs-key",
    ANSWER_ENGINE_ROUTES: "chatgpt=dataforseo",
  };
  const store = createMockCanaryStore();
  let probeOpts = null;

  const mockRegistry = [
    {
      name: "chatgpt",
      probe: async (_q, _b, _a, _d, _c, _s, opts) => {
        probeOpts = opts;
        return {
          engine: "chatgpt",
          answer_present: true,
          cost: 0.04,
          gateway: "dataforseo",
          valid: true,
        };
      },
    },
  ];

  const outcomes = await dispatchCanaries({
    engines: ["chatgpt"],
    slot: "dfs-canary-env-slot",
    maxRequests: 5,
    maxSpendUsd: 1,
    reserveUsd: 0.2,
    store,
    registry: mockRegistry,
    env,
  });

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].state, "answered");
  assert.equal(store.observations[0].context.request_units, 1);
  assert.equal(probeOpts.route, "dataforseo");
});

test("DataForSEO configuration, canary plan, and readiness enforce feature and engine gates", () => {
  const allowedEnv = {
    FEATURE_DATAFORSEO_ENGINES: "on",
    DATAFORSEO_API_KEY: "test-dfs-key",
  };
  const perplexityRoute = { route: "dataforseo" };

  assert.equal(validateEngineConfig("perplexity", allowedEnv, perplexityRoute).reason, "engine_not_approved");
  assert.equal(planEngineCanary("perplexity", allowedEnv, perplexityRoute).dispatch, false);
  const blockedPerplexity = readinessForEngine({
    engine: "perplexity",
    env: allowedEnv,
    opts: perplexityRoute,
    now: new Date().toISOString(),
    canary: {
      config_version: planEngineCanary("perplexity", allowedEnv, perplexityRoute).config_version,
      outcome: "valid",
      observed_at: new Date().toISOString(),
    },
  });
  assert.equal(blockedPerplexity.readiness, READINESS.BLOCKED);
  assert.equal(blockedPerplexity.reason, "engine_not_approved");

  const approvedPlan = planEngineCanary("chatgpt", allowedEnv, perplexityRoute);
  assert.equal(validateEngineConfig("chatgpt", allowedEnv, perplexityRoute).ok, true);
  assert.equal(approvedPlan.dispatch, true);
  const readyChatgpt = readinessForEngine({
    engine: "chatgpt",
    env: allowedEnv,
    opts: perplexityRoute,
    now: "2026-11-10T12:00:00.000Z",
    canary: {
      config_version: approvedPlan.config_version,
      outcome: "valid",
      observed_at: "2026-11-10T11:59:00.000Z",
    },
  });
  assert.equal(readyChatgpt.readiness, READINESS.READY);

  const disabledEnv = { ...allowedEnv, FEATURE_DATAFORSEO_ENGINES: "off" };
  assert.equal(validateEngineConfig("chatgpt", disabledEnv, perplexityRoute).reason, "feature_disabled");
  assert.equal(planEngineCanary("chatgpt", disabledEnv, perplexityRoute).dispatch, false);
  assert.equal(
    readinessForEngine({
      engine: "chatgpt",
      env: disabledEnv,
      opts: perplexityRoute,
      now: new Date().toISOString(),
    }).readiness,
    READINESS.BLOCKED,
  );
});
