import test from "node:test";
import assert from "node:assert/strict";
import { POST as researchPost } from "../../app/api/customer/keywords/research/route.ts";
import { POST as serpPost } from "../../app/api/customer/keywords/serp/route.ts";
import { AppError } from "../http/appError.ts";
import { SpendRefused } from "../spend/errors.ts";

const USER = { id: "user-1", email: "test@example.com" };
const BRAND_KEY = "test-brand";

function makeBrand(brandKey = BRAND_KEY) {
  return {
    brandKey,
    role: "member",
    display_name: "Test Brand",
    website: "https://example.com",
    website_host: "example.com",
    aliases: ["Test"],
    is_active: true,
  };
}

function makeWorkspace(brandKey = BRAND_KEY) {
  return {
    user: USER,
    brandKey,
    brand: makeBrand(brandKey),
    role: "member",
    admin: {},
  };
}

function createMemoryCacheStore() {
  const map = new Map();
  return {
    async read(key) {
      return map.get(key) ?? null;
    },
    async write(row) {
      map.set(row.key, { ...row });
    },
    async readBody() {
      return null;
    },
    async writeBody() {},
    async removeBodies() {},
    async pruneExpired() {
      return { deleted: 0, paths: [] };
    },
  };
}

test("keywords routes", async (t) => {
  await t.test("flag off -> 404 feature_unavailable", async () => {
    const req = new Request("http://localhost/api/customer/keywords/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword: "seo" }),
    });

    const res = await researchPost(req, null, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => false,
    });

    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "feature_unavailable");
  });

  await t.test("unknown body field -> 400", async () => {
    const req = new Request("http://localhost/api/customer/keywords/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword: "seo", unknownField: "unexpected" }),
    });

    const res = await researchPost(req, null, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => true,
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "invalid_request");
  });

  await t.test("no maxUsd -> 400 approval_required and zero spend calls", async () => {
    let spendCalls = 0;
    const req = new Request("http://localhost/api/customer/keywords/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword: "running shoes" }),
    });

    const res = await researchPost(req, null, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => true,
      labs: {
        keywords: {
          suggestions: async () => {
            spendCalls++;
            return [];
          },
          ideas: async () => {
            spendCalls++;
            return [];
          },
          related: async () => {
            spendCalls++;
            return [];
          },
        },
      },
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "approval_required");
    assert.equal(spendCalls, 0);
  });

  await t.test("low maxUsd -> 409 price_changed", async () => {
    const req = new Request("http://localhost/api/customer/keywords/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword: "running shoes", maxUsd: 0.01 }),
    });

    const res = await researchPost(req, null, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => true,
    });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "price_changed");
  });

  await t.test("cacheOnly miss -> 200 not_cached and zero spend calls", async () => {
    let spendCalls = 0;
    const cacheStore = createMemoryCacheStore();

    const req = new Request("http://localhost/api/customer/keywords/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword: "uncached term", cacheOnly: true }),
    });

    const res = await researchPost(req, null, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => true,
      cacheDeps: { store: cacheStore },
      labs: {
        keywords: {
          suggestions: async () => {
            spendCalls++;
            return [];
          },
        },
      },
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.notCached, true);
    assert.equal(body.cached, false);
    assert.equal(spendCalls, 0);
  });

  await t.test("hit from another workspace -> cached: true", async () => {
    const cacheStore = createMemoryCacheStore();
    let spendCalls = 0;

    const mockLabs = {
      keywords: {
        suggestions: async () => {
          spendCalls++;
          return [
            { keyword: "shoes", keyword_info: { search_volume: 500 } },
            { keyword: "sneakers", keyword_info: { search_volume: 400 } },
            { keyword: "boots", keyword_info: { search_volume: 300 } },
          ];
        },
        ideas: async () => {
          spendCalls++;
          return [
            { keyword: "loafers", keyword_info: { search_volume: 200 } },
            { keyword: "sandals", keyword_info: { search_volume: 100 } },
            { keyword: "slippers", keyword_info: { search_volume: 50 } },
          ];
        },
      },
    };

    // Workspace A runs research
    const reqA = new Request("http://localhost/api/customer/keywords/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword: "shoes", maxUsd: 0.1 }),
    });

    const resA = await researchPost(reqA, null, {
      requireWorkspace: async () => makeWorkspace("workspace-alpha"),
      isFeatureEnabled: async () => true,
      cacheDeps: { store: cacheStore },
      labs: mockLabs,
      ads: {},
      upsertMetrics: async () => {},
    });

    assert.equal(resA.status, 200);
    const bodyA = await resA.json();
    assert.equal(bodyA.cached, false);
    assert.equal(spendCalls, 2);

    // Workspace B asks for the same global market data
    const reqB = new Request("http://localhost/api/customer/keywords/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword: "shoes", maxUsd: 0.1 }),
    });

    const resB = await researchPost(reqB, null, {
      requireWorkspace: async () => makeWorkspace("workspace-beta"),
      isFeatureEnabled: async () => true,
      cacheDeps: { store: cacheStore },
      labs: mockLabs,
      ads: {},
      upsertMetrics: async () => {},
    });

    assert.equal(resB.status, 200);
    const bodyB = await resB.json();
    assert.equal(bodyB.cached, true);
    assert.equal(spendCalls, 2, "zero new spend calls for workspace B");
  });

  await t.test("provider 40501 invalid field -> 422 research_invalid", async () => {
    const req = new Request("http://localhost/api/customer/keywords/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword: "bad query", maxUsd: 0.1 }),
    });

    const res = await researchPost(req, null, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => true,
      labs: {
        keywords: {
          suggestions: async () => {
            throw new AppError(400, "dataforseo_invalid_field", "Invalid Field: keyword");
          },
          ideas: async () => [],
        },
      },
      ads: {},
      upsertMetrics: async () => {},
    });

    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.code, "research_invalid");
  });

  await t.test("spend refusal passes through", async () => {
    const req = new Request("http://localhost/api/customer/keywords/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword: "shoes", maxUsd: 0.1 }),
    });

    const res = await researchPost(req, null, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => true,
      labs: {
        keywords: {
          suggestions: async () => {
            throw new SpendRefused("daily_cap", "Daily spend limit reached.");
          },
          ideas: async () => [],
        },
      },
      ads: {},
      upsertMetrics: async () => {},
    });

    assert.equal(res.status, 402);
    const body = await res.json();
    assert.equal(body.code, "daily_cap");
  });

  await t.test("SERP route: flag off -> 404, invalid body -> 400, cacheOnly miss -> 200 notCached", async () => {
    // 1. flag off
    const reqOff = new Request("http://localhost/api/customer/keywords/serp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword: "shoes" }),
    });
    const resOff = await serpPost(reqOff, null, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => false,
    });
    assert.equal(resOff.status, 404);

    // 2. invalid body
    const reqInv = new Request("http://localhost/api/customer/keywords/serp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword: "shoes", extra: "forbidden" }),
    });
    const resInv = await serpPost(reqInv, null, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => true,
    });
    assert.equal(resInv.status, 400);

    // 3. cacheOnly miss
    const cacheStore = createMemoryCacheStore();
    const reqCacheOnly = new Request("http://localhost/api/customer/keywords/serp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword: "uncached serp", cacheOnly: true }),
    });
    const resCacheOnly = await serpPost(reqCacheOnly, null, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => true,
      cachedDeps: { cacheDeps: { store: cacheStore } },
    });
    assert.equal(resCacheOnly.status, 200);
    const bodyCacheOnly = await resCacheOnly.json();
    assert.equal(bodyCacheOnly.notCached, true);
    assert.equal(bodyCacheOnly.cached, false);
  });
});
