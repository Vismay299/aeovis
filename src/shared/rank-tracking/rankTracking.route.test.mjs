import test from "node:test";
import assert from "node:assert/strict";
import { POST as configsPost, GET as configsGet } from "../../app/api/customer/rank-tracking/configs/route.ts";
import { POST as keywordsPost } from "../../app/api/customer/rank-tracking/configs/[configId]/keywords/route.ts";
import { POST as checkPost } from "../../app/api/customer/rank-tracking/configs/[configId]/check/route.ts";
import { createMemoryRankTrackingRepository } from "./memoryRepository.ts";
import { SpendRefused } from "../spend/errors.ts";

const USER = { id: "user-1", email: "test@example.com" };
const BRAND = "brand-a";

function ws(admin) {
  return { user: USER, brandKey: BRAND, brand: { brandKey: BRAND }, role: "member", admin: admin || {} };
}

function req(url, body) {
  return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("flag off -> 404 feature_unavailable", async () => {
  const res = await configsGet(new Request("http://localhost/api/customer/rank-tracking/configs?brand_key=brand-a"), null, {
    requireWorkspace: async () => ws(),
    isFeatureEnabled: async () => false,
  });
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "feature_unavailable");
});

test("extra body field -> 400 invalid_request", async () => {
  const res = await configsPost(req("http://localhost/api", { domain: "example.com", unknownField: "x" }), null, {
    requireWorkspace: async () => ws(),
    isFeatureEnabled: async () => true,
  });
  assert.equal(res.status, 400);
});

test("unknown_location returns 409 before any provider call", async () => {
  const repo = createMemoryRankTrackingRepository();
  let providerCalls = 0;
  const fakeBegin = async () => { providerCalls++; return { ok: true, runId: crypto.randomUUID(), jobId: "j" }; };
  const cfg = await repo.insertConfig({ brand_key: BRAND, domain: "example.com", location_code: 2840, language_code: "en", location_name: "Mumbai", devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null });
  const res = await checkPost(req("http://localhost/api", { maxUsd: 5 }), { params: Promise.resolve({ configId: cfg.id }) }, {
    requireWorkspace: async () => ws(),
    isFeatureEnabled: async () => true,
    repo,
    quote: async () => ({ totalUsd: 0.01, checkUsd: 0.01, retryUsd: 0, pairs: 1 }),
    requireApprovedPrice: async () => ({ quote: { totalUsd: 0.01 }, approvedMaxUsd: 5, source: "dialog" }),
    beginRankCheckRun: fakeBegin,
    assertTrackedLocation: async () => { const m = await import("../http/appError.ts"); throw new m.AppError(409, "unknown_location", "unknown"); },
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "unknown_location");
  assert.equal(providerCalls, 0);
});

test("foreign tracker -> 404", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: "other-brand", domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null });
  const res = await checkPost(req("http://localhost/api", { maxUsd: 5 }), { params: Promise.resolve({ configId: cfg.id }) }, {
    requireWorkspace: async () => ws(),
    isFeatureEnabled: async () => true,
    repo,
  });
  assert.equal(res.status, 404);
});

test("check without maxUsd -> 400 approval_required with details.quote (no spend)", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: BRAND, domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null });
  await repo.addKeywords(BRAND, cfg.id, [{ keyword: "kw1" }]);
  let began = 0;
  const res = await checkPost(req("http://localhost/api", {}), { params: Promise.resolve({ configId: cfg.id }) }, {
    requireWorkspace: async () => ws(),
    isFeatureEnabled: async () => true,
    repo,
    quote: async () => ({ totalUsd: 0.05, checkUsd: 0.02, retryUsd: 0.03, pairs: 1 }),
    requireApprovedPrice: async (k, c, i, max) => {
      if (max == null) {
        const m = await import("../http/appError.ts");
        throw new m.AppError(400, "approval_required", "Approval required.", { details: { quote: { totalUsd: 0.05 } } });
      }
      return { quote: { totalUsd: 0.05 }, approvedMaxUsd: max, source: "dialog" };
    },
    beginRankCheckRun: async () => { began++; return { ok: true, runId: "r", jobId: "j" }; },
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "approval_required");
  assert.ok(body.details && body.details.quote);
  assert.equal(began, 0);
});

test("lower maxUsd -> 409 price_changed with details.quote", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: BRAND, domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null });
  await repo.addKeywords(BRAND, cfg.id, [{ keyword: "kw1" }]);
  const res = await checkPost(req("http://localhost/api", { maxUsd: 0.01 }), { params: Promise.resolve({ configId: cfg.id }) }, {
    requireWorkspace: async () => ws(),
    isFeatureEnabled: async () => true,
    repo,
    quote: async () => ({ totalUsd: 0.05, checkUsd: 0.02, retryUsd: 0.03, pairs: 1 }),
    requireApprovedPrice: async () => {
      const m = await import("../http/appError.ts");
      throw new m.AppError(409, "price_changed", "changed", { details: { quote: { totalUsd: 0.05 } } });
    },
    beginRankCheckRun: async () => ({ ok: true, runId: "r", jobId: "j" }),
  });
  assert.equal(res.status, 409);
  const bq = await res.json();
  assert.ok(bq.details && bq.details.quote);
});

test("second check -> 409 rank_check_running", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: BRAND, domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null });
  await repo.addKeywords(BRAND, cfg.id, [{ keyword: "kw1" }]);
  const res = await checkPost(req("http://localhost/api", { maxUsd: 5 }), { params: Promise.resolve({ configId: cfg.id }) }, {
    requireWorkspace: async () => ws(),
    isFeatureEnabled: async () => true,
    repo,
    quote: async () => ({ totalUsd: 0.01, checkUsd: 0.01, retryUsd: 0, pairs: 1 }),
    requireApprovedPrice: async () => ({ quote: { totalUsd: 0.01 }, approvedMaxUsd: 5, source: "dialog" }),
    beginRankCheckRun: async () => ({ ok: false, reason: "already_running", activeRunId: "run-1" }),
  });
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "rank_check_running");
});

test("spend refusal -> 402/403 (F01 copy)", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: BRAND, domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null });
  await repo.addKeywords(BRAND, cfg.id, [{ keyword: "kw1" }]);
  const res = await checkPost(req("http://localhost/api", { maxUsd: 5 }), { params: Promise.resolve({ configId: cfg.id }) }, {
    requireWorkspace: async () => ws(),
    isFeatureEnabled: async () => true,
    repo,
    quote: async () => { throw new SpendRefused("daily_cap", { scope: "workspace" }); },
    requireApprovedPrice: async () => { throw new SpendRefused("daily_cap", { scope: "workspace" }); },
    beginRankCheckRun: async () => ({ ok: true, runId: "r", jobId: "j" }),
  });
  assert.ok([402, 403].includes(res.status));
});

test("keywords add without maxUsd on scheduled tracker -> 400 before insert", async () => {
  const repo = createMemoryRankTrackingRepository();
  const cfg = await repo.insertConfig({ brand_key: BRAND, domain: "example.com", location_code: 2840, language_code: "en", location_name: null, devices: "mobile", serp_depth: 10, schedule_interval: "weekly", is_active: true, next_check_at: null, created_by: null, approved_max_usd: 0.01 });
  const before = await repo.listKeywords(BRAND, cfg.id);
  assert.equal(before.length, 0);
  const mod = await import("./service.ts");
  const realAdd = mod.addKeywords;
  const res = await keywordsPost(req("http://localhost/api", { keywords: ["newkw"] }), { params: Promise.resolve({ configId: cfg.id }) }, {
    requireWorkspace: async () => ({ user: USER, brandKey: BRAND, brand: { brandKey: BRAND }, role: "member", admin: { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ in: async () => ({ data: [], error: null }) }) }) }) }) } }),
    isFeatureEnabled: async () => true,
    addKeywords: (w, id, body) => realAdd(w, id, body, { repo, quote: async () => ({ totalUsd: 1, checkUsd: 1, retryUsd: 0, pairs: 1 }) }),
  });
  assert.equal(res.status, 400);
  const after = await repo.listKeywords(BRAND, cfg.id);
  assert.equal(after.length, 0);
});

test("trend refuses a non-numeric sinceDays with 400 instead of crashing", async () => {
  const { GET: trendGet } = await import("../../app/api/customer/rank-tracking/configs/[configId]/trend/route.ts");
  const res = await trendGet(
    new Request("http://localhost/api?brand_key=brand-a&sinceDays=abc"),
    { params: Promise.resolve({ configId: crypto.randomUUID() }) },
    { requireWorkspace: async () => ws(), isFeatureEnabled: async () => true },
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "invalid_request");
});

test("ai-question route requires both rank_tracking and rank_tracking_ai_questions flags", async () => {
  const { POST: aiqPost } = await import("../../app/api/customer/rank-tracking/configs/[configId]/keywords/[keywordId]/ai-question/route.ts");
  const cfgId = crypto.randomUUID();
  const kwId = crypto.randomUUID();

  // 1. Both off -> 404
  let res = await aiqPost(
    req("http://localhost/api", { text: "What is coffee?" }),
    { params: Promise.resolve({ configId: cfgId, keywordId: kwId }) },
    {
      requireWorkspace: async () => ws(),
      isFeatureEnabled: async () => false,
    },
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "feature_unavailable");

  // 2. Only rank_tracking on -> 404
  res = await aiqPost(
    req("http://localhost/api", { text: "What is coffee?" }),
    { params: Promise.resolve({ configId: cfgId, keywordId: kwId }) },
    {
      requireWorkspace: async () => ws(),
      isFeatureEnabled: async (flag) => flag === "rank_tracking",
    },
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "feature_unavailable");

  // 3. Only rank_tracking_ai_questions on -> 404
  res = await aiqPost(
    req("http://localhost/api", { text: "What is coffee?" }),
    { params: Promise.resolve({ configId: cfgId, keywordId: kwId }) },
    {
      requireWorkspace: async () => ws(),
      isFeatureEnabled: async (flag) => flag === "rank_tracking_ai_questions",
    },
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "feature_unavailable");

  // 4. Both on -> success 200
  const qId = crypto.randomUUID();
  res = await aiqPost(
    req("http://localhost/api", { text: "What is coffee?", topic: "Coffee" }),
    { params: Promise.resolve({ configId: cfgId, keywordId: kwId }) },
    {
      requireWorkspace: async () => ws(),
      isFeatureEnabled: async () => true,
      trackKeywordAsAiQuestion: async (_w, _c, _k, _input) => ({
        questionId: qId,
        created: true,
        revived: false,
        linked: true,
      }),
    },
  );
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.questionId, qId);
  assert.equal(data.created, true);
  assert.equal(data.linked, true);
});

