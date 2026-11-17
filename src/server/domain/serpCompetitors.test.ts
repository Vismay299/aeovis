import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  findSerpCompetitors,
  sortCompetitors,
  hostMatchesDomain,
  type SerpCompetitorsDeps,
} from "./serpCompetitors.ts";
import { createMemoryCacheStore } from "../cache/memoryStore.ts";
import type { LabsClient } from "../../shared/providers/dataforseo/labs.ts";

function loadFixture<T>(filename: string): T {
  const filePath = join(process.cwd(), "tests/fixtures/f14", filename);
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

function createHarness() {
  const store = createMemoryCacheStore();
  const cacheDeps = {
    store,
    keepAlive: ((work: unknown) => Promise.resolve(work)) as typeof import("../keepAlive.js").keepAlive,
  };

  const calls: Array<{ ctx: any; input: any }> = [];
  const competitorsFixture = loadFixture<any>("labs-serp-competitors.json");
  let competitorsResponse = competitorsFixture;

  const fakeLabs: LabsClient = {
    keywords: {} as any,
    domain: {} as any,
    labs: {
      keywordOverview: async () => ({} as any),
      serpCompetitors: (async (ctx: any, input: any) => {
        calls.push({ ctx, input });
        return competitorsResponse;
      }) as any,
    },
  };

  const deps: SerpCompetitorsDeps = {
    labs: fakeLabs,
    brandKey: "brand_test",
    requestId: "req_123",
    cacheDeps,
  };

  return {
    deps,
    calls,
    setCompetitorsResponse: (r: any) => {
      competitorsResponse = r;
    },
  };
}

describe("serpCompetitors", () => {
  it("hostMatchesDomain matches exact host, www prefix, and subdomains", () => {
    assert.equal(hostMatchesDomain("offcult.in", "offcult.in"), true);
    assert.equal(hostMatchesDomain("www.offcult.in", "offcult.in"), true);
    assert.equal(hostMatchesDomain("blog.offcult.in", "offcult.in"), true);
    assert.equal(hostMatchesDomain("offcult.in", "www.offcult.in"), true);
    assert.equal(hostMatchesDomain("notoffcult.in", "offcult.in"), false);
    assert.equal(hostMatchesDomain("bewakoof.com", "offcult.in"), false);
  });

  it("sortCompetitors correctly sorts by all four sort modes", () => {
    const items = [
      { domain: "a.com", visibility: 0.2, etv: 1000, avgPosition: 5.5, keywordsCount: 30 },
      { domain: "b.com", visibility: 0.5, etv: 500, avgPosition: 2.1, keywordsCount: 10 },
      { domain: "c.com", visibility: 0.1, etv: 2500, avgPosition: 8.0, keywordsCount: 50 },
    ];

    // visibility: desc
    const byVisibility = sortCompetitors(items, "visibility");
    assert.deepEqual(
      byVisibility.map((i) => i.domain),
      ["b.com", "a.com", "c.com"],
    );

    // traffic_estimate: desc
    const byTraffic = sortCompetitors(items, "traffic_estimate");
    assert.deepEqual(
      byTraffic.map((i) => i.domain),
      ["c.com", "a.com", "b.com"],
    );

    // avg_position: asc (lowest number is best rank)
    const byAvgPos = sortCompetitors(items, "avg_position");
    assert.deepEqual(
      byAvgPos.map((i) => i.domain),
      ["b.com", "a.com", "c.com"],
    );

    // keyword_count: desc
    const byKwCount = sortCompetitors(items, "keyword_count");
    assert.deepEqual(
      byKwCount.map((i) => i.domain),
      ["c.com", "a.com", "b.com"],
    );
  });

  it("excludes target host, www., and target subdomains from results (F14-AC-08)", async () => {
    const { deps, calls } = createHarness();

    const result = await findSerpCompetitors(
      {
        targetDomain: "offcult.in",
        keywords: ["oversized tee", "anime shirt"],
        locationCode: 2356,
        languageCode: "en",
      },
      deps,
    );

    assert.ok(result);
    assert.equal(calls.length, 1);
    assert.equal(result.cached, false);

    // In fixture: bewakoof.com, souledstore.com, offcult.in, www.offcult.in, blog.offcult.in
    // offcult.in, www.offcult.in, and blog.offcult.in must all be excluded!
    const domains = result.competitors.map((c) => c.domain);
    assert.deepEqual(domains, ["bewakoof.com", "souledstore.com"]);
  });

  it("flags isOwnSite and isDeclaredCompetitor correctly", async () => {
    const { deps } = createHarness();

    const result = await findSerpCompetitors(
      {
        targetDomain: "otherbrand.com",
        keywords: ["oversized tee"],
        locationCode: 2356,
        languageCode: "en",
        ownHost: "www.offcult.in", // own site is offcult.in
        declaredCompetitors: ["bewakoof.com"],
      },
      deps,
    );

    assert.ok(result);
    // offcult.in was NOT the researched target domain here, so it is present
    const bewakoof = result.competitors.find((c) => c.domain === "bewakoof.com");
    assert.ok(bewakoof);
    assert.equal(bewakoof.isDeclaredCompetitor, true);
    assert.equal(bewakoof.isOwnSite, false);

    const offcult = result.competitors.find((c) => c.domain === "offcult.in");
    assert.ok(offcult);
    assert.equal(offcult.isOwnSite, true);
    assert.equal(offcult.isDeclaredCompetitor, false);

    const souledstore = result.competitors.find((c) => c.domain === "souledstore.com");
    assert.ok(souledstore);
    assert.equal(souledstore.isOwnSite, false);
    assert.equal(souledstore.isDeclaredCompetitor, false);
  });

  it("calls metered labs.serpCompetitors with feature domain.competitors and proper idempotencyKey", async () => {
    const { deps, calls } = createHarness();

    await findSerpCompetitors(
      {
        targetDomain: "offcult.in",
        keywords: ["oversized tee"],
        locationCode: 2356,
        languageCode: "en",
      },
      { ...deps, maxUsd: 0.05 },
    );

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.ctx.feature, "domain.competitors");
    assert.equal(call.ctx.brandKey, "brand_test");
    assert.equal(call.ctx.idempotencyKey, "domain.competitors:req_123");
    assert.equal(call.ctx.maxUsd, 0.05);
  });

  it("caches results when rows > 0 and serves cache on second request", async () => {
    const { deps, calls } = createHarness();

    const first = await findSerpCompetitors(
      {
        targetDomain: "offcult.in",
        keywords: ["oversized tee"],
        locationCode: 2356,
        languageCode: "en",
      },
      deps,
    );
    assert.ok(first);
    assert.equal(first.cached, false);
    assert.equal(calls.length, 1);

    const second = await findSerpCompetitors(
      {
        targetDomain: "offcult.in",
        keywords: ["oversized tee"],
        locationCode: 2356,
        languageCode: "en",
      },
      deps,
    );
    assert.ok(second);
    assert.equal(second.cached, true);
    assert.equal(calls.length, 1); // No new call to labs
  });

  it("does not write to cache when rows is empty", async () => {
    const { deps, calls, setCompetitorsResponse } = createHarness();
    setCompetitorsResponse([]);

    const first = await findSerpCompetitors(
      {
        targetDomain: "offcult.in",
        keywords: ["unusual query"],
        locationCode: 2356,
        languageCode: "en",
      },
      deps,
    );
    assert.ok(first);
    assert.equal(first.cached, false);
    assert.equal(calls.length, 1);

    const second = await findSerpCompetitors(
      {
        targetDomain: "offcult.in",
        keywords: ["unusual query"],
        locationCode: 2356,
        languageCode: "en",
      },
      deps,
    );
    assert.ok(second);
    assert.equal(second.cached, false);
    assert.equal(calls.length, 2); // Labs called again because 0 rows were not cached
  });

  it("cacheOnly miss returns null and makes zero labs calls", async () => {
    const { deps, calls } = createHarness();

    const result = await findSerpCompetitors(
      {
        targetDomain: "offcult.in",
        keywords: ["not yet cached"],
        locationCode: 2356,
        languageCode: "en",
      },
      { ...deps, cacheOnly: true },
    );

    assert.equal(result, null);
    assert.equal(calls.length, 0);
  });
});
