import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register(new URL("../customerRoutes.test.hooks.mjs", import.meta.url));

const exploreRoute = await import("../../app/api/customer/explore/route.ts");
const runRoute = await import("../../app/api/customer/explore/[runId]/route.ts");
const trackRoute = await import("../../app/api/customer/explore/[runId]/track/route.ts");

const { createMemoryExploreStore } = await import("./memoryStore.ts");
const { AppError } = await import("../../shared/http/errors.ts");

const BRAND_KEY = "acme";
const OTHER_BRAND_KEY = "other";
const USER = { id: "user-1", email: "user@example.test" };
const NOW = new Date("2026-10-22T10:00:00.000Z");

function mockBrand(over = {}) {
  return {
    brandKey: BRAND_KEY,
    role: "member",
    display_name: "Acme",
    website: "https://acme.example",
    website_host: "acme.example",
    aliases: ["Acme"],
    is_active: true,
    ...over,
  };
}

function workspaceStub(overContext = {}) {
  return async (request, opts = {}) => {
    if (overContext.unauthenticated) {
      throw new AppError(401, "unauthenticated", "Please sign in.");
    }
    const key = opts.brandKey ?? BRAND_KEY;
    if (key !== BRAND_KEY) {
      throw new AppError(404, "workspace_not_found", "Workspace not found.");
    }
    return {
      user: USER,
      brandKey: BRAND_KEY,
      brand: mockBrand(),
      role: "member",
      admin: {},
    };
  };
}

function makeDeps(over = {}) {
  const store = over.store ?? createMemoryExploreStore();
  return {
    store,
    requireWorkspace: workspaceStub(over.context),
    isFeatureEnabled: async (feature, brand) => {
      if (feature === "dataforseo_engines") return true;
      if (feature === "prompt_explorer") return over.featureEnabled ?? true;
      return true;
    },
    quote: async () => ({
      action: "ai_visibility.explore.run",
      currency: "USD",
      totalUsd: 0.1,
      expectedUsd: null,
      units: [],
      lines: [],
      monthly: null,
      warnings: [],
      blocked: null,
      priceVersion: "2026-10-21.1",
      quotedAt: NOW.toISOString(),
      inputsHash: "hash",
    }),
    reserveSpend: async () => ({ holdId: "hold-1" }),
    releaseSpend: async () => {},
    enqueueJob: async () => ({ jobId: "job-1" }),
    rateLimits: {
      findActiveRun: async (b, u) => {
        for (const run of store.runs.values()) {
          if (run.brand_key === b && run.created_by === u && ["queued", "running"].includes(run.status)) {
            return { id: run.id };
          }
        }
        return null;
      },
      listUserRunsInWindow: async (u, since) => {
        const out = [];
        for (const run of store.runs.values()) {
          if (run.created_by === u && run.created_at >= since) {
            out.push({ id: run.id, created_at: run.created_at });
          }
        }
        return out;
      },
      countWorkspaceRunsSince: async (b, since) => {
        let count = 0;
        for (const run of store.runs.values()) {
          if (run.brand_key === b && run.created_at >= since) count++;
        }
        return count;
      },
      ...over.rateLimits,
    },
    now: () => NOW,
    env: {
      EXPLORE_MAX_RUNS_PER_USER_HOUR: "10",
      EXPLORE_MAX_RUNS_PER_WORKSPACE_DAY: "30",
      FEATURE_DATAFORSEO_ENGINES: "on",
      DATAFORSEO_API_KEY: "dfs-key",
      OPENROUTER_API_KEY: "or-key",
      OPENROUTER_OPENAI_MODEL: "openai/gpt-4o",
    },
    ...over,
  };
}

test("POST /api/customer/explore: input validation (F11-AC-08)", async (t) => {
  await t.test("invalid json body returns 400 invalid_json", async () => {
    const deps = makeDeps();
    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "invalid_json");
  });

  await t.test("missing prompt returns 400 invalid_request", async () => {
    const deps = makeDeps();
    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: ["chatgpt"] }),
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "invalid_request");
  });

  await t.test("prompt > 500 chars returns 400 invalid_request", async () => {
    const deps = makeDeps();
    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "a".repeat(501), models: ["chatgpt"] }),
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "invalid_request");
  });

  await t.test("empty models returns 400 invalid_request", async () => {
    const deps = makeDeps();
    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "test prompt", models: [] }),
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "invalid_request");
  });

  await t.test("models > 3 returns 400 invalid_request", async () => {
    const deps = makeDeps();
    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "test prompt",
        models: ["chatgpt", "gemini", "perplexity", "extra"],
      }),
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "invalid_request");
  });

  await t.test("unsupported model (claude) returns 400 invalid_request", async () => {
    const deps = makeDeps();
    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "test prompt", models: ["claude"] }),
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "invalid_request");
  });

  await t.test("invalid country format returns 400 invalid_request", async () => {
    const deps = makeDeps();
    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "test prompt", models: ["chatgpt"], country: "USA" }),
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "invalid_request");
  });

  await t.test("highlightBrand > 100 chars returns 400 invalid_request", async () => {
    const deps = makeDeps();
    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "test prompt",
        models: ["chatgpt"],
        highlightBrand: "b".repeat(101),
      }),
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "invalid_request");
  });

  await t.test("extra unknown body field returns 400 invalid_request (strict)", async () => {
    const deps = makeDeps();
    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "test prompt", models: ["chatgpt"], unexpected: true }),
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "invalid_request");
  });
});

test("POST /api/customer/explore: auth, permissions, feature flag, limits", async (t) => {
  await t.test("unauthenticated returns 401", async () => {
    const deps = makeDeps({ context: { unauthenticated: true } });
    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "test prompt", models: ["chatgpt"] }),
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, "unauthenticated");
  });

  await t.test("wrong workspace returns 404 workspace_not_found", async () => {
    const deps = makeDeps();
    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brand_key: OTHER_BRAND_KEY,
        prompt: "test prompt",
        models: ["chatgpt"],
      }),
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "workspace_not_found");
  });

  await t.test("feature disabled returns 403 feature_disabled", async () => {
    const deps = makeDeps({ featureEnabled: false });
    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "test prompt", models: ["chatgpt"] }),
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.code, "feature_disabled");
  });

  await t.test("rate limited returns 429 explore_rate_limited", async () => {
    const deps = makeDeps({
      rateLimits: {
        listUserRunsInWindow: async () =>
          Array.from({ length: 15 }, () => ({
            id: "r",
            created_at: new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(),
          })),
      },
    });
    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "test prompt", models: ["chatgpt"], maxUsd: 0.10 }),
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.code, "explore_rate_limited");
    assert.ok(typeof body.details?.retryAfterSeconds === "number");
  });

  await t.test("approval required when maxUsd not provided for priced run", async () => {
    const deps = makeDeps();
    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "test prompt", models: ["chatgpt"] }),
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "approval_required");
  });

  await t.test("price changed when maxUsd is less than quote", async () => {
    const deps = makeDeps();
    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "test prompt", models: ["chatgpt"], maxUsd: 0.05 }),
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "price_changed");
  });

  await t.test("already running returns 409 explore_already_running", async () => {
    const store = createMemoryExploreStore();
    // seed an active run for user-1
    store.seedRun({
      id: "run-active",
      brand_key: BRAND_KEY,
      created_by: USER.id,
      prompt: "earlier question",
      prompt_hash: "hash",
      highlight_brand: null,
      models: ["chatgpt"],
      web_search: true,
      country: null,
      status: "running",
      approved_max_usd: "0.10",
      job_id: "job-0",
      question_id: null,
      plan: [],
      quote: {},
      created_at: NOW.toISOString(),
      finished_at: null,
    });
    const deps = makeDeps({ store });
    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "test prompt", models: ["chatgpt"], maxUsd: 0.10 }),
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "explore_already_running");
  });
});

test("POST /api/customer/explore: success paths (F11-AC-15)", async (t) => {
  await t.test("new run returns 202 queued with runId, jobId, pollAfterSeconds", async () => {
    const deps = makeDeps();
    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "test prompt", models: ["chatgpt"], maxUsd: 0.10 }),
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 202);
    const body = await res.json();
    assert.ok(typeof body.runId === "string");
    assert.equal(body.status, "queued");
    assert.equal(body.pollAfterSeconds, 3);
    assert.equal(body.jobId, "job-1");
  });

  await t.test("all-reused run returns 200 completed immediately without job", async () => {
    const store = createMemoryExploreStore();
    const { hashPrompt } = await import("./shape.ts");
    const prompt = "popular running shoes";
    const promptHash = hashPrompt(prompt);

    store.seedRun({
      id: "run-prev",
      brand_key: BRAND_KEY,
      created_by: USER.id,
      prompt,
      prompt_hash: promptHash,
      highlight_brand: null,
      models: ["chatgpt"],
      web_search: true,
      country: null,
      status: "completed",
      approved_max_usd: "0.10",
      job_id: null,
      question_id: null,
      plan: [],
      quote: {},
      created_at: new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      finished_at: new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
    });

    store.seedObservation({
      id: "obs-prev",
      brand_key: BRAND_KEY,
      purpose: "explore",
      engine: "chatgpt",
      query: prompt,
      state: "answered",
      attempt_count: 1,
      unknown_cost_calls: 0,
      total_cost: 0.05,
      result: {
        model: "chatgpt",
        text: "Nike, Adidas, etc.",
        sources: [],
      },
      context: {
        explore_run_id: "run-prev",
        brand_key: BRAND_KEY,
        prompt_hash: promptHash,
        route: "dataforseo",
        model_name: "gpt-4o",
        web_search: true,
        country: null,
      },
      deadline_at: null,
      observed_at: new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      claimed_at: null,
      claim_token: null,
      lease_until: null,
    });

    let reserveCalled = false;
    let jobEnqueued = false;

    const deps = makeDeps({
      store,
      quote: async () => ({
        action: "ai_visibility.explore.run",
        currency: "USD",
        totalUsd: 0,
        expectedUsd: null,
        units: [],
        lines: [],
        monthly: null,
        warnings: [],
        blocked: null,
        priceVersion: "2026-10-21.1",
        quotedAt: NOW.toISOString(),
        inputsHash: "hash",
      }),
      reserveSpend: async () => {
        reserveCalled = true;
        return { holdId: "h-1" };
      },
      enqueueJob: async () => ({ jobId: "job-reused" }),
      env: {
        EXPLORE_MAX_RUNS_PER_USER_HOUR: "10",
        EXPLORE_MAX_RUNS_PER_WORKSPACE_DAY: "30",
        FEATURE_DATAFORSEO_ENGINES: "on",
        DATAFORSEO_API_KEY: "dfs-key",
        DATAFORSEO_LLM_MODEL_CHAT_GPT: "gpt-4o",
      },
    });

    const req = new Request("https://app.test/api/customer/explore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, models: ["chatgpt"] }),
    });
    const res = await exploreRoute.POST(req, {}, deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "completed");
    assert.equal(body.jobId, null);
    assert.equal(body.pollAfterSeconds, null);
    assert.equal(reserveCalled, false);
    assert.equal(jobEnqueued, false);
  });
});

test("GET /api/customer/explore: listing runs (F11-AC-15)", async (t) => {
  await t.test("invalid limit returns 400 invalid_request", async () => {
    const deps = makeDeps();
    const req = new Request("https://app.test/api/customer/explore?limit=100", { method: "GET" });
    const res = await exploreRoute.GET(req, {}, deps);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "invalid_request");
  });

  await t.test("returns runs array and nextCursor", async () => {
    const store = createMemoryExploreStore();
    store.seedRun({
      id: "run-1",
      brand_key: BRAND_KEY,
      created_by: USER.id,
      prompt: "best running shoes",
      prompt_hash: "hash1",
      highlight_brand: null,
      models: ["chatgpt"],
      web_search: true,
      country: null,
      status: "completed",
      approved_max_usd: "0.10",
      job_id: null,
      question_id: null,
      plan: [],
      quote: {},
      created_at: NOW.toISOString(),
      finished_at: NOW.toISOString(),
    });

    const deps = makeDeps({ store });
    const req = new Request("https://app.test/api/customer/explore?limit=10", { method: "GET" });
    const res = await exploreRoute.GET(req, {}, deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.runs));
    assert.equal(body.runs.length, 1);
    assert.equal(body.runs[0].runId, "run-1");
    assert.equal(body.runs[0].prompt, "best running shoes");
    assert.deepEqual(body.runs[0].models, ["chatgpt"]);
    assert.equal(body.runs[0].status, "completed");
    assert.equal(body.nextCursor, null);
  });
});

test("GET /api/customer/explore/[runId]: fetching run details (F11-AC-15)", async (t) => {
  await t.test("non-existent run returns 404 explore_run_not_found", async () => {
    const deps = makeDeps();
    const req = new Request("https://app.test/api/customer/explore/non-existent", { method: "GET" });
    const res = await runRoute.GET(req, { params: Promise.resolve({ runId: "non-existent" }) }, deps);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "explore_run_not_found");
  });

  await t.test("run from other workspace returns 404 explore_run_not_found", async () => {
    const store = createMemoryExploreStore();
    store.seedRun({
      id: "run-other",
      brand_key: OTHER_BRAND_KEY,
      created_by: "other-user",
      prompt: "other prompt",
      prompt_hash: "hash-other",
      highlight_brand: null,
      models: ["chatgpt"],
      web_search: true,
      country: null,
      status: "completed",
      approved_max_usd: "0.10",
      job_id: null,
      question_id: null,
      plan: [],
      quote: {},
      created_at: NOW.toISOString(),
      finished_at: NOW.toISOString(),
    });
    const deps = makeDeps({ store });
    const req = new Request("https://app.test/api/customer/explore/run-other", { method: "GET" });
    const res = await runRoute.GET(req, { params: Promise.resolve({ runId: "run-other" }) }, deps);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "explore_run_not_found");
  });

  await t.test("existing run returns full ExploreRunView", async () => {
    const store = createMemoryExploreStore();
    store.seedRun({
      id: "run-2",
      brand_key: BRAND_KEY,
      created_by: USER.id,
      prompt: "best oversized t-shirts in india",
      prompt_hash: "hash2",
      highlight_brand: "Acme",
      models: ["chatgpt", "gemini"],
      web_search: true,
      country: "IN",
      status: "completed",
      approved_max_usd: "0.20",
      job_id: null,
      question_id: null,
      plan: [
        {
          model: "chatgpt",
          route: "dataforseo",
          modelName: "gpt-4o",
          observationId: "obs-2",
          reserveUsd: 0.10,
          skipped: null,
          reusedFrom: null,
        },
        {
          model: "gemini",
          route: null,
          modelName: null,
          observationId: null,
          reserveUsd: 0,
          skipped: "UNSUPPORTED_COUNTRY",
          reusedFrom: null,
        },
      ],
      quote: {},
      created_at: NOW.toISOString(),
      finished_at: NOW.toISOString(),
    });

    store.seedObservation({
      id: "obs-2",
      brand_key: BRAND_KEY,
      purpose: "explore",
      engine: "chatgpt",
      query: "best oversized t-shirts in india",
      state: "answered",
      attempt_count: 1,
      unknown_cost_calls: 0,
      total_cost: 0.0611,
      result: {
        model: "chatgpt",
        text: "Popular brands include Acme and others.",
        sources: [
          {
            url: "https://acme.example/tee",
            domain: "acme.example",
            title: "Acme Tees",
          },
        ],
      },
      context: {
        explore_run_id: "run-2",
        brand_key: BRAND_KEY,
        prompt_hash: "hash2",
        route: "dataforseo",
        model_name: "gpt-4o",
        web_search: true,
        country: "IN",
      },
      deadline_at: null,
      observed_at: NOW.toISOString(),
      claimed_at: null,
      claim_token: null,
      lease_until: null,
    });

    const deps = makeDeps({ store });
    const req = new Request("https://app.test/api/customer/explore/run-2", { method: "GET" });
    const res = await runRoute.GET(req, { params: Promise.resolve({ runId: "run-2" }) }, deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.runId, "run-2");
    assert.equal(body.status, "completed");
    assert.equal(body.prompt, "best oversized t-shirts in india");
    assert.equal(body.highlightBrand, "Acme");
    assert.equal(body.country, "IN");
    assert.equal(body.results.length, 2);

    const chatgpt = body.results.find((r) => r.model === "chatgpt");
    assert.equal(chatgpt.status, "success");
    assert.equal(chatgpt.brandMentioned, true);
    assert.equal(chatgpt.workspaceBrandMentioned, true);
    assert.equal(chatgpt.costUsd, 0.0611);

    const gemini = body.results.find((r) => r.model === "gemini");
    assert.equal(gemini.status, "error");
    assert.equal(gemini.errorCode, "UNSUPPORTED_COUNTRY");
  });
});

test("POST /api/customer/explore/[runId]/track: tracking explored question (F11-AC-16)", async (t) => {
  function seedRun(store, runId, brandKey = BRAND_KEY) {
    store.seedRun({
      id: runId,
      brand_key: brandKey,
      created_by: USER.id,
      prompt: "what is perceev",
      prompt_hash: "hash-perceev",
      highlight_brand: null,
      models: ["chatgpt"],
      web_search: true,
      country: null,
      status: "completed",
      approved_max_usd: "0.10",
      job_id: null,
      question_id: null,
      plan: [],
      quote: {},
      created_at: NOW.toISOString(),
      finished_at: NOW.toISOString(),
    });
  }

  await t.test("tracks question successfully on first call (created: true) and stores question_id", async () => {
    const store = createMemoryExploreStore();
    seedRun(store, "run-track-1");
    let addedInput = null;

    const deps = makeDeps({
      store,
      addWorkspaceQuestion: async (admin, input) => {
        addedInput = input;
        return {
          question: { id: "q-new-1", status: "active" },
          created: true,
          revived: false,
        };
      },
    });

    const req = new Request("https://app.test/api/customer/explore/run-track-1/track", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await trackRoute.POST(req, { params: Promise.resolve({ runId: "run-track-1" }) }, deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.questionId, "q-new-1");
    assert.equal(body.created, true);
    assert.equal(body.status, "active");

    assert.equal(addedInput.brandKey, BRAND_KEY);
    assert.equal(addedInput.text, "what is perceev");
    assert.equal(addedInput.origin, "manual");
    assert.equal(addedInput.createdBy, USER.id);
    assert.deepEqual(addedInput.sourceRef, { kind: "explore_run", id: "run-track-1" });

    // Verify question_id was stored on run
    const updated = await store.getRun(BRAND_KEY, "run-track-1");
    assert.equal(updated.question_id, "q-new-1");
  });

  await t.test("repeat track call is idempotent (created: false) and preserves question_id", async () => {
    const store = createMemoryExploreStore();
    seedRun(store, "run-track-repeat");

    const deps = makeDeps({
      store,
      addWorkspaceQuestion: async () => ({
        question: { id: "q-existing-1", status: "active" },
        created: false,
        revived: false,
      }),
    });

    // First call
    const req1 = new Request("https://app.test/api/customer/explore/run-track-repeat/track", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res1 = await trackRoute.POST(req1, { params: Promise.resolve({ runId: "run-track-repeat" }) }, deps);
    assert.equal(res1.status, 200);
    const body1 = await res1.json();
    assert.equal(body1.created, false);
    assert.equal(body1.questionId, "q-existing-1");

    // Second call
    const req2 = new Request("https://app.test/api/customer/explore/run-track-repeat/track", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res2 = await trackRoute.POST(req2, { params: Promise.resolve({ runId: "run-track-repeat" }) }, deps);
    assert.equal(res2.status, 200);
    const body2 = await res2.json();
    assert.equal(body2.created, false);
    assert.equal(body2.questionId, "q-existing-1");

    const run = await store.getRun(BRAND_KEY, "run-track-repeat");
    assert.equal(run.question_id, "q-existing-1");
  });

  await t.test("F08 error passes through unchanged", async () => {
    const store = createMemoryExploreStore();
    seedRun(store, "run-track-err");

    const deps = makeDeps({
      store,
      addWorkspaceQuestion: async () => {
        throw new AppError(400, "question_limit", "Workspace has reached the maximum of 100 questions.");
      },
    });

    const req = new Request("https://app.test/api/customer/explore/run-track-err/track", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await trackRoute.POST(req, { params: Promise.resolve({ runId: "run-track-err" }) }, deps);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "question_limit");
    assert.equal(body.error, "Workspace has reached the maximum of 100 questions.");

    // question_id should NOT be set
    const run = await store.getRun(BRAND_KEY, "run-track-err");
    assert.equal(run.question_id, null);
  });

  await t.test("run from another workspace returns 404 explore_run_not_found", async () => {
    const store = createMemoryExploreStore();
    seedRun(store, "run-other-ws", OTHER_BRAND_KEY);

    const deps = makeDeps({ store });
    const req = new Request("https://app.test/api/customer/explore/run-other-ws/track", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await trackRoute.POST(req, { params: Promise.resolve({ runId: "run-other-ws" }) }, deps);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "explore_run_not_found");
    assert.equal(body.error, "This question does not exist in this workspace.");
  });

  await t.test("non-existent run returns 404 explore_run_not_found", async () => {
    const store = createMemoryExploreStore();
    const deps = makeDeps({ store });
    const req = new Request("https://app.test/api/customer/explore/missing-run-id/track", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await trackRoute.POST(req, { params: Promise.resolve({ runId: "missing-run-id" }) }, deps);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "explore_run_not_found");
  });

  await t.test("unexpected field in body returns 400 invalid_request", async () => {
    const deps = makeDeps();
    const req = new Request("https://app.test/api/customer/explore/run-1/track", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ extra: 123 }),
    });
    const res = await trackRoute.POST(req, { params: Promise.resolve({ runId: "run-1" }) }, deps);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "invalid_request");
  });

  await t.test("unauthenticated returns 401 unauthenticated", async () => {
    const deps = makeDeps({ context: { unauthenticated: true } });
    const req = new Request("https://app.test/api/customer/explore/run-1/track", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const res = await trackRoute.POST(req, { params: Promise.resolve({ runId: "run-1" }) }, deps);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, "unauthenticated");
  });
});
