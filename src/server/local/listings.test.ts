// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/local-seo-tools.test.ts:448 (categories cached and filtered in memory)
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SpendRefused } from "../../shared/spend/errors.ts";
import { saveBusiness } from "./businesses.ts";
import { buildListingsFilters, listBusinessCategories, listingsOrderBy, searchLocalBusinesses } from "./listings.ts";
import { fixture, fixtureResult, localKit, makeWs } from "./testKit.ts";

const ws = makeWs();
const near = { latitude: 37.77, longitude: -122.41, radiusKm: 2.6 };
const REQ = "33333333-3333-4333-8333-333333333333";

function listingsItems(): unknown[] {
  return fixtureResult("listings-search.json").items;
}

test("minRating and minReviews become filters joined with and; sortBy becomes order_by", () => {
  assert.deepEqual(buildListingsFilters({ minRating: 4, minReviews: 50 }), [
    ["rating.value", ">=", 4],
    "and",
    ["rating.votes_count", ">=", 50],
  ]);
  assert.deepEqual(buildListingsFilters({ minRating: 4 }), [["rating.value", ">=", 4]]);
  assert.equal(buildListingsFilters({}), undefined);
  assert.deepEqual(listingsOrderBy("rating"), ["rating.value,desc"]);
  assert.deepEqual(listingsOrderBy("reviews"), ["rating.votes_count,desc"]);
  assert.equal(listingsOrderBy("relevance"), undefined);
  assert.equal(listingsOrderBy(undefined), undefined);
});

test("search maps inputs to the provider call, trims rows and records the search", async () => {
  const kit = localKit({ businessListings: () => ({ data: listingsItems(), costUsd: 0.03 }) });
  const out = await searchLocalBusinesses(
    ws,
    { near, query: "coffee", categories: ["coffee_shop"], minRating: 4.5, minReviews: 100, isClaimed: true, sortBy: "reviews", limit: 5, offset: 0, maxUsd: 0.05, requestId: REQ },
    kit.deps,
  );
  const call = kit.harness.calls.businessListings?.[0];
  assert.equal(call.locationCoordinate, "37.77,-122.41,3"); // 2.6 km rounds to whole km
  assert.equal(call.title, "coffee");
  assert.deepEqual(call.categories, ["coffee_shop"]);
  assert.equal(call.isClaimed, true);
  assert.deepEqual(call.orderBy, ["rating.votes_count,desc"]);
  assert.deepEqual(call.filters, [["rating.value", ">=", 4.5], "and", ["rating.votes_count", ">=", 100]]);
  assert.equal(out.cached, false);
  assert.equal(out.businesses.length, 5);
  assert.equal(out.businesses[0]?.title, "Business 1");
  assert.equal(out.businesses[0]?.rating, 4.8);
  assert.equal(out.businesses[0]?.votes, 120);
  assert.equal(out.businesses[0]?.isSaved, null);
  assert.equal(kit.harness.spend.ledger[0]?.feature, "local.business");
  assert.equal(kit.store.searches.length, 1);
  assert.equal(kit.store.searches[0]?.kind, "listings");
  assert.equal(kit.store.searches[0]?.resultCount, 5);
  assert.equal(kit.store.searches[0]?.cached, false);
  assert.equal(kit.store.searches[0]?.cacheKey.length, 64);
});

test("a repeat within 24 hours is a cache hit with no spend", async () => {
  const kit = localKit({ businessListings: () => ({ data: listingsItems(), costUsd: 0.03 }) });
  const input = { near, limit: 20, offset: 0, maxUsd: 0.05, requestId: REQ };
  await searchLocalBusinesses(ws, input, kit.deps);
  const second = await searchLocalBusinesses(ws, { ...input, requestId: "44444444-4444-4444-8444-444444444444" }, kit.deps);
  assert.equal(second.cached, true);
  assert.equal(kit.harness.calls.businessListings?.length, 1);
  assert.equal(kit.harness.spend.ledger.length, 1);
  assert.equal(kit.store.searches[1]?.cached, true);
  // The cache is global: another workspace gets the same rows for free.
  const other = await searchLocalBusinesses(makeWs("other.example"), { ...input, requestId: "55555555-5555-4555-8555-555555555555" }, kit.deps);
  assert.equal(other.cached, true);
  assert.equal(kit.harness.calls.businessListings?.length, 1);
});

test("an empty result is not cached, so a retry can buy again", async () => {
  const kit = localKit({ businessListings: () => ({ data: [], costUsd: 0.012 }) });
  const input = { near, limit: 20, offset: 0, maxUsd: 0.05, requestId: REQ };
  await searchLocalBusinesses(ws, input, kit.deps);
  await searchLocalBusinesses(ws, { ...input, requestId: "44444444-4444-4444-8444-444444444444" }, kit.deps);
  assert.equal(kit.harness.calls.businessListings?.length, 2);
});

test("rows matching a saved business carry isSaved", async () => {
  const kit = localKit({ businessListings: () => ({ data: listingsItems() }) });
  await saveBusiness(ws, { role: "own", title: "Business 1", cid: "1001" }, kit.deps);
  await saveBusiness(ws, { role: "competitor", title: "Business 2", placeId: "place_1002" }, kit.deps);
  const out = await searchLocalBusinesses(ws, { near, limit: 20, offset: 0, maxUsd: 0.05, requestId: REQ }, kit.deps);
  assert.deepEqual(out.businesses.slice(0, 3).map((b) => b.isSaved), ["own", "competitor", null]);
});

test("a disabled spend control refuses before any provider call", async () => {
  const kit = localKit({ businessListings: () => ({ data: listingsItems() }) }, {}, { enabled: false });
  await assert.rejects(
    searchLocalBusinesses(ws, { near, limit: 20, offset: 0, maxUsd: 0.05, requestId: REQ }, kit.deps),
    (err: unknown) => err instanceof SpendRefused && err.reason === "feature_disabled",
  );
  assert.equal(kit.harness.calls.businessListings, undefined);
});

test("categories are fetched once, cached for 7 days and filtered in memory", async () => {
  let reads = 0;
  const categories = fixtureCategories();
  const kit = localKit({}, {
    fetchCategories: async () => {
      reads += 1;
      return { data: categories, billing: { costUsd: 0, path: ["v3", "business_data", "business_listings", "categories"] } };
    },
  });
  const coffee = await listBusinessCategories({ query: "COFFEE", limit: 50 }, kit.deps);
  assert.ok(coffee.categories.length >= 1);
  assert.ok(coffee.categories.every((c) => c.category.toLowerCase().includes("coffee")));
  assert.equal(coffee.total, coffee.categories.length);
  const limited = await listBusinessCategories({ limit: 3 }, kit.deps);
  assert.equal(limited.categories.length, 3);
  assert.equal(limited.total, categories.length);
  assert.equal(reads, 1, "second call is served from the cache");
  assert.equal(kit.harness.spend.ledger.length, 0, "categories are free and never metered");
});

function fixtureCategories(): Array<{ category: string; businessCount: number | null }> {
  // categories.json keeps its rows directly under tasks[0].result
  const raw: Array<{ category_name: string; business_count?: number | null }> = fixture("categories.json").tasks[0].result;
  return raw.map((r: { category_name: string; business_count?: number | null }) => ({
    category: r.category_name,
    businessCount: r.business_count ?? null,
  }));
}

