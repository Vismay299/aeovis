// F17-AC-12 quote half: the registered priced actions carry recent_research,
// zero-total reuse and the daily grid block through the real quote() path.

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import "../../shared/pricing/actions/local.ts";
import { AppError } from "../../shared/http/appError.ts";
import { quote, requireApprovedPrice, type PricingContext } from "../../shared/pricing/pricedActions.ts";
import { saveBusiness } from "./businesses.ts";
import { startFetch } from "./fetches.ts";
import { startGrid } from "./grid.ts";
import { searchLocalBusinesses } from "./listings.ts";
import { lookupBusinessProfile } from "./profile.ts";
import { setLocalQuoteSources } from "./quoteDeps.ts";
import { fixtureResult, localKit, makeWs, type LocalKit } from "./testKit.ts";

const ws = makeWs();
const DAY = 86_400_000;
const REQ = (n: number) => `${String(n).padStart(8, "0")}-eeee-4eee-8eee-${String(n).padStart(12, "0")}`;

afterEach(() => setLocalQuoteSources(null));

type LogEntry = { brandKey: string; kind: string; researchKey?: string; summary: string; at: number };

/** A kit whose research log can be read back the way F07 findRecentResearch does (kind, key, days). */
function kitWithLog(responders: Parameters<typeof localKit>[0] = {}, extra: Parameters<typeof localKit>[1] = {}) {
  const log: LogEntry[] = [];
  let kit!: LocalKit;
  kit = localKit(responders, {
    appendResearch: async (_admin, input) => {
      log.push({ brandKey: input.brandKey, kind: input.kind, researchKey: input.researchKey, summary: input.summary, at: kit.clock.now() });
    },
    ...extra,
  });
  setLocalQuoteSources({
    store: kit.store,
    cacheDeps: kit.deps.cacheDeps,
    findRecentResearch: async (_admin, input) => {
      const since = kit.clock.now() - (input.days ?? 90) * DAY;
      const hit = log.find(
        (e) => e.brandKey === input.brandKey && e.kind === input.kind && e.researchKey === input.researchKey && e.at >= since,
      );
      return hit
        ? { id: "r1", entryDate: new Date(hit.at).toISOString().slice(0, 10), summary: hit.summary, spendUsd: null, createdAt: new Date(hit.at).toISOString() }
        : null;
    },
  });
  return { kit, log };
}

const ctxFor = (kit: LocalKit, brandKey = ws.brandKey): PricingContext => ({
  brandKey,
  admin: {} as never,
  env: {},
  now: new Date(kit.clock.now()),
});

const infoItem = () => {
  const result = fixtureResult("business-info.json");
  return { ...result.items[0], check_url: result.check_url };
};

test("a profile quote carries recent_research after a logged lookup within 90 days, and not otherwise", async () => {
  const { kit } = kitWithLog({ myBusinessInfo: () => ({ data: infoItem(), costUsd: 0.0054 }) });
  const input = { identifier: { cid: "123456789" } };

  const before = await quote("local.profile.lookup", ctxFor(kit), input);
  assert.equal(before.warnings.some((w) => w.code === "recent_research"), false, "nothing logged yet");

  await lookupBusinessProfile(ws, { identifier: { cid: "123456789" }, requestId: REQ(1), maxUsd: 0.01 }, kit.deps);

  const after = await quote("local.profile.lookup", ctxFor(kit), input);
  assert.equal(after.warnings.some((w) => w.code === "recent_research"), true, "the same lookup ran moments ago");
  assert.equal(after.totalUsd, 0.0054, "a repeat purchase is still priced; only the hint is added");

  const other = await quote("local.profile.lookup", ctxFor(kit), { identifier: { cid: "999" } });
  assert.equal(other.warnings.some((w) => w.code === "recent_research"), false, "a different business is a different lookup");

  const otherWorkspace = await quote("local.profile.lookup", ctxFor(kit, "other.example"), input);
  assert.equal(otherWorkspace.warnings.some((w) => w.code === "recent_research"), false, "research logs are per workspace");

  kit.clock.advance(91 * DAY);
  const stale = await quote("local.profile.lookup", ctxFor(kit), input);
  assert.equal(stale.warnings.some((w) => w.code === "recent_research"), false, "older than 90 days");
});

test("a name lookup is matched by name", async () => {
  const { kit } = kitWithLog({ myBusinessInfo: () => ({ data: infoItem() }) });
  await lookupBusinessProfile(ws, { identifier: { businessName: "Acme Cafe" }, requestId: REQ(2), maxUsd: 0.01 }, kit.deps);
  const byName = await quote("local.profile.lookup", ctxFor(kit), { identifier: { businessName: "Acme Cafe" } });
  assert.equal(byName.warnings.some((w) => w.code === "recent_research"), true);
});

test("a reviews quote is free with a reuse_note while an identical fetch is inside 60 minutes", async () => {
  const { kit } = kitWithLog(
    { reviewsTaskPost: () => ({ data: "rev-task-post-1", costUsd: 0.004 }) },
    { fetchTaskResult: (async () => ({ status: "completed", result: fixtureResult("reviews-task-get-done.json") })) as never },
  );
  const business = await saveBusiness(ws, { role: "own", title: "Acme Cafe", cid: "123456789", latitude: 37.7, longitude: -122.4 }, kit.deps);
  const input = { businessId: business.id, depth: 20 as const, includeOtherSources: false };

  const first = await quote("local.reviews.collect", ctxFor(kit), input);
  assert.equal(first.totalUsd, 0.004);
  assert.equal(first.warnings.length, 0);

  await startFetch(ws, { kind: "reviews", businessId: business.id, depth: 20, maxUsd: 0.01, requestId: REQ(3) }, kit.deps);

  kit.clock.advance(12 * 60_000);
  const reused = await quote("local.reviews.collect", ctxFor(kit), input);
  assert.equal(reused.totalUsd, 0);
  const note = reused.warnings.find((w) => w.code === "reuse_note");
  assert.match(note?.message ?? "", /You collected these reviews 12 minutes ago\. That result is reused at no cost\./);

  const deeper = await quote("local.reviews.collect", ctxFor(kit), { ...input, depth: 50 as const });
  assert.ok(deeper.totalUsd > 0, "a different depth is a new purchase");
  const otherSites = await quote("local.reviews.collect", ctxFor(kit), { ...input, includeOtherSources: true });
  assert.ok(otherSites.totalUsd > 0, "other sites use a different fetch kind");
  const otherSort = await quote("local.reviews.collect", ctxFor(kit), { ...input, sortBy: "lowest_rating" as const });
  assert.ok(otherSort.totalUsd > 0, "a different sort is a new purchase");

  kit.clock.advance(50 * 60_000);
  const expired = await quote("local.reviews.collect", ctxFor(kit), input);
  assert.equal(expired.totalUsd, 0.004, "62 minutes later it is priced again");
});

test("a quote and the service agree on reuse: after the business changes, the quote is full price and the service buys with the approved maxUsd", async () => {
  const { kit } = kitWithLog(
    { reviewsTaskPost: () => ({ data: "rev-task-post-1", costUsd: 0.004 }) },
    { fetchTaskResult: (async () => ({ status: "completed", result: fixtureResult("reviews-task-get-done.json") })) as never },
  );
  const business = await saveBusiness(ws, { role: "own", title: "Acme Cafe", cid: "123456789", latitude: 37.7, longitude: -122.4 }, kit.deps);
  const input = { businessId: business.id, depth: 20 as const, includeOtherSources: false };
  const body = { kind: "reviews" as const, businessId: business.id, depth: 20 };
  const buy = async (n: number) => {
    // The route flow: quote, take the approved maximum (omitted maxUsd means the quoted total), then call the service.
    const approved = await requireApprovedPrice("local.reviews.collect", ctxFor(kit), input, undefined);
    const view = await startFetch(ws, { ...body, maxUsd: approved.approvedMaxUsd, requestId: REQ(n) }, kit.deps);
    return { approved, view };
  };

  const first = await buy(10);
  assert.equal(first.approved.approvedMaxUsd, 0.004);
  assert.equal(first.view.reused, false);

  // Identical inputs: the quote is 0 and the service reuses (no spend, no spend_invalid).
  const again = await buy(11);
  assert.equal(again.approved.approvedMaxUsd, 0);
  assert.equal(again.view.reused, true);
  assert.equal(again.view.id, first.view.id);
  assert.equal(kit.harness.calls.reviewsTaskPost?.length, 1);

  // The business's coordinates change: a different reuse hash. The quote must be full price and the purchase must succeed.
  await kit.store.saveBusiness({ brandKey: ws.brandKey, role: "own", title: "Acme Cafe", cid: "123456789", latitude: 40.1, longitude: -73.9, actor: null });
  const moved = await quote("local.reviews.collect", ctxFor(kit), input);
  assert.equal(moved.totalUsd, 0.004, "no reuse_note and no free quote");
  assert.equal(moved.warnings.some((w) => w.code === "reuse_note"), false);
  const third = await buy(12);
  assert.equal(third.approved.approvedMaxUsd, 0.004);
  assert.equal(third.view.reused, false);
  assert.notEqual(third.view.id, first.view.id);
  assert.equal(kit.harness.calls.reviewsTaskPost?.length, 2, "bought once more, with the approved maximum");

  // A different business never matches.
  const business2 = await saveBusiness(ws, { role: "competitor", title: "Other", placeId: "ChIJ-other", latitude: 1, longitude: 1 }, kit.deps);
  const other = await quote("local.reviews.collect", ctxFor(kit), { businessId: business2.id, depth: 20 as const, includeOtherSources: false });
  assert.equal(other.totalUsd, 0.004, "a different business never matches");
});

test("the fetch quote is full price when the exact hash cannot be computed", async () => {
  const { kit } = kitWithLog(
    { reviewsTaskPost: () => ({ data: "rev-task-post-1", costUsd: 0.004 }) },
    { fetchTaskResult: (async () => ({ status: "completed", result: fixtureResult("reviews-task-get-done.json") })) as never },
  );
  // No coordinate and no location_code: the service falls back to the workspace market, which a quote cannot see.
  const business = await saveBusiness(ws, { role: "own", title: "Acme Cafe", cid: "123456789" }, kit.deps);
  await startFetch(ws, { kind: "reviews", businessId: business.id, depth: 20, maxUsd: 0.01, requestId: REQ(20) }, kit.deps);
  const input = { businessId: business.id, depth: 20 as const, includeOtherSources: false };
  assert.equal((await quote("local.reviews.collect", ctxFor(kit), input)).totalUsd, 0.004, "never 0 unless the service will reuse");
  const unknown = await quote("local.reviews.collect", ctxFor(kit), { ...input, businessId: "11111111-1111-4111-8111-111111111111" });
  assert.equal(unknown.totalUsd, 0.004);
  // With a stored location code the hash is exact again, and the quote is free.
  await kit.store.saveBusiness({ brandKey: ws.brandKey, role: "own", title: "Acme Cafe", cid: "123456789", locationCode: 2840, actor: null });
  const located = await saveBusiness(ws, { role: "competitor", title: "Located", cid: "555", locationCode: 2840 }, kit.deps);
  await startFetch(ws, { kind: "reviews", businessId: located.id, depth: 20, maxUsd: 0.01, requestId: REQ(21) }, kit.deps);
  const free = await quote("local.reviews.collect", ctxFor(kit), { businessId: located.id, depth: 20 as const, includeOtherSources: false });
  assert.equal(free.totalUsd, 0);
});

test("a listings quote is 0 on a cache hit and full price on a miss", async () => {
  const listings = fixtureResult("listings-search.json").items;
  const { kit } = kitWithLog({ businessListings: () => ({ data: listings, costUsd: 0.03 }) });
  const near = { latitude: 37.77, longitude: -122.41, radiusKm: 5 };
  const input = { near, limit: 20, offset: 0 };

  const miss = await quote("local.listings.search", ctxFor(kit), input);
  assert.equal(miss.totalUsd, 0.0192);

  await searchLocalBusinesses(ws, { near, limit: 20, offset: 0, maxUsd: 0.05, requestId: REQ(4) }, kit.deps);
  const hit = await quote("local.listings.search", ctxFor(kit), input);
  assert.equal(hit.totalUsd, 0);
  assert.ok(hit.warnings.some((w) => w.code === "cache_note"));

  const other = await quote("local.listings.search", ctxFor(kit), { ...input, offset: 20 });
  assert.equal(other.totalUsd, 0.0192, "another page is another cache entry");
});

test("the grid quote is blocked with local_grid_limit at 20 grids today, and requireApprovedPrice refuses it", async () => {
  const { kit } = kitWithLog();
  const input = { keyword: "streetwear store", center: { latitude: 19.076, longitude: 72.8777 }, gridSize: 3 as const, spacingKm: 2, device: "mobile" as const };
  const seed = async (count: number) => {
    for (let i = 0; i < count; i += 1) {
      await kit.store.insertGrid({
        brandKey: ws.brandKey, requestId: REQ(100 + i), businessId: null, keyword: `k${i}`, centerLat: 1, centerLng: 1, gridSize: 3,
        spacingKm: 2, zoom: 13, device: "mobile", languageCode: "en", target: { cid: "1" }, paramsHash: String(i).padStart(64, "0"), requestedBy: null,
      });
    }
  };
  await seed(19);
  const open = await quote("local.grid.run", ctxFor(kit), input);
  assert.equal(open.blocked, null);
  assert.equal(open.totalUsd, 0.0108);

  await kit.store.insertGrid({
    brandKey: ws.brandKey, requestId: REQ(200), businessId: null, keyword: "k", centerLat: 1, centerLng: 1, gridSize: 3, spacingKm: 2, zoom: 13,
    device: "mobile", languageCode: "en", target: { cid: "1" }, paramsHash: "a".repeat(64), requestedBy: null,
  });
  const blocked = await quote("local.grid.run", ctxFor(kit), input);
  assert.equal(blocked.blocked?.code, "local_grid_limit");
  await assert.rejects(
    requireApprovedPrice("local.grid.run", ctxFor(kit), input, 0.02),
    (err: unknown) => err instanceof AppError && err.code === "local_grid_limit",
  );

  const elsewhere = await quote("local.grid.run", ctxFor(kit, "other.example"), input);
  assert.equal(elsewhere.blocked, null, "the limit is per workspace");
  kit.clock.advance(DAY);
  const tomorrow = await quote("local.grid.run", ctxFor(kit), input);
  assert.equal(tomorrow.blocked, null, "the count resets at the UTC day boundary");
});

test("quotes fail soft: no workspace client and no sources means the plain phase-1 quote", async () => {
  setLocalQuoteSources(null);
  const ctx: PricingContext = { brandKey: "b", admin: null as never, env: {}, now: new Date("2026-11-10T12:00:00Z") };
  const profile = await quote("local.profile.lookup", ctx, { identifier: { cid: "1" } });
  assert.deepEqual(profile.warnings, []);
  const grid = await quote("local.grid.run", ctx, { keyword: "k", center: { latitude: 1, longitude: 1 } });
  assert.equal(grid.blocked, null);

  setLocalQuoteSources({
    store: { listFetches: async () => { throw new Error("db down"); }, countGridsSince: async () => { throw new Error("db down"); } } as never,
    findRecentResearch: async () => { throw new Error("db down"); },
  });
  const failing: PricingContext = { ...ctx, admin: {} as never };
  assert.equal((await quote("local.profile.lookup", failing, { identifier: { cid: "1" } })).warnings.length, 0);
  assert.equal((await quote("local.reviews.collect", failing, { businessId: "11111111-1111-4111-8111-111111111111", depth: 20 })).totalUsd, 0.004);
  assert.equal((await quote("local.grid.run", failing, { keyword: "k", center: { latitude: 1, longitude: 1 } })).blocked, null);
});

test("a grid run is still free through the service when reused, even though the quote is priced", async () => {
  // Documents the boundary: the grid estimate has no reuse hook, so only the service skips the spend.
  const { kit } = kitWithLog({ localTaskPost: () => ({ data: Array.from({ length: 9 }, (_, i) => `t${i}`), costUsd: 0.0108 }) }, {
    fetchSerpTaskResult: (async () => ({ status: "completed", items: [{ rank_absolute: 1, title: "A", cid: "5" }] })) as never,
  });
  const base = { keyword: "k", center: { latitude: 19.076, longitude: 72.8777 }, gridSize: 3 as const, spacingKm: 2, device: "mobile" as const, target: { cid: "5" }, maxUsd: 0.02 };
  await startGrid(ws, { ...base, requestId: REQ(300) }, kit.deps);
  const again = await startGrid(ws, { ...base, requestId: REQ(301) }, kit.deps);
  assert.equal(again.reused, true);
  assert.equal(kit.harness.calls.localTaskPost?.length, 1);
});
