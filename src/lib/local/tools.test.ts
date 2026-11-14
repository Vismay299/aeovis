import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  localTools,
  searchLocalBusinessesTool,
  getLocalSerpResultsTool,
  getLocalRankGridTool,
  getBusinessProfileTool,
  getBusinessReviewsTool,
  getBusinessUpdatesTool,
  getGoogleBusinessQuestionsTool,
  listBusinessCategoriesTool,
  type LocalToolContext,
} from "./tools.ts";

const ISO = "2026-10-22T08:10:00.000Z";
const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const FETCH_ID = "22222222-2222-4222-8222-222222222222";
const GRID_ID = "33333333-3333-4333-8333-333333333333";

function makeContext(over: Partial<LocalToolContext> = {}): LocalToolContext {
  return {
    admin: {} as never,
    brand: { brandKey: "offcult.example", website_host: "www.offcult.example" },
    userId: "11111111-1111-4111-8111-111111111111",
    requestId: "44444444-4444-4444-8444-444444444444",
    ...over,
  };
}

function fetchView(over: Record<string, unknown> = {}) {
  return {
    id: FETCH_ID,
    kind: "reviews",
    status: "completed",
    businessId: BUSINESS_ID,
    params: { depth: 20 },
    totals: null,
    items: [],
    itemCount: 0,
    reused: false,
    error: null,
    createdAt: ISO,
    completedAt: ISO,
    pollAfterSeconds: null,
    ...over,
  };
}

function gridView(over: Record<string, unknown> = {}) {
  return {
    id: GRID_ID,
    status: "completed",
    keyword: "streetwear store",
    center: { latitude: 19.076, longitude: 72.8777 },
    gridSize: 3,
    spacingKm: 2,
    zoom: 13,
    device: "mobile",
    pointsReady: 9,
    pointsTotal: 9,
    points: [],
    summary: { pointsSearched: 9, pointsFound: 7, failed: 0, averageRank: 4.29, top3Count: 3, top10Count: 7 },
    matched: null,
    reused: false,
    error: null,
    createdAt: ISO,
    pollAfterSeconds: null,
    ...over,
  };
}

test("local tools carry the eight upstream names in order", () => {
  assert.deepEqual(
    localTools.map((t) => t.name),
    [
      "search_local_businesses",
      "get_local_serp_results",
      "get_local_rank_grid",
      "get_business_profile",
      "get_business_reviews",
      "get_business_updates",
      "get_google_business_questions",
      "list_business_categories",
    ],
  );
});

test("all inputs are closed objects and all outputs are loose objects", () => {
  for (const tool of localTools) {
    const input = z.toJSONSchema(tool.input, { io: "input" }) as { additionalProperties?: unknown };
    assert.equal(input.additionalProperties, false, `${tool.name}: input must be closed`);
    const output = z.toJSONSchema(tool.output, { io: "output" }) as { additionalProperties?: unknown };
    assert.notEqual(output.additionalProperties, false, `${tool.name}: output must stay loose`);
  }
});

test("every input rejects unknown fields", () => {
  assert.equal(searchLocalBusinessesTool.input.safeParse({ near: { latitude: 1, longitude: 1, radiusKm: 5 }, maxUsd: 0.05, extra: 1 }).success, false);
  assert.equal(getLocalSerpResultsTool.input.safeParse({ keyword: "k", near: { latitude: 1, longitude: 1 }, maxUsd: 0.05, bogus: 1 }).success, false);
  assert.equal(getLocalRankGridInputCheck(), false);
  assert.equal(getBusinessProfileTool.input.safeParse({ identifier: { cid: "1" }, maxUsd: 0.05, extra: 1 }).success, false);
  assert.equal(getBusinessReviewsTool.input.safeParse({ businessId: BUSINESS_ID, depth: 20, maxUsd: 0.05, extra: 1 }).success, false);
  assert.equal(getBusinessUpdatesTool.input.safeParse({ businessId: BUSINESS_ID, depth: 10, maxUsd: 0.05, extra: 1 }).success, false);
  assert.equal(getGoogleBusinessQuestionsTool.input.safeParse({ businessId: BUSINESS_ID, depth: 20, maxUsd: 0.05, extra: 1 }).success, false);
  assert.equal(listBusinessCategoriesTool.input.safeParse({ limit: 10, extra: 1 }).success, false);

  function getLocalRankGridInputCheck() {
    return getLocalRankGridTool.input.safeParse({
      keyword: "k",
      center: { latitude: 1, longitude: 1 },
      target: { cid: "1" },
      extra: 1,
    }).success;
  }
});

test("paid descriptions name their priced action", () => {
  assert.match(searchLocalBusinessesTool.description, /local\.listings\.search/);
  assert.match(getLocalSerpResultsTool.description, /local\.serp\.search/);
  assert.match(getLocalRankGridTool.description, /local\.grid\.run/);
  assert.match(getBusinessProfileTool.description, /local\.profile\.lookup/);
  assert.match(getBusinessReviewsTool.description, /local\.reviews\.collect/);
  assert.match(getBusinessUpdatesTool.description, /local\.updates\.collect/);
  assert.match(getGoogleBusinessQuestionsTool.description, /local\.questions\.collect/);
  assert.match(listBusinessCategoriesTool.description, /Uses no credits/);
});

test("search, serp, profile and questions refuse without maxUsd before any provider call", async () => {
  let called = 0;
  const searchCtx = makeContext({ deps: { searchLocalBusinesses: (async () => { called += 1; return null; }) as never } });
  await assert.rejects(() => searchLocalBusinessesTool.handler(searchCtx, { near: { latitude: 1, longitude: 1, radiusKm: 5 } }));
  assert.equal(called, 0);

  called = 0;
  const serpCtx = makeContext({ deps: { getLocalSerpResults: (async () => { called += 1; return null; }) as never } });
  await assert.rejects(() => getLocalSerpResultsTool.handler(serpCtx, { keyword: "k", near: { latitude: 1, longitude: 1 } }));
  assert.equal(called, 0);

  called = 0;
  const profileCtx = makeContext({ deps: { lookupBusinessProfile: (async () => { called += 1; return null; }) as never } });
  await assert.rejects(() => getBusinessProfileTool.handler(profileCtx, { identifier: { cid: "123" } }));
  assert.equal(called, 0);

  called = 0;
  const questionsCtx = makeContext({
    deps: { startFetch: (async () => { called += 1; return fetchView({ kind: "questions" }); }) as never },
  });
  await assert.rejects(() =>
    getGoogleBusinessQuestionsTool.handler(questionsCtx, { businessId: BUSINESS_ID, depth: 20 }),
  );
  assert.equal(called, 0, "questions without maxUsd must refuse before startFetch");
});

test("reviews, updates and grid refuse without maxUsd before any provider call", async () => {
  for (const [tool, kind, depth] of [
    [getBusinessReviewsTool, "reviews", 20],
    [getBusinessUpdatesTool, "updates", 10],
  ] as const) {
    let started = 0;
    let collected = 0;
    const ctx = makeContext({
      deps: {
        startFetch: (async () => { started += 1; return fetchView({ kind }); }) as never,
        collectFetch: (async () => { collected += 1; return fetchView({ kind }); }) as never,
      },
    });
    const err = await tool.handler(ctx, { businessId: BUSINESS_ID, depth }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err, `${tool.name} must refuse without maxUsd`);
    assert.equal(err.code, "approval_required");
    assert.match(String(err.message ?? err), /maxUsd/);
    assert.equal(started, 0, `${tool.name}: no paid post on refusal`);
    assert.equal(collected, 0, `${tool.name}: no collect on refusal`);
  }

  {
    let started = 0;
    let collected = 0;
    const ctx = makeContext({
      deps: {
        startGrid: (async () => { started += 1; return gridView(); }) as never,
        collectGrid: (async () => { collected += 1; return gridView(); }) as never,
      },
    });
    const err = await getLocalRankGridTool.handler(ctx, {
      keyword: "streetwear store",
      center: { latitude: 19.076, longitude: 72.8777 },
      target: { cid: "123" },
    }).then(() => null, (e) => e);
    assert.ok(err, "grid must refuse without maxUsd");
    assert.equal(err.code, "approval_required");
    assert.equal(started, 0, "no paid grid post on refusal");
    assert.equal(collected, 0);
  }
});

test("resume by fetchId makes no paid call", async () => {
  for (const [tool, kind] of [
    [getBusinessReviewsTool, "reviews"],
    [getBusinessUpdatesTool, "updates"],
    [getGoogleBusinessQuestionsTool, "questions"],
  ] as const) {
    let started = 0;
    const ctx = makeContext({
      deps: {
        startFetch: (async () => { started += 1; throw new Error("must not post"); }) as never,
        collectFetch: (async () => fetchView({ kind })) as never,
      },
    });
    const res = await tool.handler(ctx, { fetchId: FETCH_ID });
    assert.equal(res.id, FETCH_ID);
    assert.equal(res.status, "completed");
    assert.equal(started, 0, `${tool.name}: resume must not post`);
  }
});

test("resume by gridId makes no paid call", async () => {
  let started = 0;
  const ctx = makeContext({
    deps: {
      startGrid: (async () => { started += 1; throw new Error("must not post"); }) as never,
      collectGrid: (async () => gridView()) as never,
    },
  });
  const res = await getLocalRankGridTool.handler(ctx, { keyword: "k", center: { latitude: 1, longitude: 1 }, gridId: GRID_ID });
  assert.equal(res.id, GRID_ID);
  assert.equal(res.status, "completed");
  assert.equal(started, 0, "grid resume must not post");
});

test("handlers call services with maxUsd and return parsed views", async () => {
  {
    let seen: { input: unknown; maxUsd: unknown } | null = null;
    const ctx = makeContext({
      deps: {
        searchLocalBusinesses: (async (_ws: unknown, i: { maxUsd: number }) => {
          seen = { input: i, maxUsd: i.maxUsd };
          return { businesses: [{ title: "Bonkers Corner" }], cached: false, fetchedAt: ISO };
        }) as never,
      },
    });
    const res = await searchLocalBusinessesTool.handler(ctx, {
      near: { latitude: 19.07, longitude: 72.87, radiusKm: 5 },
      limit: 5,
      offset: 0,
      maxUsd: 0.05,
    });
    assert.equal(res.businesses.length, 1);
    assert.equal((seen as unknown as { maxUsd: number }).maxUsd, 0.05);
  }

  {
    const ctx = makeContext({
      deps: { getLocalSerpResults: (async () => ({ results: [{ rank: 1 }], ownRank: 1, cached: true, fetchedAt: ISO })) as never },
    });
    const res = await getLocalSerpResultsTool.handler(ctx, { keyword: "k", near: { latitude: 1, longitude: 1 }, maxUsd: 0.05 });
    assert.equal(res.ownRank, 1);
  }

  {
    const ctx = makeContext({
      deps: { lookupBusinessProfile: (async () => ({ profile: { title: "Offcult Store" }, businessId: null })) as never },
    });
    const res = await getBusinessProfileTool.handler(ctx, { identifier: { cid: "123" }, maxUsd: 0.05 });
    assert.equal((res.profile as { title: string }).title, "Offcult Store");
  }

  {
    const ctx = makeContext({
      deps: {
        startFetch: (async () => fetchView({ kind: "reviews", reused: false })) as never,
      },
    });
    const res = await getBusinessReviewsTool.handler(ctx, { businessId: BUSINESS_ID, depth: 20, maxUsd: 0.05 });
    assert.equal(res.kind, "reviews");
  }

  {
    const ctx = makeContext({
      deps: { listBusinessCategories: (async () => ({ categories: [{ category: "pizza_restaurant", businessCount: 12 }], total: 1 })) as never },
    });
    const res = await listBusinessCategoriesTool.handler(ctx, { query: "pizza", limit: 10 });
    assert.equal(res.total, 1);
  }

  {
    let seenMaxUsd: unknown = null;
    const ctx = makeContext({
      deps: {
        startGrid: (async (_ws: unknown, i: { maxUsd: number }) => {
          seenMaxUsd = i.maxUsd;
          return gridView();
        }) as never,
      },
    });
    const res = await getLocalRankGridTool.handler(ctx, {
      keyword: "streetwear store",
      center: { latitude: 19.076, longitude: 72.8777 },
      target: { cid: "123" },
      maxUsd: 0.02,
    });
    assert.equal(res.status, "completed");
    assert.equal(seenMaxUsd, 0.02);
  }
});
