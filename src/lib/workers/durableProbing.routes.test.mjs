import test from "node:test";
import assert from "node:assert/strict";
import {
  dispatchBudget,
  freezeDispatch,
  runDurableProbing,
} from "./durableProbing.js";
import {
  dispatchIdentity,
  hashIdentity,
  DISPATCH_VERSION,
} from "../db/probeDispatch.js";
import { circuitIdentity } from "../engines/providerReadiness.js";

function createMockStore({ circuits = [], claimHandler } = {}) {
  const rows = [];
  const blocked = [];
  const claims = [];
  const posted = [];
  const collected = [];
  const renewals = [];
  const finishes = [];

  return {
    rows,
    blocked,
    claims,
    posted,
    collected,
    renewals,
    finishes,
    circuits: async () => circuits,
    seed: async (values) => {
      rows.push(...values.map((r) => ({ ...r, state: "pending", attempt_count: 0 })));
    },
    claim: async (id, budget) => {
      claims.push({ id, budget: { ...budget } });
      if (claimHandler) return claimHandler(id, budget);
      const row = rows.find((item) => item.id === id);
      if (row) {
        row.state = "leased";
        row.attempt_count += 1;
        row.lease_token = `token-${id}`;
        row.attempt = { lease_token: row.lease_token, attempt_no: row.attempt_count, dispatch_state: "intent" };
      }
      return {
        granted: true,
        lease_token: `token-${id}`,
        attempt_no: row?.attempt_count || 1,
      };
    },
    renew: async (id, token, seconds) => {
      renewals.push({ id, token, seconds });
      return { accepted: true };
    },
    finish: async (id, token, result, decision) => {
      finishes.push({ id, token, result, decision });
      const row = rows.find((item) => item.id === id);
      if (row) row.state = decision.state;
      return { accepted: true };
    },
    post: async (id, token, taskId, cost, nextAt, collectUntil) => {
      const row = rows.find((item) => item.id === id);
      if (row) {
        row.state = "posted";
        row.next_attempt_at = nextAt;
        row.attempt = {
          ...row.attempt,
          dispatch_state: "posted",
          provider_task_id: taskId,
          posted_at: new Date().toISOString(),
          collect_until: collectUntil,
          charged_usd: cost,
        };
      }
      posted.push({ id, token, taskId, cost, nextAt, collectUntil });
      return { accepted: true };
    },
    collect: async (id, token, result, state, failure, nextAt, settledCost) => {
      const row = rows.find((item) => item.id === id);
      if (row) row.state = state;
      collected.push({ id, token, result, state, failure, nextAt, settledCost });
      return { accepted: true };
    },
    reschedule: async (id, token, nextAt) => {
      const row = rows.find((item) => item.id === id);
      if (row) row.next_attempt_at = nextAt;
      return true;
    },
    listPosted: async (jobId) => rows.filter((row) => row.job_id === jobId && row.state === "posted"),
    block: async (id, reason) => {
      blocked.push({ id, reason });
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.state = "blocked";
        row.reason = reason;
      }
    },
    list: async () => rows,
  };
}

test("P3.T3.S1 Case 1: checkpoint without routes behaves exactly as before (snapshot of claim calls)", async () => {
  const env = {
    OPENAI_API_KEY: "sk-openai-test",
    SCAN_PROBE_RESERVATION_USD: "1",
    SCAN_MAX_COST_PER_SCAN: "5",
  };
  const queries = [{ text: "Query 1?" }];
  const checkpoint = {
    brand: "Acme",
    url: "https://acme.example",
    engines: ["chatgpt"],
    queries,
    stats: { cost: 0 },
    dispatch: freezeDispatch({ engines: ["chatgpt"], env }),
  };
  // Ensure checkpoint has dispatch, but NO routes field
  assert.equal(checkpoint.dispatch.routes, undefined);

  let probeOpts = null;
  const store = createMockStore();
  const engines = [
    {
      name: "chatgpt",
      probe: async (_q, _b, _a, _d, _c, _s, opts) => {
        probeOpts = opts;
        return {
          engine: "chatgpt",
          answer_present: true,
          answer_text: "Answer text",
          cost: 0.002,
        };
      },
    },
  ];

  await runDurableProbing({
    jobId: "job-legacy-1",
    checkpoint,
    engines,
    store,
    getResults: async () => [],
    updateJob: async () => {},
    now: () => 1000000,
    chunkStartMs: 1000000,
    budgetMs: 120000,
    env,
  });

  // Verify claim calls snapshot: exactly budget without extra leaseSeconds
  assert.equal(store.claims.length, 1);
  assert.deepEqual(store.claims[0].budget, {
    reserve: 1,
    scanCap: 5,
    dayCap: null,
  });
  // Verify probe options had no route or model
  assert.equal(probeOpts.route, undefined);
  assert.equal(probeOpts.model, undefined);
});

test("P3.T3.S1 Case 2: frozen route reused across chunks", async () => {
  const env1 = {
    ANSWER_ENGINE_ROUTES: "chatgpt=openrouter",
    LLM_API_KEY: "openrouter-key",
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
  };
  const queries = [{ text: "Q1?" }, { text: "Q2?" }];
  const store1 = createMockStore();
  let probeRoutes = [];

  const engines = [
    {
      name: "chatgpt",
      probe: async (_q, _b, _a, _d, _c, _s, opts) => {
        probeRoutes.push(opts.route);
        return {
          engine: "chatgpt",
          answer_present: true,
          cost: 0.002,
        };
      },
    },
  ];

  // Chunk 1 freezes routes
  const outcome1 = await runDurableProbing({
    jobId: "job-chunks-1",
    checkpoint: {
      brand: "Acme",
      url: "https://acme.example",
      engines: ["chatgpt"],
      queries,
    },
    engines,
    store: store1,
    getResults: async () => [],
    updateJob: async () => {},
    now: () => 1000000,
    chunkStartMs: 1000000,
    budgetMs: 120000,
    env: env1,
  });

  assert.equal(outcome1.checkpoint.dispatch.routes.chatgpt.route, "openrouter");
  assert.equal(probeRoutes[0], "openrouter");

  // Chunk 2: environment changes or circuit opens for openrouter, but frozen route must be reused
  const env2 = {
    ANSWER_ENGINE_ROUTES: "chatgpt=vendor_api",
    OPENAI_API_KEY: "sk-openai-key",
  };
  const store2 = createMockStore();
  probeRoutes = [];

  const outcome2 = await runDurableProbing({
    jobId: "job-chunks-1",
    checkpoint: outcome1.checkpoint,
    engines,
    store: store2,
    getResults: async () => [
      { engine: "chatgpt", query: "Q1?", raw: { answer_present: true, cost: 0.002 } },
    ],
    updateJob: async () => {},
    now: () => 1000000,
    chunkStartMs: 1000000,
    budgetMs: 120000,
    env: env2,
  });

  assert.equal(outcome2.checkpoint.dispatch.routes.chatgpt.route, "openrouter");
});

test("P3.T3.S1 Case 3: circuit open at freeze -> fallback frozen with fallbackFrom", async () => {
  const env = {
    ANSWER_ENGINE_ROUTES: "chatgpt=vendor_api>openrouter",
    OPENAI_API_KEY: "sk-openai-key",
    LLM_API_KEY: "openrouter-key",
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
  };
  const vendorCircuitKey = hashIdentity(circuitIdentity("chatgpt", env, { route: "vendor_api" }));
  const store = createMockStore({
    circuits: [
      {
        circuit_key: vendorCircuitKey,
        open_until: new Date(Date.now() + 3600000).toISOString(),
      },
    ],
  });

  let savedCheckpoint = null;
  await runDurableProbing({
    jobId: "job-fallback-1",
    checkpoint: {
      brand: "Acme",
      url: "https://acme.example",
      engines: ["chatgpt"],
      queries: [{ text: "Q1?" }],
    },
    engines: [
      {
        name: "chatgpt",
        probe: async () => ({ engine: "chatgpt", answer_present: true }),
      },
    ],
    store,
    getResults: async () => [],
    updateJob: async (_id, update) => {
      savedCheckpoint = update.checkpoint;
    },
    now: () => 1000000,
    chunkStartMs: 1000000,
    budgetMs: 120000,
    env,
  });

  assert.ok(savedCheckpoint?.dispatch?.routes?.chatgpt);
  assert.equal(savedCheckpoint.dispatch.routes.chatgpt.route, "openrouter");
  assert.equal(savedCheckpoint.dispatch.routes.chatgpt.fallbackFrom, "vendor_api");
});

test("P3.T3.S1 Case 4: circuit opening mid-scan -> remaining rows of that engine blocked, no switch", async () => {
  const env = {
    ANSWER_ENGINE_ROUTES: "chatgpt=vendor_api>openrouter",
    OPENAI_API_KEY: "sk-openai-key",
    LLM_API_KEY: "openrouter-key",
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
    OPENROUTER_CHATGPT_MODEL: "openai/gpt-4o-mini",
  };
  let claimCount = 0;
  const store = createMockStore({
    claimHandler: async () => {
      claimCount++;
      if (claimCount > 1) {
        return { granted: false, reason: "provider_circuit_open" };
      }
      return { granted: true, lease_token: "tok-1", attempt_no: 1 };
    },
  });

  let savedCheckpoint = null;
  const outcome = await runDurableProbing({
    jobId: "job-midscan-1",
    checkpoint: {
      brand: "Acme",
      url: "https://acme.example",
      engines: ["chatgpt"],
      queries: [{ text: "Q1?" }, { text: "Q2?" }],
    },
    engines: [
      {
        name: "chatgpt",
        probe: async () => ({ engine: "chatgpt", answer_present: true }),
      },
    ],
    store,
    getResults: async () => [],
    updateJob: async (_id, update) => {
      savedCheckpoint = update.checkpoint;
    },
    now: () => 1000000,
    chunkStartMs: 1000000,
    budgetMs: 120000,
    env,
  });

  // Second row blocked by provider_circuit_open; route did NOT switch to openrouter
  assert.equal(outcome.checkpoint.dispatch.routes.chatgpt.route, "vendor_api");
  assert.equal(outcome.checkpoint.blocked?.reason, "provider_circuit_open");
});

// Deferred to phase 4 (owner decision, 2026-11-11). Every approved DataForSEO
// engine (aio, chatgpt, gemini) is a queued mode that phase 3 refuses for
// scans, and perplexity, the only live mode, is not approved. No approved
// engine can reach the live lease path until P4.T2.S2 makes queued engines
// scan-capable; re-enable these two cases there with an approved engine.
const DEFERRED_TO_PHASE_4 =
  "deferred to F02 phase 4: no approved DataForSEO engine is live-scan capable in phase 3";

test("P3.T3.S1 Case 5: dataforseo live claim uses lease 180 and deadline 140 s", { skip: DEFERRED_TO_PHASE_4 }, async () => {
  const env = {
    FEATURE_DATAFORSEO_ENGINES: "on",
    DATAFORSEO_API_KEY: "test-dfs-key",
    ANSWER_ENGINE_ROUTES: "perplexity=dataforseo",
  };
  const store = createMockStore();
  let probeDeadlineAt = null;

  await runDurableProbing({
    jobId: "job-dfs-live-1",
    checkpoint: {
      brand: "Acme",
      url: "https://acme.example",
      engines: ["perplexity"],
      queries: [{ text: "Q1?" }],
    },
    engines: [
      {
        name: "perplexity",
        probe: async (_q, _b, _a, _d, _c, _s, opts) => {
          probeDeadlineAt = opts.deadlineAt;
          return { engine: "perplexity", answer_present: true, gateway: "dataforseo" };
        },
      },
    ],
    store,
    getResults: async () => [],
    updateJob: async () => {},
    now: () => 1000000,
    chunkStartMs: 1000000,
    budgetMs: 200000,
    env,
  });

  assert.equal(store.claims.length, 1);
  assert.equal(store.claims[0].budget.leaseSeconds, 180);
  assert.equal(probeDeadlineAt, 1000000 + 100000);
});

test("P3.T3.S1 Case 6: renewal every 60 s (fake timers)", { skip: DEFERRED_TO_PHASE_4 }, async () => {
  const env = {
    FEATURE_DATAFORSEO_ENGINES: "on",
    DATAFORSEO_API_KEY: "test-dfs-key",
    ANSWER_ENGINE_ROUTES: "perplexity=dataforseo",
  };
  const store = createMockStore();

  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const callbacks = [];

  globalThis.setInterval = (cb, ms) => {
    callbacks.push({ cb, ms });
    return 123;
  };
  let cleared = false;
  globalThis.clearInterval = () => {
    cleared = true;
  };

  try {
    await runDurableProbing({
      jobId: "job-dfs-renew-1",
      checkpoint: {
        brand: "Acme",
        url: "https://acme.example",
        engines: ["perplexity"],
        queries: [{ text: "Q1?" }],
      },
      engines: [
        {
          name: "perplexity",
          probe: async () => {
            // Trigger interval twice
            for (const item of callbacks) {
              await item.cb();
              await item.cb();
            }
            return { engine: "perplexity", answer_present: true, gateway: "dataforseo" };
          },
        },
      ],
      store,
      getResults: async () => [],
      updateJob: async () => {},
      now: () => 1000000,
      chunkStartMs: 1000000,
      budgetMs: 200000,
      env,
    });
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }

  assert.ok(store.renewals.length >= 2);
  assert.equal(store.renewals[0].seconds, 180);
  assert.equal(cleared, true);
});

test("P3.T3.S1 Case 7: lane stops new claims after an opens_circuit result", async () => {
  const env = {
    OPENAI_API_KEY: "sk-test",
    ANSWER_ENGINE_ROUTES: "chatgpt=vendor_api",
  };
  const store = createMockStore();
  let probeAttempts = 0;

  await runDurableProbing({
    jobId: "job-lane-circuit-1",
    checkpoint: {
      brand: "Acme",
      url: "https://acme.example",
      engines: ["chatgpt"],
      queries: [{ text: "Q1?" }, { text: "Q2?" }, { text: "Q3?" }],
    },
    engines: [
      {
        name: "chatgpt",
        probe: async () => {
          probeAttempts++;
          return {
            engine: "chatgpt",
            error: "Spend limit exceeded",
            provider_failure: {
              kind: "spend_limit",
              opens_circuit: true,
              message: "Account out of funds",
            },
          };
        },
      },
    ],
    store,
    getResults: async () => [],
    updateJob: async () => {},
    now: () => 1000000,
    chunkStartMs: 1000000,
    budgetMs: 120000,
    env,
  });

  // Only the first claim/probe ran; remaining 2 queries were stopped
  assert.equal(probeAttempts, 1);
  assert.equal(store.claims.length, 1);
});

test("P4.T2.S2: approved DataForSEO scraper routes enter the queued lane", async () => {
  const env = {
    FEATURE_DATAFORSEO_ENGINES: "on",
    DATAFORSEO_API_KEY: "test-dfs-key",
    ANSWER_ENGINE_ROUTES: "chatgpt=dataforseo",
  };
  const store = createMockStore();
  let probed = false;

  const routes = {
    chatgpt: { route: "dataforseo", model: null, fallbackFrom: null },
  };
  const checkpoint = {
    brand: "Acme",
    url: "https://acme.example",
    engines: ["chatgpt"],
    queries: [{ text: "Q1?" }],
    dispatch: freezeDispatch({ engines: ["chatgpt"], env, routes, now: () => 1000000 }),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const tasks = JSON.parse(String(init.body)).map((entry) => ({
      id: `task-${entry.tag}`,
      status_code: 20100,
      cost: 0.0012,
      data: { tag: entry.tag },
    }));
    return new Response(JSON.stringify({ status_code: 20000, tasks }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  let outcome;
  try {
    outcome = await runDurableProbing({
    jobId: "job-dfs-scraper-1",
    checkpoint,
    engines: [
      {
        name: "chatgpt",
        probe: async () => {
          probed = true;
          return { engine: "chatgpt", answer_present: true };
        },
      },
    ],
    store,
    getResults: async () => [],
    updateJob: async () => {},
    now: () => 1000000,
    chunkStartMs: 1000000,
    budgetMs: 200000,
    env,
  });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(probed, false);
  assert.equal(store.claims.length, 1);
  assert.equal(store.claims[0].budget.leaseSeconds, 120);
  assert.equal(store.posted.length, 1);
  assert.equal(outcome.budgetHit, true);
  assert.equal(outcome.resumeAt, new Date(1000000 + 120000).toISOString());
});

test("F02-AC-29: a queued scan resumes at the earliest posted poll", async () => {
  const nowMs = 1000000;
  const env = {
    FEATURE_DATAFORSEO_ENGINES: "on",
    DATAFORSEO_API_KEY: "test-dfs-key",
    ANSWER_ENGINE_ROUTES: "chatgpt=dataforseo",
  };
  const store = createMockStore();
  const seed = store.seed;
  store.seed = async (values) => {
    await seed(values);
    for (const [index, row] of store.rows.entries()) {
      const nextAt = nowMs + (index === 0 ? 240_000 : 120_000);
      row.state = "posted";
      row.next_attempt_at = new Date(nextAt).toISOString();
      row.lease_token = `posted-${index}`;
      row.attempt = {
        lease_token: row.lease_token,
        attempt_no: 1,
        dispatch_state: "posted",
        provider_task_id: `task-${index}`,
        posted_at: new Date(nowMs - 60_000).toISOString(),
        charged_usd: 0.0012,
      };
    }
  };
  const routes = {
    chatgpt: { route: "dataforseo", model: null, fallbackFrom: null },
  };
  const outcome = await runDurableProbing({
    jobId: "job-posted-resume",
    checkpoint: {
      brand: "Acme",
      url: "https://acme.example",
      engines: ["chatgpt"],
      queries: [{ text: "Q1?" }, { text: "Q2?" }],
      dispatch: freezeDispatch({ engines: ["chatgpt"], env, routes, now: () => nowMs }),
    },
    engines: [{ name: "chatgpt", probe: async () => { throw new Error("queued route must not call live probe"); } }],
    store,
    getResults: async () => [],
    updateJob: async () => {},
    now: () => nowMs,
    chunkStartMs: nowMs,
    budgetMs: 200_000,
    env,
  });

  assert.equal(outcome.budgetHit, true);
  assert.equal(outcome.resumeAt, new Date(nowMs + 120_000).toISOString());
  assert.equal(store.claims.length, 0);
});
