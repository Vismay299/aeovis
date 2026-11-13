import test from "node:test";
import assert from "node:assert/strict";
import { POST as researchPost } from "../../app/api/customer/keywords/research/route.ts";
import { POST as serpPost } from "../../app/api/customer/keywords/serp/route.ts";
import {
  GET as savedGet,
  POST as savedPost,
} from "../../app/api/customer/keywords/saved/route.ts";
import { POST as removePost } from "../../app/api/customer/keywords/saved/remove/route.ts";
import { POST as tagsPost } from "../../app/api/customer/keywords/saved/tags/route.ts";
import {
  PATCH as tagPatch,
  DELETE as tagDelete,
} from "../../app/api/customer/keywords/tags/[tagId]/route.ts";
import { GET as exportGet } from "../../app/api/customer/keywords/saved/export/route.ts";
import { POST as refreshPost } from "../../app/api/customer/keywords/saved/refresh/route.ts";
import { POST as clusterPost } from "../../app/api/customer/keywords/cluster/route.ts";
import { POST as clusterApplyPost } from "../../app/api/customer/keywords/cluster/apply/route.ts";
import { createMemorySavedKeywordsRepository } from "./memoryRepository.ts";
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

  await t.test("unknown area -> 409 unknown_location before any paid call (F13-AC-20)", async () => {
    const req = new Request("http://localhost/api/customer/keywords/research", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ keyword: "plumber", locationCode: 2840, locationName: "Atlantis,Texas,United States", maxUsd: 0.2 }),
    });
    let paidCalls = 0;
    const checked = [];
    const res = await researchPost(req, null, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => true,
      requireApprovedPrice: async () => ({ approvedMaxUsd: 0.2 }),
      assertLocalLocation: async (code, name) => {
        checked.push([code, name]);
        throw new AppError(409, "unknown_location", `"Atlantis, Texas, United States" is not a city, county, or region we can find in United States.`);
      },
      labs: { keywords: { suggestions: async () => { paidCalls++; return []; }, ideas: async () => { paidCalls++; return []; } } },
      ads: { adsSearchVolume: async () => { paidCalls++; return []; } },
      upsertMetrics: async () => {},
      cacheDeps: { store: createMemoryCacheStore() },
    });

    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, "unknown_location");
    assert.deepEqual(checked, [[2840, "Atlantis,Texas,United States"]]);
    assert.equal(paidCalls, 0);
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

  await t.test("POST /api/customer/keywords/saved rejects client metrics with 400 (F13-AC-07)", async () => {
    const repo = createMemorySavedKeywordsRepository();
    const req = new Request("http://localhost/api/customer/keywords/saved", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brand_key: BRAND_KEY,
        keywords: ["seo tool"],
        metrics: { searchVolume: 5000 },
      }),
    });

    const res = await savedPost(req, null, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => true,
      repo,
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "invalid_request");
    assert.match(body.error, /Client metrics are not accepted/);
  });

  await t.test("tenant isolation: workspace B cannot list, tag, export, or delete workspace A's saved keywords (F13-AC-24)", async () => {
    const repo = createMemorySavedKeywordsRepository();

    // 1. Workspace A saves two keywords with tag "Alpha"
    const reqSaveA = new Request("http://localhost/api/customer/keywords/saved", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brand_key: "workspace-alpha",
        keywords: ["alpha kw 1", "alpha kw 2"],
        tags: ["Alpha"],
      }),
    });
    const resSaveA = await savedPost(reqSaveA, null, {
      requireWorkspace: async () => makeWorkspace("workspace-alpha"),
      isFeatureEnabled: async () => true,
      repo,
    });
    assert.equal(resSaveA.status, 200);
    const saveABody = await resSaveA.json();
    assert.equal(saveABody.created, 2);
    const [kwA1, kwA2] = saveABody.savedKeywordIds;

    // Workspace A lists: 2 rows
    const reqListA = new Request("http://localhost/api/customer/keywords/saved?brand_key=workspace-alpha");
    const resListA = await savedGet(reqListA, null, {
      requireWorkspace: async () => makeWorkspace("workspace-alpha"),
      isFeatureEnabled: async () => true,
      repo,
    });
    const listABody = await resListA.json();
    assert.equal(listABody.totalCount, 2);
    const tagAId = listABody.tags[0].id;

    // 2. Workspace B lists: gets 0 rows
    const reqListB = new Request("http://localhost/api/customer/keywords/saved?brand_key=workspace-beta");
    const resListB = await savedGet(reqListB, null, {
      requireWorkspace: async () => makeWorkspace("workspace-beta"),
      isFeatureEnabled: async () => true,
      repo,
    });
    assert.equal(resListB.status, 200);
    const listBBody = await resListB.json();
    assert.equal(listBBody.totalCount, 0);
    assert.equal(listBBody.rows.length, 0);

    // 3. Workspace B attempts to export: gets 0 rows
    const reqExportB = new Request("http://localhost/api/customer/keywords/saved/export?brand_key=workspace-beta");
    const resExportB = await exportGet(reqExportB, null, {
      requireWorkspace: async () => makeWorkspace("workspace-beta"),
      isFeatureEnabled: async () => true,
      repo,
    });
    assert.equal(resExportB.status, 200);
    const exportBBody = await resExportB.json();
    assert.equal(exportBBody.totalCount, 0);
    assert.equal(exportBBody.rows.length, 0);

    // 4. Workspace B attempts to tag Workspace A's keyword ids: taggedCount 0
    const reqTagB = new Request("http://localhost/api/customer/keywords/saved/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brand_key: "workspace-beta",
        savedKeywordIds: [kwA1, kwA2],
        addTags: ["Hijacked"],
      }),
    });
    const resTagB = await tagsPost(reqTagB, null, {
      requireWorkspace: async () => makeWorkspace("workspace-beta"),
      isFeatureEnabled: async () => true,
      repo,
    });
    assert.equal(resTagB.status, 200);
    const tagBBody = await resTagB.json();
    assert.equal(tagBBody.taggedCount, 0);

    // 5. Workspace B attempts to remove Workspace A's keyword ids: deletedCount 0
    const reqRemoveB = new Request("http://localhost/api/customer/keywords/saved/remove", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brand_key: "workspace-beta",
        savedKeywordIds: [kwA1, kwA2],
      }),
    });
    const resRemoveB = await removePost(reqRemoveB, null, {
      requireWorkspace: async () => makeWorkspace("workspace-beta"),
      isFeatureEnabled: async () => true,
      repo,
    });
    assert.equal(resRemoveB.status, 200);
    const removeBBody = await resRemoveB.json();
    assert.equal(removeBBody.deletedCount, 0);

    // 6. Workspace B attempts to delete Workspace A's tag: 404 tag_not_found
    const reqDelTagB = new Request(`http://localhost/api/customer/keywords/tags/${tagAId}?brand_key=workspace-beta`, {
      method: "DELETE",
    });
    const resDelTagB = await tagDelete(reqDelTagB, { params: { tagId: tagAId } }, {
      requireWorkspace: async () => makeWorkspace("workspace-beta"),
      isFeatureEnabled: async () => true,
      repo,
    });
    assert.equal(resDelTagB.status, 404);
    const delTagBBody = await resDelTagB.json();
    assert.equal(delTagBBody.code, "tag_not_found");

    // Verify Workspace A still has both keywords and its tag
    const resVerifyA = await savedGet(reqListA, null, {
      requireWorkspace: async () => makeWorkspace("workspace-alpha"),
      isFeatureEnabled: async () => true,
      repo,
    });
    const verifyABody = await resVerifyA.json();
    assert.equal(verifyABody.totalCount, 2);
    assert.equal(verifyABody.tags[0].name, "Alpha");
  });

  await t.test("tag deletion returns 409 tag_in_use with pluralization", async () => {
    const repo = createMemorySavedKeywordsRepository();
    // Save 2 keywords tagged with "Important"
    const reqSave = new Request("http://localhost/api/customer/keywords/saved", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brand_key: BRAND_KEY,
        keywords: ["kw one", "kw two"],
        tags: ["Important"],
      }),
    });
    const resSave = await savedPost(reqSave, null, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => true,
      repo,
    });
    assert.equal(resSave.status, 200);

    const resList = await savedGet(
      new Request(`http://localhost/api/customer/keywords/saved?brand_key=${BRAND_KEY}`),
      null,
      {
        requireWorkspace: async () => makeWorkspace(),
        isFeatureEnabled: async () => true,
        repo,
      },
    );
    const listBody = await resList.json();
    const tagId = listBody.tags[0].id;

    // Try deleting when attached to 2 keywords
    const reqDel = new Request(`http://localhost/api/customer/keywords/tags/${tagId}?brand_key=${BRAND_KEY}`, {
      method: "DELETE",
    });
    const resDel2 = await tagDelete(reqDel, { params: { tagId } }, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => true,
      repo,
    });
    assert.equal(resDel2.status, 409);
    const del2Body = await resDel2.json();
    assert.equal(del2Body.code, "tag_in_use");
    assert.equal(del2Body.error, "Tag is attached to 2 keywords. Remove the tag from those keywords first.");

    // Remove 1 keyword
    await removePost(
      new Request("http://localhost/api/customer/keywords/saved/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brand_key: BRAND_KEY,
          savedKeywordIds: [listBody.rows[0].id],
        }),
      }),
      null,
      {
        requireWorkspace: async () => makeWorkspace(),
        isFeatureEnabled: async () => true,
        repo,
      },
    );

    // Try deleting when attached to 1 keyword
    const resDel1 = await tagDelete(reqDel, { params: { tagId } }, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => true,
      repo,
    });
    assert.equal(resDel1.status, 409);
    const del1Body = await resDel1.json();
    assert.equal(del1Body.code, "tag_in_use");
    assert.equal(del1Body.error, "Tag is attached to 1 keyword. Remove the tag from those keywords first.");

    // Remove second keyword
    await removePost(
      new Request("http://localhost/api/customer/keywords/saved/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brand_key: BRAND_KEY,
          savedKeywordIds: [listBody.rows[1].id],
        }),
      }),
      null,
      {
        requireWorkspace: async () => makeWorkspace(),
        isFeatureEnabled: async () => true,
        repo,
      },
    );

    // Delete succeeds now
    const resDel0 = await tagDelete(reqDel, { params: { tagId } }, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => true,
      repo,
    });
    assert.equal(resDel0.status, 200);
    const del0Body = await resDel0.json();
    assert.equal(del0Body.deleted, true);
  });

  await t.test("export route returns truncated: true when totalCount > 5,000", async () => {
    const mockRepo = {
      ...createMemorySavedKeywordsRepository(),
      async listAllForExport() {
        return {
          rows: new Array(5000).fill({ id: "id", keyword: "test", locationCode: 2840, languageCode: "en" }),
          totalCount: 5200,
          truncated: true,
        };
      },
    };

    const req = new Request(`http://localhost/api/customer/keywords/saved/export?brand_key=${BRAND_KEY}`);
    const res = await exportGet(req, null, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => true,
      repo: mockRepo,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.totalCount, 5200);
    assert.equal(body.truncated, true);
    assert.equal(body.rows.length, 5000);
  });

  await t.test("refresh route returns 202 queued with pollAfterSeconds 5", async () => {
    let recordedApproval = false;
    let enqueuedJob = false;

    const req = new Request("http://localhost/api/customer/keywords/saved/refresh", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brand_key: BRAND_KEY,
        maxUsd: 1.5,
      }),
    });

    const res = await refreshPost(req, null, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async () => true,
      requireApprovedPrice: async () => ({
        approvedMaxUsd: 0.75,
        quote: { totalUsd: 0.75, lines: [] },
        source: "dialog",
      }),
      enqueueJob: async (kind, payload, options) => {
        enqueuedJob = true;
        assert.equal(kind, "keywords.refresh_metrics");
        assert.equal(payload.approvedMaxUsd, 0.75);
        assert.equal(options.singleActiveKey, `keywords.refresh:${BRAND_KEY}`);
        return { jobId: "22222222-2222-4222-8222-222222222222", deduped: false };
      },
      recordApproval: async () => {
        recordedApproval = true;
      },
    });

    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.status, "queued");
    assert.equal(body.jobId, "22222222-2222-4222-8222-222222222222");
    assert.equal(body.pollAfterSeconds, 5);
    assert.equal(enqueuedJob, true);
    assert.equal(recordedApproval, true);
  });

  // F13-AC-18: "Group into topics" refuses before any paid call, prices
  // through the real approval path, and applies tags add-only.
  const clusterIds = (n, seed = 1) =>
    Array.from(
      { length: n },
      (_, i) =>
        `${String(seed).padStart(8, "0")}-${"1111"}-4111-8111-${String(i).padStart(12, "0")}`,
    );

  function fakeAdminWithRows(rows) {
    const calls = { rpc: [], from: [] };
    let tagSeq = 0;
    const admin = {
      calls,
      async rpc(name, args) {
        calls.rpc.push({ name, args });
        if (name === "list_saved_keywords") {
          return {
            data: { rows, totalCount: rows.length, tags: [] },
            error: null,
          };
        }
        if (name === "update_saved_keyword_tags") {
          return {
            data: {
              taggedCount: args.p_ids.length,
              addedTags: (args.p_add ?? []).map((t) => ({
                id: `tag-${(tagSeq += 1)}`,
                name: t.name,
                normalizedName: t.normalized,
                color: null,
              })),
              removedTagIds: args.p_remove ?? [],
              removedAssignments: 0,
            },
            error: null,
          };
        }
        throw new Error(`unexpected rpc ${name}`);
      },
      from(table) {
        calls.from.push(table);
        throw new Error(`unexpected table access ${table}`);
      },
    };
    return admin;
  }

  function savedRow(id, keyword) {
    return {
      id,
      keyword,
      locationCode: 2356,
      languageCode: "en",
      createdAt: "2026-11-01T10:00:00.000Z",
      searchVolume: 1000,
      cpc: 0.4,
      competition: 0.5,
      keywordDifficulty: 20,
      intent: "commercial",
      monthlySearches: [],
      fetchedAt: "2026-11-10T09:59:00.000Z",
      tags: [],
    };
  }

  await t.test("cluster route: flag keyword_clustering off -> 404 feature_unavailable", async () => {
    let enqueued = 0;
    const req = new Request("http://localhost/api/customer/keywords/cluster", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ savedKeywordIds: clusterIds(12) }),
    });

    const res = await clusterPost(req, null, {
      requireWorkspace: async () => makeWorkspace(),
      isFeatureEnabled: async (name) => name !== "keyword_clustering",
      enqueueJob: async () => {
        enqueued += 1;
        return { jobId: "x", deduped: false };
      },
    });

    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "feature_unavailable");
    assert.equal(enqueued, 0);
  });

  await t.test("cluster route: no maxUsd -> 400 approval_required and zero paid calls (F13-AC-18)", async () => {
    const ids = clusterIds(12);
    const admin = fakeAdminWithRows(ids.map((id, i) => savedRow(id, `kw ${i}`)));
    let enqueued = 0;
    const req = new Request("http://localhost/api/customer/keywords/cluster", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ savedKeywordIds: ids }),
    });

    const res = await clusterPost(req, null, {
      requireWorkspace: async () => ({ ...makeWorkspace(), admin }),
      isFeatureEnabled: async () => true,
      enqueueJob: async () => {
        enqueued += 1;
        return { jobId: "x", deduped: false };
      },
    });

    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "approval_required");
    assert.equal(enqueued, 0);
    assert.ok(
      admin.calls.from.length === 0,
      "refusal happened before any approval record or paid call",
    );
  });

  await t.test("cluster route: low maxUsd -> 409 price_changed", async () => {
    const ids = clusterIds(12);
    const admin = fakeAdminWithRows(ids.map((id, i) => savedRow(id, `kw ${i}`)));
    let enqueued = 0;
    // The repo default helper model is :free ($0 quotes); price with a
    // table-rated model so the ceiling check has something to refuse.
    const prevModel = process.env.LLM_HELPER_MODEL;
    process.env.LLM_HELPER_MODEL = "gpt-4o-mini";
    let res;
    try {
      const req = new Request("http://localhost/api/customer/keywords/cluster", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ savedKeywordIds: ids, maxUsd: 0.000001 }),
      });

      res = await clusterPost(req, null, {
        requireWorkspace: async () => ({ ...makeWorkspace(), admin }),
        isFeatureEnabled: async () => true,
        enqueueJob: async () => {
          enqueued += 1;
          return { jobId: "x", deduped: false };
        },
      });
    } finally {
      if (prevModel === undefined) delete process.env.LLM_HELPER_MODEL;
      else process.env.LLM_HELPER_MODEL = prevModel;
    }

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "price_changed");
    assert.equal(enqueued, 0);
  });

  await t.test("cluster route: 9 of 10 ids in workspace -> 409 too_few_keywords before any paid call (F13-AC-18)", async () => {
    const ids = clusterIds(10);
    // Only 9 of the 10 ids belong to the workspace.
    const admin = fakeAdminWithRows(ids.slice(0, 9).map((id, i) => savedRow(id, `kw ${i}`)));
    let enqueued = 0;
    const req = new Request("http://localhost/api/customer/keywords/cluster", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ savedKeywordIds: ids, maxUsd: 5 }),
    });

    const res = await clusterPost(req, null, {
      requireWorkspace: async () => ({ ...makeWorkspace(), admin }),
      isFeatureEnabled: async () => true,
      enqueueJob: async () => {
        enqueued += 1;
        return { jobId: "x", deduped: false };
      },
    });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "too_few_keywords");
    assert.equal(enqueued, 0);
    assert.ok(admin.calls.from.length === 0, "nothing was recorded or enqueued");
  });

  await t.test("cluster route: retry while running -> 409 job_already_running with no second paid call", async () => {
    const ids = clusterIds(12);
    const admin = fakeAdminWithRows(ids.map((id, i) => savedRow(id, `kw ${i}`)));
    let recorded = 0;
    const req = new Request("http://localhost/api/customer/keywords/cluster", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ savedKeywordIds: ids, maxUsd: 5 }),
    });

    const res = await clusterPost(req, null, {
      requireWorkspace: async () => ({ ...makeWorkspace(), admin }),
      isFeatureEnabled: async () => true,
      requireApprovedPrice: async () => ({ approvedMaxUsd: 5, quote: { totalUsd: 0.01 }, source: "dialog" }),
      enqueueJob: async () => {
        throw new AppError(409, "job_already_running", "Keyword grouping is already running.");
      },
      recordApproval: async () => {
        recorded += 1;
      },
    });

    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "job_already_running");
    assert.equal(recorded, 0);
  });

  await t.test("cluster route: valid approval -> 202 queued with pollAfterSeconds 3", async () => {
    const ids = clusterIds(12);
    const admin = fakeAdminWithRows(ids.map((id, i) => savedRow(id, `kw ${i}`)));
    let enqueuedKind = null;
    let recordedApproval = false;
    const req = new Request("http://localhost/api/customer/keywords/cluster", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ savedKeywordIds: ids, maxUsd: 5 }),
    });

    const res = await clusterPost(req, null, {
      requireWorkspace: async () => ({ ...makeWorkspace(), admin }),
      isFeatureEnabled: async () => true,
      requireApprovedPrice: async () => ({ approvedMaxUsd: 5, quote: { totalUsd: 0.01 }, source: "dialog" }),
      enqueueJob: async (kind, payload, options) => {
        enqueuedKind = kind;
        assert.deepEqual(payload.savedKeywordIds, ids);
        assert.equal(payload.approvedMaxUsd, 5);
        assert.equal(options.singleActiveKey, `keywords.cluster:${BRAND_KEY}`);
        return { jobId: "33333333-3333-4333-8333-333333333333", deduped: false };
      },
      recordApproval: async () => {
        recordedApproval = true;
      },
    });

    assert.equal(res.status, 202);
    const body = await res.json();
    assert.equal(body.status, "queued");
    assert.equal(body.jobId, "33333333-3333-4333-8333-333333333333");
    assert.equal(body.pollAfterSeconds, 3);
    assert.equal(enqueuedKind, "keywords.cluster");
    assert.equal(recordedApproval, true);
  });

  const proposalIds = clusterIds(12);
  const proposalResult = {
    clusters: [
      { name: "Topic A", savedKeywordIds: proposalIds.slice(0, 5) },
      { name: "Topic B", savedKeywordIds: proposalIds.slice(5, 9) },
      { name: "Topic C", savedKeywordIds: proposalIds.slice(9, 12) },
    ],
    unsorted: [],
    model: "google/gemma-4-31b-it:free",
    usd: 0.000234,
  };

  function applyDeps({ status = "completed", result = proposalResult, brandKey = BRAND_KEY, admin = null } = {}) {
    const updateCalls = [];
    const store = {
      async getJob() {
        return { id: "job-cluster-1", brand_key: brandKey, kind: "keywords.cluster", status };
      },
    };
    const rpcAdmin = admin ?? fakeAdminWithRows([]);
    const wrapped = {
      ...rpcAdmin,
      async rpc(name, args) {
        if (name === "update_saved_keyword_tags") updateCalls.push(args);
        return rpcAdmin.rpc(name, args);
      },
    };
    return {
      updateCalls,
      deps: {
        requireWorkspace: async () => ({ ...makeWorkspace(brandKey), admin: wrapped }),
        isFeatureEnabled: async () => true,
        jobStore: () => store,
        getJobStatus: async () => ({ status, result, progress: null, pollAfterSeconds: null, error: null }),
      },
    };
  }

  await t.test("cluster apply: id outside the proposal -> 400 invalid_request with no tag writes", async () => {
    const { updateCalls, deps } = applyDeps();
    const outsider = "99999999-9999-4999-8999-999999999999";
    const req = new Request("http://localhost/api/customer/keywords/cluster/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        clusters: [{ name: "Topic A", savedKeywordIds: [outsider] }],
      }),
    });

    const res = await clusterApplyPost(req, null, deps);
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "invalid_request");
    assert.equal(updateCalls.length, 0);
  });

  await t.test("cluster apply: running job -> 409 job_not_ready with no tag writes", async () => {
    const { updateCalls, deps } = applyDeps({ status: "running", result: null });
    const req = new Request("http://localhost/api/customer/keywords/cluster/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        clusters: [{ name: "Topic A", savedKeywordIds: proposalIds.slice(0, 5) }],
      }),
    });

    const res = await clusterApplyPost(req, null, deps);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "job_not_ready");
    assert.equal(updateCalls.length, 0);
  });

  await t.test("cluster apply: other workspace's job -> 404 job_not_found", async () => {
    const { deps } = applyDeps({ brandKey: "workspace-beta" });
    const req = new Request("http://localhost/api/customer/keywords/cluster/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        clusters: [{ name: "Topic A", savedKeywordIds: proposalIds.slice(0, 5) }],
      }),
    });

    // Workspace alpha tries to apply workspace beta's job.
    const res = await clusterApplyPost(req, null, {
      ...deps,
      requireWorkspace: async () => ({ ...makeWorkspace("workspace-alpha"), admin: fakeAdminWithRows([]) }),
    });
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.equal(body.code, "job_not_found");
  });

  await t.test("cluster apply: adds tags only and reports counts (F13-AC-18)", async () => {
    const { updateCalls, deps } = applyDeps();
    const req = new Request("http://localhost/api/customer/keywords/cluster/apply", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jobId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        clusters: [
          { name: "Renamed topic", savedKeywordIds: proposalIds.slice(0, 5) },
          { name: "Topic B", savedKeywordIds: proposalIds.slice(5, 9) },
        ],
      }),
    });

    const res = await clusterApplyPost(req, null, deps);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.taggedCount, 9);
    assert.equal(body.tags.length, 2);
    assert.equal(updateCalls.length, 2);
    // Tags are added; existing tags stay: removals are never sent.
    for (const call of updateCalls) {
      assert.deepEqual(call.p_remove, []);
      assert.equal(call.p_add.length, 1);
    }
    assert.equal(updateCalls[0].p_add[0].name, "Renamed topic");
    assert.equal(updateCalls[1].p_add[0].name, "Topic B");
  });
});
