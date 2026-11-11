import test from "node:test";
import assert from "node:assert/strict";
import { GET as listBusinesses, POST as postBusiness } from "../../app/api/customer/local/businesses/route.ts";
import { DELETE as deleteBusiness, PATCH as patchBusiness } from "../../app/api/customer/local/businesses/[businessId]/route.ts";
import { POST as refreshProfile } from "../../app/api/customer/local/businesses/[businessId]/profile/route.ts";
import { POST as postProfile } from "../../app/api/customer/local/profile/route.ts";
import { POST as postListings } from "../../app/api/customer/local/listings/route.ts";
import { GET as getCategories } from "../../app/api/customer/local/categories/route.ts";
import { GET as listFetches, POST as postFetch } from "../../app/api/customer/local/fetches/route.ts";
import { GET as getFetch } from "../../app/api/customer/local/fetches/[fetchId]/route.ts";
import { POST as postSerp } from "../../app/api/customer/local/serp/route.ts";
import { GET as listGrids, POST as postGrid } from "../../app/api/customer/local/grids/route.ts";
import { GET as getGrid } from "../../app/api/customer/local/grids/[gridId]/route.ts";
import { fixture, fixtureResult, localKit, makeWs } from "./testKit.ts";

const BASE = "http://localhost/api/customer/local";
const REQ = (n) => `${String(n).padStart(8, "0")}-dddd-4ddd-8ddd-${String(n).padStart(12, "0")}`;
const FOREIGN_BUSINESS = "99999999-9999-4999-8999-999999999999";

function json(method, path, body) {
  return new Request(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function ctx(params) {
  return { params: Promise.resolve(params) };
}

/** Route deps over a memory store, F01 memory spend and fake provider calls. */
function setup({ flag = true, enabled = true, responders = {}, taskResults = [] } = {}) {
  let index = 0;
  const polls = [];
  const kit = localKit(
    responders,
    {
      fetchTaskResult: async (input) => {
        polls.push(input);
        const next = taskResults[Math.min(index, taskResults.length - 1)];
        index += 1;
        if (next instanceof Error) throw next;
        return next;
      },
      fetchSerpTaskResult: async () => ({ status: "pending" }),
    },
    { enabled },
  );
  const ws = makeWs();
  const deps = {
    ...kit.deps,
    requireWorkspace: async () => ws,
    isFeatureEnabled: async () => flag,
  };
  return { kit, deps, polls, ws };
}

async function savedBusiness(deps, body = {}) {
  const res = await postBusiness(
    json("POST", "/businesses", { role: "own", title: "Acme Cafe", cid: "123456789", latitude: 37.7749, longitude: -122.4194, ...body }),
    undefined,
    deps,
  );
  assert.equal(res.status, 201);
  return (await res.json()).business;
}

const infoItem = () => {
  const result = fixtureResult("business-info.json");
  return { ...result.items[0], check_url: result.check_url };
};
const pending = { status: "pending", result: null };
const done = () => ({ status: "completed", result: fixtureResult("reviews-task-get-done.json") });

test("every route answers 404 feature_unavailable when the flag is off", async () => {
  const { deps } = setup({ flag: false });
  const id = "11111111-1111-4111-8111-111111111111";
  const calls = [
    listBusinesses(json("GET", "/businesses"), undefined, deps),
    postBusiness(json("POST", "/businesses", { role: "own", title: "A", cid: "1" }), undefined, deps),
    patchBusiness(json("PATCH", `/businesses/${id}`, { role: "own" }), ctx({ businessId: id }), deps),
    deleteBusiness(json("DELETE", `/businesses/${id}`), ctx({ businessId: id }), deps),
    postProfile(json("POST", "/profile", { identifier: { cid: "1" }, requestId: REQ(1) }), undefined, deps),
    refreshProfile(json("POST", `/businesses/${id}/profile`, { requestId: REQ(1) }), ctx({ businessId: id }), deps),
    postListings(json("POST", "/listings", { near: { latitude: 1, longitude: 1, radiusKm: 5 }, requestId: REQ(1) }), undefined, deps),
    getCategories(json("GET", "/categories"), undefined, deps),
    postFetch(json("POST", "/fetches", { kind: "reviews", businessId: id, depth: 20, requestId: REQ(1) }), undefined, deps),
    listFetches(json("GET", "/fetches"), undefined, deps),
    getFetch(json("GET", `/fetches/${id}`), ctx({ fetchId: id }), deps),
    postSerp(json("POST", "/serp", { keyword: "k", near: { latitude: 1, longitude: 1 }, requestId: REQ(1) }), undefined, deps),
    postGrid(json("POST", "/grids", { keyword: "k", center: { latitude: 1, longitude: 1 }, target: { cid: "1" }, requestId: REQ(1) }), undefined, deps),
    listGrids(json("GET", "/grids"), undefined, deps),
    getGrid(json("GET", `/grids/${id}`), ctx({ gridId: id }), deps),
  ];
  for (const res of await Promise.all(calls)) {
    assert.equal(res.status, 404);
    assert.equal((await res.json()).code, "feature_unavailable");
    assert.equal(res.headers.get("cache-control"), "no-store");
  }
});

test("a disabled spend control is 403 feature_disabled and nothing is saved or bought", async () => {
  const { kit, deps } = setup({ enabled: false, responders: { myBusinessInfo: () => ({ data: infoItem() }) } });
  const res = await postProfile(
    json("POST", "/profile", { identifier: { cid: "123456789" }, save: "own", maxUsd: 0.01, requestId: REQ(2) }),
    undefined,
    deps,
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "feature_disabled");
  assert.equal(kit.store.businesses.size, 0);
  assert.equal(kit.harness.spend.ledger.length, 0);
});

test("grid without maxUsd is 400 approval_required; a lower maxUsd is 409 price_changed; neither spends", async () => {
  const { kit, deps } = setup({ responders: { localTaskPost: () => ({ data: Array(9).fill("t") }) } });
  const body = { keyword: "streetwear store", center: { latitude: 19.076, longitude: 72.8777 }, gridSize: 3, spacingKm: 2, target: { cid: "123" }, requestId: REQ(3) };
  const none = await postGrid(json("POST", "/grids", body), undefined, deps);
  assert.equal(none.status, 400);
  assert.equal((await none.json()).code, "approval_required");
  const low = await postGrid(json("POST", "/grids", { ...body, maxUsd: 0.001 }), undefined, deps);
  assert.equal(low.status, 409);
  assert.equal((await low.json()).code, "price_changed");
  assert.equal(kit.harness.calls.localTaskPost, undefined);
  assert.equal(kit.store.grids.size, 0);
});

test("grid without a target is 400 grid_target_required", async () => {
  const { deps } = setup();
  const res = await postGrid(
    json("POST", "/grids", { keyword: "k", center: { latitude: 1, longitude: 1 }, target: {}, maxUsd: 0.02, requestId: REQ(4) }),
    undefined,
    deps,
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "grid_target_required");
});

test("POST /fetches is 202 while processing, then GET collects for free to 200 completed", async () => {
  const { kit, deps, polls } = setup({
    responders: { reviewsTaskPost: () => ({ data: "rev-task-post-1", costUsd: 0.004 }) },
    taskResults: [pending, pending, pending, pending, pending, done()],
  });
  const business = await savedBusiness(deps);
  const started = await postFetch(
    json("POST", "/fetches", { kind: "reviews", businessId: business.id, depth: 20, maxUsd: 0.01, requestId: REQ(5) }),
    undefined,
    deps,
  );
  assert.equal(started.status, 202);
  const processing = await started.json();
  assert.equal(processing.status, "processing");
  assert.equal(processing.pollAfterSeconds, 5);
  assert.equal(processing.items, null);

  kit.clock.advance(5000);
  const collected = await getFetch(json("GET", `/fetches/${processing.id}`), ctx({ fetchId: processing.id }), deps);
  assert.equal(collected.status, 200);
  const view = await collected.json();
  assert.equal(view.status, "completed");
  assert.equal(view.items.length, 20);
  assert.equal(view.pollAfterSeconds, null);
  assert.equal(view.totals.reviewsCount, 210);
  assert.equal(kit.harness.calls.reviewsTaskPost.length, 1, "GET never buys");
  assert.equal(polls.at(-1).taskId, "rev-task-post-1");

  const list = await listFetches(json("GET", `/fetches?businessId=${business.id}&limit=5`), undefined, deps);
  assert.equal(list.status, 200);
  const { fetches } = await list.json();
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].status, "completed");
});

test("POST /fetches that finishes inline is 200 and a repeat is reused for free", async () => {
  const { kit, deps } = setup({
    responders: { reviewsTaskPost: () => ({ data: "rev-task-post-1", costUsd: 0.004 }) },
    taskResults: [done()],
  });
  const business = await savedBusiness(deps);
  const body = { kind: "reviews", businessId: business.id, depth: 20, maxUsd: 0.01 };
  const first = await postFetch(json("POST", "/fetches", { ...body, requestId: REQ(6) }), undefined, deps);
  assert.equal(first.status, 200);
  const again = await postFetch(json("POST", "/fetches", { ...body, requestId: REQ(7) }), undefined, deps);
  assert.equal(again.status, 200);
  const reused = await again.json();
  assert.equal(reused.reused, true);
  assert.equal(kit.harness.calls.reviewsTaskPost.length, 1);
});

test("a foreign or unknown businessId is 404 business_not_found with no spend", async () => {
  const { kit, deps } = setup({ responders: { reviewsTaskPost: () => ({ data: "x" }) } });
  const res = await postFetch(
    json("POST", "/fetches", { kind: "reviews", businessId: FOREIGN_BUSINESS, depth: 20, maxUsd: 0.01, requestId: REQ(8) }),
    undefined,
    deps,
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "business_not_found");
  assert.equal(kit.harness.calls.reviewsTaskPost, undefined);
  const refresh = await refreshProfile(json("POST", `/businesses/${FOREIGN_BUSINESS}/profile`, { maxUsd: 0.01, requestId: REQ(9) }), ctx({ businessId: FOREIGN_BUSINESS }), deps);
  assert.equal(refresh.status, 404);
  const patch = await patchBusiness(json("PATCH", `/businesses/${FOREIGN_BUSINESS}`, { role: "competitor" }), ctx({ businessId: FOREIGN_BUSINESS }), deps);
  assert.equal(patch.status, 404);
  const del = await deleteBusiness(json("DELETE", `/businesses/${FOREIGN_BUSINESS}`), ctx({ businessId: FOREIGN_BUSINESS }), deps);
  assert.equal(del.status, 404);
  const fetchGet = await getFetch(json("GET", `/fetches/${FOREIGN_BUSINESS}`), ctx({ fetchId: FOREIGN_BUSINESS }), deps);
  assert.equal(fetchGet.status, 404);
  assert.equal((await fetchGet.json()).code, "fetch_not_found");
  const gridGet = await getGrid(json("GET", `/grids/${FOREIGN_BUSINESS}`), ctx({ gridId: FOREIGN_BUSINESS }), deps);
  assert.equal(gridGet.status, 404);
  assert.equal((await gridGet.json()).code, "grid_not_found");
});

test("an extra field, bad JSON, a bad requestId or a wrong depth is 400 on every paid route", async () => {
  const { deps } = setup();
  const id = "11111111-1111-4111-8111-111111111111";
  const cases = [
    postProfile(json("POST", "/profile", { identifier: { cid: "1" }, requestId: REQ(1), extra: true }), undefined, deps),
    postListings(json("POST", "/listings", { near: { latitude: 1, longitude: 1, radiusKm: 5 }, requestId: REQ(1), extra: 1 }), undefined, deps),
    postFetch(json("POST", "/fetches", { kind: "reviews", businessId: id, depth: 20, requestId: REQ(1), extra: 1 }), undefined, deps),
    postFetch(json("POST", "/fetches", { kind: "reviews", businessId: id, depth: 30, requestId: REQ(1) }), undefined, deps),
    postFetch(json("POST", "/fetches", { kind: "updates", businessId: id, depth: 200, requestId: REQ(1) }), undefined, deps),
    postSerp(json("POST", "/serp", { keyword: "k", near: { latitude: 1, longitude: 1 }, requestId: "not-a-uuid" }), undefined, deps),
    postGrid(json("POST", "/grids", { keyword: "k", center: { latitude: 1, longitude: 1 }, target: { cid: "1" }, gridSize: 4, requestId: REQ(1) }), undefined, deps),
    postBusiness(json("POST", "/businesses", { role: "own", title: "A", cid: "1", extra: true }), undefined, deps),
    getCategories(json("GET", "/categories?bogus=1"), undefined, deps),
    listGrids(json("GET", "/grids?limit=500"), undefined, deps),
  ];
  for (const res of await Promise.all(cases)) {
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, "invalid_request");
  }
  const bad = await postProfile(new Request(`${BASE}/profile`, { method: "POST", body: "{not json" }), undefined, deps);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, "invalid_json");
});

test("business CRUD: save 201, list own first, change role, 409 on the eleventh competitor, delete", async () => {
  const { deps } = setup();
  const own = await savedBusiness(deps);
  assert.equal(own.profile, null);
  assert.equal(own.role, "own");
  for (let i = 1; i <= 10; i += 1) await savedBusiness(deps, { role: "competitor", title: `C${i}`, cid: String(i), latitude: undefined, longitude: undefined });
  const eleventh = await postBusiness(json("POST", "/businesses", { role: "competitor", title: "C11", cid: "11" }), undefined, deps);
  assert.equal(eleventh.status, 409);
  assert.equal((await eleventh.json()).code, "competitor_limit");
  const noIdentity = await postBusiness(json("POST", "/businesses", { role: "competitor", title: "No ids" }), undefined, deps);
  assert.equal(noIdentity.status, 400);
  assert.equal((await noIdentity.json()).code, "identifier_required");

  const listed = await (await listBusinesses(json("GET", "/businesses"), undefined, deps)).json();
  assert.equal(listed.businesses.length, 11);
  assert.equal(listed.businesses[0].id, own.id);

  const removed = await deleteBusiness(json("DELETE", `/businesses/${own.id}`), ctx({ businessId: own.id }), deps);
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { removed: true });
  const patched = await patchBusiness(json("PATCH", `/businesses/${listed.businesses[1].id}`, { role: "own" }), ctx({ businessId: listed.businesses[1].id }), deps);
  assert.equal(patched.status, 200);
  assert.equal((await patched.json()).business.role, "own");
});

test("POST /profile prices through F09, saves identity plus the server-fetched profile and answers {profile, businessId}", async () => {
  const { kit, deps } = setup({ responders: { myBusinessInfo: () => ({ data: infoItem(), costUsd: 0.0054 }) } });
  const res = await postProfile(
    json("POST", "/profile", { identifier: { cid: "123456789" }, save: "own", maxUsd: 0.01, requestId: REQ(10) }),
    undefined,
    deps,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.profile.title, "Acme Cafe");
  assert.ok(body.businessId);
  assert.equal(kit.harness.calls.myBusinessInfo[0].keyword, "cid:123456789");
  assert.equal(kit.research.length, 1);
  const refreshed = await refreshProfile(
    json("POST", `/businesses/${body.businessId}/profile`, { maxUsd: 0.01, requestId: REQ(11) }),
    ctx({ businessId: body.businessId }),
    deps,
  );
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).profile.title, "Acme Cafe");
  // A quote above the approved maximum is refused before any call.
  const tooLow = await postProfile(
    json("POST", "/profile", { identifier: { cid: "123456789" }, maxUsd: 0.0001, requestId: REQ(12) }),
    undefined,
    deps,
  );
  assert.equal(tooLow.status, 409);
  assert.equal((await tooLow.json()).code, "price_changed");
  assert.equal(kit.harness.calls.myBusinessInfo.length, 2);
});

test("POST /listings and GET /categories", async () => {
  const listings = fixtureResult("listings-search.json").items;
  const categories = fixture("categories.json").tasks[0].result.map((r) => ({ category: r.category_name, businessCount: r.business_count ?? null }));
  const { kit, deps } = setup({ responders: { businessListings: () => ({ data: listings, costUsd: 0.03 }) } });
  kit.deps.fetchCategories = async () => ({ data: categories, billing: { costUsd: 0, path: [] } });
  deps.fetchCategories = kit.deps.fetchCategories;
  const res = await postListings(
    json("POST", "/listings", { near: { latitude: 37.77, longitude: -122.41, radiusKm: 5 }, limit: 5, maxUsd: 0.05, requestId: REQ(13) }),
    undefined,
    deps,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.businesses.length, 5);
  assert.equal(body.cached, false);
  const cats = await getCategories(json("GET", "/categories?q=coffee&limit=5"), undefined, deps);
  assert.equal(cats.status, 200);
  const catBody = await cats.json();
  assert.ok(catBody.categories.length >= 1);
  assert.ok(catBody.categories.every((c) => c.category.includes("coffee")));
});

test("POST /serp defaults to Maps, mobile, depth 20 and flags the own business", async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ rank_absolute: i + 1, title: `B${i + 1}`, cid: i === 3 ? "123456789" : `9${i}`, domain: `b${i}.example` }));
  const { kit, deps } = setup({ responders: { localSerp: () => ({ data: items, costUsd: 0.002 }) } });
  await savedBusiness(deps);
  const res = await postSerp(
    json("POST", "/serp", { keyword: "streetwear store", near: { latitude: 19.076, longitude: 72.8777 }, requestId: REQ(14) }),
    undefined,
    deps,
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ownRank, 4);
  assert.equal(body.results[3].isOwn, true);
  const call = kit.harness.calls.localSerp[0];
  assert.equal(call.searchType, "maps");
  assert.equal(call.device, "mobile");
  assert.equal(call.depth, 20);
  assert.equal(call.locationCoordinate, "19.076,72.8777,12z");
});

test("POST /grids with an approved price is 202 processing, and GET collects it for free to 200", async () => {
  const ids = Array.from({ length: 9 }, (_, i) => `task-${i}`);
  const { kit, deps } = setup({ responders: { localTaskPost: () => ({ data: ids, costUsd: 0.0108 }) } });
  const business = await savedBusiness(deps);
  const started = await postGrid(
    json("POST", "/grids", {
      keyword: "streetwear store",
      center: { latitude: 19.076, longitude: 72.8777 },
      gridSize: 3,
      spacingKm: 2,
      target: { businessId: business.id },
      maxUsd: 0.02,
      requestId: REQ(15),
    }),
    undefined,
    deps,
  );
  assert.equal(started.status, 202);
  const processing = await started.json();
  assert.equal(processing.status, "processing");
  assert.equal(processing.pointsTotal, 9);
  assert.equal(processing.pollAfterSeconds, 5);
  // Every map search is now ready; collection is free.
  kit.deps.fetchSerpTaskResult = async () => ({
    status: "completed",
    items: [{ rank_absolute: 2, title: "Acme Cafe", cid: "123456789", place_id: "p" }, { rank_absolute: 1, title: "Other", cid: "5" }],
  });
  deps.fetchSerpTaskResult = kit.deps.fetchSerpTaskResult;
  kit.clock.advance(5000);
  const collected = await getGrid(json("GET", `/grids/${processing.id}`), ctx({ gridId: processing.id }), deps);
  assert.equal(collected.status, 200);
  const view = await collected.json();
  assert.equal(view.status, "completed");
  assert.equal(view.summary.pointsFound, 9);
  assert.equal(view.summary.averageRank, 2);
  assert.equal(view.matched.cid, "123456789");
  assert.equal(kit.harness.calls.localTaskPost.length, 1);
  const list = await (await listGrids(json("GET", "/grids"), undefined, deps)).json();
  assert.equal(list.grids.length, 1);
  assert.equal(list.grids[0].status, "completed");
});

test("a grid whose searches all fail is 502 local_grid_failed", async () => {
  const ids = Array.from({ length: 9 }, (_, i) => `task-${i}`);
  const { kit, deps } = setup({ responders: { localTaskPost: () => ({ data: ids }) } });
  deps.fetchSerpTaskResult = async () => ({ status: "failed", message: "refused" });
  const res = await postGrid(
    json("POST", "/grids", {
      keyword: "k",
      center: { latitude: 19.076, longitude: 72.8777 },
      target: { cid: "5" },
      maxUsd: 0.02,
      requestId: REQ(16),
    }),
    undefined,
    deps,
  );
  assert.equal(res.status, 502);
  assert.equal((await res.json()).code, "local_grid_failed");
  assert.equal(kit.harness.calls.localTaskPost.length, 1);
});
