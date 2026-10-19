import test from "node:test";
import assert from "node:assert/strict";
import {
  createProbeDispatchStore,
  hashIdentity,
  dispatchIdentity,
  resultDecision,
  readProviderReadiness,
} from "../db/probeDispatch.js";
import {
  dispatchBudget,
  freezeDispatch,
  runDurableProbing,
} from "../workers/durableProbing.js";
import {
  probeTextEngine,
  summarizeEngineSlice,
  computeHeadline,
} from "../scoring/enginePipeline.js";
import { probeOpenRouterEngine } from "../engines/openRouterProbe.js";
import { probeChatGpt } from "../engines/openai.js";
import { probePerplexity } from "../engines/perplexity.js";
import { dispatchCanaries } from "../../../scripts/ops/provider-canary.mjs";

const fake = "EXAMPLE-NOT-A-REAL-CREDENTIAL";
async function withEnv(env, fn) {
  const keys = [
    "LLM_API_KEY",
    "LLM_BASE_URL",
    "OPENAI_API_KEY",
    "PERPLEXITY_API_KEY",
    "OPENROUTER_OPENAI_MODEL",
    "OPENAI_MODEL",
    ...Object.keys(env),
  ];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  const fetch = global.fetch;
  try {
    for (const k of keys) delete process.env[k];
    Object.assign(process.env, env);
    return await fn();
  } finally {
    global.fetch = fetch;
    for (const k of keys) {
      if (before[k] === undefined) delete process.env[k];
      else process.env[k] = before[k];
    }
  }
}

test("P0 durable OpenRouter attempt makes one request and carries provider Retry-After", async () => {
  await withEnv(
    { LLM_API_KEY: fake, LLM_BASE_URL: "https://openrouter.ai/api/v1" },
    async () => {
      let calls = 0;
      global.fetch = async () => {
        calls++;
        return new Response(
          JSON.stringify({ error: { code: "rate_limit_exceeded" } }),
          { status: 429, headers: { "Retry-After": "120" } },
        );
      };
      const r = await probeOpenRouterEngine({
        engine: "chatgpt",
        query: "Fixture",
        durableDispatch: true,
      });
      assert.equal(calls, 1);
      assert.equal(r.provider_failure.kind, "rate_limit");
      assert.equal(r.provider_failure.retry_after_ms, 120_000);
      const p = await probeTextEngine(
        { name: "chatgpt", probe: async () => r },
        { text: "Fixture" },
        "Acme",
        ["Acme"],
        "acme.example",
        [],
        {},
      );
      assert.equal(p.provider_failure.retry_after_ms, 120_000);
      const decision = resultDecision(p, 1, Date.now() + 60_000);
      assert.equal(decision.state, "failed");
      assert.equal(p.cost, null);
    },
  );
});

test("P0 each native adapter disables nested retries under durable dispatch", async () => {
  for (const engine of ["chatgpt", "perplexity"])
    await withEnv(
      engine === "chatgpt"
        ? { OPENAI_API_KEY: fake }
        : { PERPLEXITY_API_KEY: fake },
      async () => {
        let calls = 0;
        global.fetch = async () => {
          calls++;
          return new Response("Upstream unavailable", { status: 503 });
        };
        const r = await (engine === "chatgpt" ? probeChatGpt : probePerplexity)(
          "Fixture",
          { durableDispatch: true },
        );
        assert.equal(calls, engine === "chatgpt" ? 1 : 2);
        assert.equal(r.provider_failure.kind, "transient");
      },
    );
});

test("P0 whole-body deadline stays active for native responses", async () => {
  for (const engine of ["chatgpt", "perplexity"])
    await withEnv(
      engine === "chatgpt"
        ? { OPENAI_API_KEY: fake }
        : { PERPLEXITY_API_KEY: fake },
      async () => {
        global.fetch = async (_url, { signal }) => ({
          ok: true,
          json: () =>
            new Promise((_, reject) =>
              signal.addEventListener(
                "abort",
                () =>
                  reject(
                    Object.assign(new Error("timed out"), {
                      name: "AbortError",
                    }),
                  ),
                { once: true },
              ),
            ),
        });
        const start = Date.now();
        const r = await (engine === "chatgpt" ? probeChatGpt : probePerplexity)(
          "Fixture",
          { durableDispatch: true, deadlineAt: Date.now() + 40 },
        );
        assert.ok(Date.now() - start < 1500);
        assert.ok(r.error);
        assert.equal(r.provider_failure.kind, "timeout");
      },
    );
});

test("P0 valid no-AIO is terminal and cannot trigger retry spend", () => {
  assert.equal(
    resultDecision(
      {
        engine: "aio",
        serp_state: "valid_serp",
        aio_present: false,
        answer_present: false,
      },
      1,
      Date.now() + 10000,
    ).state,
    "valid_no_aio",
  );
  assert.equal(
    resultDecision(
      { engine: "aio", serp_state: null, answer_present: false },
      1,
      Date.now() + 10000,
    ).state,
    "retry",
  );
});

test("P0 dispatch budgets fail closed on malformed and zero reservations", () => {
  for (const env of [
    { SCAN_MAX_COST_PER_SCAN: "NaN" },
    { SCAN_PROBE_RESERVATION_USD: "0" },
    { SCAN_MAX_COST_PER_DAY: "-1" },
  ])
    assert.throws(() => dispatchBudget(env));
  assert.deepEqual(dispatchBudget({ SCAN_MAX_COST_PER_SCAN: "0" }), {
    reserve: 1,
    scanCap: 0,
    dayCap: null,
  });
});

test("P0 shared credential engines share a circuit while configuration rotates independently", () => {
  const env = {
    LLM_API_KEY: fake,
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
  };
  const a = dispatchIdentity("chatgpt", env),
    b = dispatchIdentity("gemini", env);
  assert.equal(a.circuit_key, b.circuit_key);
  assert.notEqual(a.config_version, b.config_version);
  assert.notEqual(
    a.circuit_key,
    dispatchIdentity("chatgpt", {
      ...env,
      LLM_API_KEY: "EXAMPLE-NOT-A-REAL-ROTATED-CREDENTIAL",
    }).circuit_key,
  );
});

test("R01-12 runtime health reads durable canaries without dispatch", async () => {
  let reads = 0;
  const env = {
    LLM_API_KEY: fake,
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
  };
  const now = new Date().toISOString();
  const store = {
    canaries: async () => {
      reads++;
      return {
        chatgpt: {
          config_version: dispatchIdentity("chatgpt", env).config_version,
          observed_at: now,
          outcome: "valid",
        },
      };
    },
  };
  for (let i = 0; i < 100; i++) {
    const report = await readProviderReadiness({ store, env, now });
    assert.equal(report.engines.chatgpt.readiness, "ready");
    assert.equal(report.provider_requests, 0);
  }
  assert.equal(reads, 100);
});

test("P0 canaries refuse missing budgets and shared duplicate claims before calling a provider", async () => {
  await assert.rejects(
    dispatchCanaries({ store: {}, engines: ["chatgpt"] }),
    /requires/,
  );
  let calls = 0;
  const env = {
    LLM_API_KEY: fake,
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
  };
  const result = await dispatchCanaries({
    engines: ["chatgpt"],
    slot: "fixture-slot",
    maxRequests: 1,
    maxSpendUsd: 1,
    reserveUsd: 1,
    env,
    store: {
      seed: async () => {},
      claim: async () => ({ granted: false, reason: "leased" }),
    },
    registry: [
      {
        name: "chatgpt",
        probe: async () => {
          calls++;
        },
      },
    ],
  });
  assert.equal(calls, 0);
  assert.equal(result[0].reason, "leased");
});

test("R05-03 fully observed brand-free answers produce a qualified exposure zero", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    engine: "chatgpt",
    prompt: `Brand-free fixture ${i}?`,
    text: "Consider price, support and reliability.",
    answer_present: true,
    brand_mentioned_in_text: false,
    brand_cited: false,
    visible: false,
    brands: [],
    citations: [],
    references: [],
    error: null,
    is_branded_query: false,
  }));
  const slice = summarizeEngineSlice(rows, "chatgpt", {
    plannedQueries: rows.map((r) => r.prompt),
  });
  const h = computeHeadline([slice]);
  assert.equal(h.qualified, true);
  assert.equal(h.headline_pct, 0);
  assert.equal(h.metric.denominator, 30);
  assert.equal(h.metric.collection.valid, 30);
});

test("P0 dispatch store fails closed on an unavailable migration/RPC", async () => {
  const store = createProbeDispatchStore({
    rpc: async () => ({
      data: null,
      error: { message: "function unavailable" },
    }),
  });
  await assert.rejects(
    store.claim("fixture", { reserve: 1 }),
    /claim_probe_dispatch failed/,
  );
});

test("P0 observation hashes survive PostgreSQL jsonb key reordering", () => {
  const queries = [
    {
      text: "Fixture?",
      topic: "General",
      nested: { language: "en", country: "in" },
    },
  ];
  const roundtrip = [
    {
      nested: { country: "in", language: "en" },
      topic: "General",
      text: "Fixture?",
    },
  ];
  assert.equal(hashIdentity(queries), hashIdentity(roundtrip));
  assert.notEqual(
    hashIdentity(queries),
    hashIdentity([...roundtrip, { text: "Extra?" }]),
  );
});

test("P0 configuration rotation after sourcing blocks dispatch under the original identity", async () => {
  const before = {
    LLM_API_KEY: fake,
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
  };
  const rotated = {
    ...before,
    LLM_API_KEY: "EXAMPLE-NOT-A-REAL-ROTATED-CREDENTIAL",
  };
  const rows = [];
  let calls = 0;
  const checkpoint = {
    brand: "Acme",
    url: "https://acme.example",
    engines: ["chatgpt"],
    queries: [{ text: "Fixture?" }],
    stats: { cost: 0 },
    dispatch: freezeDispatch({ engines: ["chatgpt"], env: before }),
  };
  const store = {
    seed: async (values) =>
      rows.push(
        ...values.map((r) => ({ ...r, state: "pending", attempt_count: 0 })),
      ),
    block: async (id, reason) =>
      Object.assign(
        rows.find((r) => r.id === id),
        { state: "blocked", reason },
      ),
    claim: async () => {
      throw new Error("Configuration rotation must refuse before claim");
    },
    list: async () => rows,
  };
  const outcome = await runDurableProbing({
    jobId: "fixture",
    checkpoint,
    engines: [
      {
        name: "chatgpt",
        probe: async () => {
          calls++;
        },
      },
    ],
    store,
    getResults: async () => [],
    updateJob: async () => {},
    env: rotated,
    chunkStartMs: Date.now(),
    budgetMs: 150_000,
  });
  assert.equal(calls, 0);
  assert.equal(outcome.budgetHit, false);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].reason, "configuration_changed");
  assert.equal(
    rows[0].config_version,
    dispatchIdentity("chatgpt", before).config_version,
  );
});

test("P0 a failed account circuit overrides an earlier valid readiness canary without probing", async () => {
  const env = {
    LLM_API_KEY: fake,
    LLM_BASE_URL: "https://openrouter.ai/api/v1",
  };
  const now = new Date().toISOString();
  const identity = dispatchIdentity("chatgpt", env);
  const store = {
    canaries: async () => ({
      chatgpt: {
        config_version: identity.config_version,
        observed_at: now,
        outcome: "valid",
      },
    }),
    circuits: async () => [
      {
        circuit_key: identity.circuit_key,
        open_until: now,
        failure: { action: "repair_credentials" },
      },
    ],
  };
  const report = await readProviderReadiness({ store, env, now });
  assert.equal(report.engines.chatgpt.readiness, "blocked");
  assert.equal(report.engines.gemini.readiness, "blocked");
  assert.equal(report.engines.chatgpt.current, false);
  assert.equal(report.provider_requests, 0);
  assert.ok(!report.summary.ready.includes("chatgpt"));
  assert.equal(report.engines.chatgpt.operator_action, "repair_credentials");
});
