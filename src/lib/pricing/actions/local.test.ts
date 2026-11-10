import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  estimateLocalGridRun,
  estimateLocalListingsSearch,
  estimateLocalProfileLookup,
  estimateLocalReviewsCollect,
  localGridRunAction,
  localListingsSearchAction,
  localProfileLookupAction,
  localQuestionsCollectAction,
  localReviewsCollectAction,
  localSerpSearchAction,
  localUpdatesCollectAction,
} from "./local.ts";
import { getPricedAction, type PricingContext } from "../pricedActions.ts";

const dummyCtx: PricingContext = {
  brandKey: "test-brand",
  admin: null as any,
  env: {},
  now: new Date("2026-11-10T12:00:00Z"),
};

describe("Local SEO priced actions (F17 §6.2.9)", () => {
  it("registers all 7 actions in the priced action registry", () => {
    assert.ok(getPricedAction("local.profile.lookup"));
    assert.ok(getPricedAction("local.listings.search"));
    assert.ok(getPricedAction("local.reviews.collect"));
    assert.ok(getPricedAction("local.updates.collect"));
    assert.ok(getPricedAction("local.questions.collect"));
    assert.ok(getPricedAction("local.serp.search"));
    assert.ok(getPricedAction("local.grid.run"));
  });

  it("local.profile.lookup: prices profile at $0.0054 and checks recent research warning", async () => {
    assert.equal(localProfileLookupAction.requireApproval, false);
    assert.equal(localProfileLookupAction.feature, "local.business");

    const res = await localProfileLookupAction.estimate(dummyCtx, {
      identifier: { cid: "123456789" },
    });
    assert.equal(res.totalUsd, 0.0054);
    assert.equal(res.lines[0]?.label, "Google Business Profile lookup");
    assert.equal(res.lines[0]?.totalUsd, 0.0054);
    assert.equal(res.warnings.length, 0);

    // With recent research
    const resRecent = await estimateLocalProfileLookup(
      dummyCtx,
      { identifier: { cid: "123456789" } },
      { hasRecentResearch: async () => true },
    );
    assert.equal(resRecent.warnings.some((w) => w.code === "recent_research"), true);
  });

  it("local.listings.search: 20 results → $0.0192 and cache note warning", async () => {
    assert.equal(localListingsSearchAction.requireApproval, false);
    assert.equal(localListingsSearchAction.feature, "local.business");

    const res = await localListingsSearchAction.estimate(dummyCtx, {
      near: { latitude: 37.77, longitude: -122.41, radiusKm: 10 },
      limit: 20,
      offset: 0,
    });
    // 0.012 + 20 * 0.00036 = 0.0192
    assert.equal(res.totalUsd, 0.0192);
    assert.equal(res.lines[0]?.label, "Up to 20 nearby businesses");
    assert.equal(res.lines[0]?.totalUsd, 0.0192);
    assert.equal(res.warnings.some((w) => w.code === "cache_note"), true);

    // Cache hit → 0
    const resCached = await estimateLocalListingsSearch(
      dummyCtx,
      { near: { latitude: 37.77, longitude: -122.41, radiusKm: 10 }, limit: 20, offset: 0 },
      { isCacheHit: async () => true },
    );
    assert.equal(resCached.totalUsd, 0);
  });

  it("local.reviews.collect: 20 → 0.004, 200 → 0.031, other sites 20 → 0.01", async () => {
    assert.equal(localReviewsCollectAction.requireApproval, false);
    assert.equal(localReviewsCollectAction.feature, "local.reviews");

    // depth 20: 0.001 + 2 * 0.0015 = 0.004
    const res20 = await localReviewsCollectAction.estimate(dummyCtx, {
      businessId: "11111111-1111-1111-1111-111111111111",
      depth: 20,
      includeOtherSources: false,
    });
    assert.equal(res20.totalUsd, 0.004);
    assert.equal(res20.lines[0]?.label, "Collect up to 20 Google reviews");

    // depth 200: 0.001 + 20 * 0.0015 = 0.031
    const res200 = await localReviewsCollectAction.estimate(dummyCtx, {
      businessId: "11111111-1111-1111-1111-111111111111",
      depth: 200,
      includeOtherSources: false,
    });
    assert.equal(res200.totalUsd, 0.031);
    assert.equal(res200.lines[0]?.label, "Collect up to 200 Google reviews");

    // other sites 20: 1 * 0.01 = 0.01
    const resOther20 = await localReviewsCollectAction.estimate(dummyCtx, {
      businessId: "11111111-1111-1111-1111-111111111111",
      depth: 20,
      includeOtherSources: true,
    });
    assert.equal(resOther20.totalUsd, 0.01);
    assert.equal(resOther20.lines[0]?.label, "Collect up to 20 reviews from Google and other sites");

    // reuse hit → total 0, warning reuse_note
    const resReuse = await estimateLocalReviewsCollect(
      dummyCtx,
      { businessId: "11111111-1111-1111-1111-111111111111", depth: 20, includeOtherSources: false },
      { findReuse: async () => ({ minutesAgo: 15 }) },
    );
    assert.equal(resReuse.totalUsd, 0);
    assert.equal(resReuse.warnings.some((w) => w.code === "reuse_note"), true);
  });

  it("local.updates.collect: 10 → 0.0045", async () => {
    assert.equal(localUpdatesCollectAction.requireApproval, false);
    assert.equal(localUpdatesCollectAction.feature, "local.business");

    // 0.003 + 1 * 0.0015 = 0.0045
    const res = await localUpdatesCollectAction.estimate(dummyCtx, {
      businessId: "11111111-1111-1111-1111-111111111111",
      depth: 10,
    });
    assert.equal(res.totalUsd, 0.0045);
    assert.equal(res.lines[0]?.label, "Collect up to 10 profile posts");
  });

  it("local.questions.collect: 20 → 0.0054", async () => {
    assert.equal(localQuestionsCollectAction.requireApproval, false);
    assert.equal(localQuestionsCollectAction.feature, "local.business");

    // 1 * 0.0054 = 0.0054
    const res = await localQuestionsCollectAction.estimate(dummyCtx, {
      businessId: "11111111-1111-1111-1111-111111111111",
      depth: 20,
    });
    assert.equal(res.totalUsd, 0.0054);
    assert.equal(res.lines[0]?.label, "Collect up to 20 questions and answers");
  });

  it("local.serp.search: Maps → 0.002, Local Finder 20 → 0.004", async () => {
    assert.equal(localSerpSearchAction.requireApproval, false);
    assert.equal(localSerpSearchAction.feature, "local.serp");

    // Maps
    const resMaps = await localSerpSearchAction.estimate(dummyCtx, {
      keyword: "streetwear",
      near: { latitude: 40, longitude: -74, zoom: 12 },
      searchType: "maps",
      device: "mobile",
      depth: 20,
    });
    assert.equal(resMaps.totalUsd, 0.002);
    assert.equal(resMaps.lines[0]?.label, "Google Maps results for “streetwear”");
    assert.equal(resMaps.warnings.some((w) => w.code === "cache_note"), true);

    // Local Finder
    const resLf = await localSerpSearchAction.estimate(dummyCtx, {
      keyword: "streetwear",
      near: { latitude: 40, longitude: -74, zoom: 12 },
      searchType: "local_finder",
      device: "mobile",
      depth: 20,
    });
    assert.equal(resLf.totalUsd, 0.004);
    assert.equal(resLf.lines[0]?.label, "Local Finder results for “streetwear”");
  });

  it("local.grid.run: 3×3 → 0.0108, 5×5 → 0.03, requires approval, blocks at local_grid_limit", async () => {
    assert.equal(localGridRunAction.requireApproval, true);
    assert.equal(localGridRunAction.feature, "local.grid");

    // 3x3: 9 * 0.0012 = 0.0108
    const res3x3 = await localGridRunAction.estimate(dummyCtx, {
      keyword: "cafe",
      center: { latitude: 40, longitude: -74 },
      gridSize: 3,
      spacingKm: 2,
      device: "mobile",
    });
    assert.equal(res3x3.totalUsd, 0.0108);
    assert.equal(res3x3.lines[0]?.label, "9 Google Maps searches (3×3 grid, 2 km apart)");
    assert.equal(res3x3.warnings.some((w) => w.code === "center_note"), true);
    assert.equal(res3x3.warnings.some((w) => w.code === "grid_size_note"), false);
    assert.equal(res3x3.blocked, null);

    // 5x5: 25 * 0.0012 = 0.03
    const res5x5 = await localGridRunAction.estimate(dummyCtx, {
      keyword: "cafe",
      center: { latitude: 40, longitude: -74 },
      gridSize: 5,
      spacingKm: 2,
      device: "mobile",
    });
    assert.equal(res5x5.totalUsd, 0.03);
    assert.equal(res5x5.lines[0]?.label, "25 Google Maps searches (5×5 grid, 2 km apart)");
    assert.equal(res5x5.warnings.some((w) => w.code === "grid_size_note"), true);

    // local_grid_limit blocked when >= 20 runs today
    const resBlocked = await estimateLocalGridRun(
      dummyCtx,
      { keyword: "cafe", center: { latitude: 40, longitude: -74 }, gridSize: 3, spacingKm: 2, device: "mobile" },
      { checkGridLimitToday: async () => 20 },
    );
    assert.ok(resBlocked.blocked);
    assert.equal(resBlocked.blocked.code, "local_grid_limit");
    assert.equal(resBlocked.blocked.message, "This workspace has run 20 map grids today. Try again tomorrow.");
  });
});
