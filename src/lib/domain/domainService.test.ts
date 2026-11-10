import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  getOverview,
  getKeywordsPage,
  getPagesPage,
  getSuggestedKeywords,
  type DomainServiceDeps,
  type KeywordMetricInsertRow,
} from "./domainService.ts";
import { createMemoryCacheStore } from "../cache/memoryStore.ts";
import type { LabsClient } from "../providers/dataforseo/labs.ts";

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

  const calls: {
    rankOverview: Array<{ ctx: any; input: any }>;
    rankedKeywords: Array<{ ctx: any; input: any }>;
    relevantPages: Array<{ ctx: any; input: any }>;
  } = {
    rankOverview: [],
    rankedKeywords: [],
    relevantPages: [],
  };

  const overviewFixture = loadFixture<any>("labs-domain-rank-overview.json");
  const emptyOverviewFixture = loadFixture<any>("labs-domain-rank-overview-empty.json");
  const rankedKeywordsFixture = loadFixture<any>("labs-ranked-keywords.json");
  const relevantPagesFixture = loadFixture<any>("labs-relevant-pages.json");

  let overviewResponse = overviewFixture;
  let rankedKeywordsResponse = rankedKeywordsFixture;
  let relevantPagesResponse = relevantPagesFixture;

  const fakeLabs: LabsClient = {
    keywords: {} as any,
    labs: {
      keywordOverview: async () => ({} as any),
      serpCompetitors: async () => ({} as any),
    },
    domain: {
      rankOverview: (async (ctx: any, input: any) => {
        calls.rankOverview.push({ ctx, input });
        return overviewResponse;
      }) as any,
      rankedKeywords: (async (ctx: any, input: any) => {
        calls.rankedKeywords.push({ ctx, input });
        return {
          items: rankedKeywordsResponse.items ?? [],
          totalCount:
            rankedKeywordsResponse.totalCount ??
            rankedKeywordsResponse.total_count ??
            null,
        };
      }) as any,
      relevantPages: (async (ctx: any, input: any) => {
        calls.relevantPages.push({ ctx, input });
        return {
          items: relevantPagesResponse.items ?? [],
          totalCount:
            relevantPagesResponse.totalCount ??
            relevantPagesResponse.total_count ??
            null,
        };
      }) as any,
    },
  };

  const upsertedMetrics: KeywordMetricInsertRow[][] = [];
  const fakeUpsertMetrics = async (rows: KeywordMetricInsertRow[]) => {
    upsertedMetrics.push(rows);
  };

  const makeDeps = (brandKey = "brand_1", requestId = "req_1", cacheOnly = false): DomainServiceDeps => ({
    labs: fakeLabs,
    brandKey,
    requestId,
    cacheOnly,
    upsertMetrics: fakeUpsertMetrics,
    keepAlive: async (work) => {
      await (typeof work === "function" ? (work as () => Promise<unknown>)() : work);
    },
    cacheDeps,
  });

  return {
    store,
    cacheDeps,
    calls,
    fakeLabs,
    upsertedMetrics,
    makeDeps,
    setOverviewResponse: (r: any) => {
      overviewResponse = r;
    },
    setRankedKeywordsResponse: (r: any) => {
      rankedKeywordsResponse = r;
    },
    emptyOverviewFixture,
  };
}

describe("domainService", () => {
  it("getOverview maps traffic and keywords rounded, sets hasData = keywords > 0, echoes scope and display", async () => {
    const h = createHarness();
    const result = await getOverview(
      { domain: "offcult.in", scope: "domain", locationCode: 2356, languageCode: "en" },
      h.makeDeps(),
    );

    assert.ok(result);
    assert.equal(result.domain, "offcult.in");
    assert.equal(result.displayTarget, "offcult.in");
    assert.equal(result.scope, "domain");
    assert.equal(result.organicTraffic, 1840);
    assert.equal(result.organicKeywords, 312);
    assert.equal(result.hasData, true);
    assert.equal(result.cached, false);
    assert.equal(result.provenance.gateway, "dataforseo");

    assert.equal(h.calls.rankOverview.length, 1);
    const call = h.calls.rankOverview[0];
    assert.deepEqual(call.ctx, {
      brandKey: "brand_1",
      feature: "domain.research",
      idempotencyKey: "domain.research:req_1:overview",
      maxUsd: undefined,
    });
    assert.deepEqual(call.input, {
      target: "offcult.in",
      locationCode: 2356,
      languageCode: "en",
    });
  });

  it("getOverview does not write cache when organicKeywords is 0", async () => {
    const h = createHarness();
    h.setOverviewResponse(h.emptyOverviewFixture);

    const first = await getOverview(
      { domain: "empty.com", locationCode: 2356, languageCode: "en" },
      h.makeDeps(),
    );
    assert.ok(first);
    assert.equal(first.hasData, false);
    assert.equal(first.cached, false);

    // Second call calls provider again because nothing was cached
    const second = await getOverview(
      { domain: "empty.com", locationCode: 2356, languageCode: "en" },
      h.makeDeps(),
    );
    assert.ok(second);
    assert.equal(second.cached, false);
    assert.equal(h.calls.rankOverview.length, 2);
  });

  it("subfolder lookup reuses the hostname entry and echoes scope and display", async () => {
    const h = createHarness();
    // First lookup for domain
    const root = await getOverview(
      { domain: "offcult.in", locationCode: 2356, languageCode: "en" },
      h.makeDeps(),
    );
    assert.ok(root);
    assert.equal(root.cached, false);
    assert.equal(h.calls.rankOverview.length, 1);

    // Second lookup for a subfolder of the same domain
    const subfolder = await getOverview(
      { domain: "https://offcult.in/collections/oversized", locationCode: 2356, languageCode: "en" },
      h.makeDeps(),
    );
    assert.ok(subfolder);
    assert.equal(subfolder.cached, true);
    assert.equal(subfolder.domain, "offcult.in");
    assert.equal(subfolder.displayTarget, "offcult.in/collections/oversized");
    assert.equal(subfolder.scope, "subfolder");
    // Provider was not called again
    assert.equal(h.calls.rankOverview.length, 1);
  });

  it("workspace B misses workspace A's entry", async () => {
    const h = createHarness();
    // Workspace A lookups domain
    const a = await getOverview(
      { domain: "offcult.in", locationCode: 2356, languageCode: "en" },
      h.makeDeps("workspace_A"),
    );
    assert.ok(a);
    assert.equal(a.cached, false);
    assert.equal(h.calls.rankOverview.length, 1);

    // Workspace B lookups same domain -> pays again (not cached)
    const b = await getOverview(
      { domain: "offcult.in", locationCode: 2356, languageCode: "en" },
      h.makeDeps("workspace_B"),
    );
    assert.ok(b);
    assert.equal(b.cached, false);
    assert.equal(h.calls.rankOverview.length, 2);
  });

  it("cacheOnly miss returns null and makes zero client calls", async () => {
    const h = createHarness();
    const result = await getOverview(
      { domain: "uncached.com", locationCode: 2356, languageCode: "en" },
      h.makeDeps("brand_1", "req_1", true),
    );
    assert.equal(result, null);
    assert.equal(h.calls.rankOverview.length, 0);

    const kwResult = await getKeywordsPage(
      {
        domain: "uncached.com",
        locationCode: 2356,
        languageCode: "en",
        page: 1,
        pageSize: 50,
        sortMode: "traffic",
        sortOrder: "desc",
        filters: {},
      },
      h.makeDeps("brand_1", "req_1", true),
    );
    assert.equal(kwResult, null);
    assert.equal(h.calls.rankedKeywords.length, 0);
  });

  it("getKeywordsPage passes offset, order, filters, scope, caches results, and upserts metrics on fetch", async () => {
    const h = createHarness();
    const result = await getKeywordsPage(
      {
        domain: "https://offcult.in/collections/oversized",
        locationCode: 2356,
        languageCode: "en",
        page: 2,
        pageSize: 50,
        sortMode: "traffic",
        sortOrder: "desc",
        filters: { minVol: 100 },
        search: "shirt",
      },
      h.makeDeps("brand_1", "req_42"),
    );

    assert.ok(result);
    assert.equal(result.cached, false);
    assert.equal(result.domain, "offcult.in");
    assert.equal(result.page, 2);
    assert.equal(result.pageSize, 50);
    assert.equal(result.totalCount, 312);
    assert.equal(result.keywords.length, 3);
    assert.equal(h.calls.rankedKeywords.length, 1);

    const call = h.calls.rankedKeywords[0];
    assert.deepEqual(call.ctx, {
      brandKey: "brand_1",
      feature: "domain.research",
      idempotencyKey: "domain.research:req_42:keywords",
      maxUsd: undefined,
    });
    assert.equal(call.input.target, "offcult.in");
    assert.equal(call.input.offset, 50);
    assert.equal(call.input.limit, 50);
    assert.deepEqual(call.input.orderBy, ["ranked_serp_element.serp_item.etv,desc"]);
    assert.ok(Array.isArray(call.input.filters));

    // upsertMetrics was called on fetch with source "labs_ranked"
    assert.equal(h.upsertedMetrics.length, 1);
    const upserted = h.upsertedMetrics[0];
    assert.equal(upserted.length, 3);
    assert.equal(upserted[0].keyword, "oversized t shirt");
    assert.equal(upserted[0].search_volume, 74000);
    assert.equal(upserted[0].cpc, 0.41);
    assert.equal(upserted[0].keyword_difficulty, 38);
    assert.equal(upserted[0].source, "labs_ranked");

    // Repeat call -> cache hit, upsertMetrics NOT called again
    const cachedResult = await getKeywordsPage(
      {
        domain: "https://offcult.in/collections/oversized",
        locationCode: 2356,
        languageCode: "en",
        page: 2,
        pageSize: 50,
        sortMode: "traffic",
        sortOrder: "desc",
        filters: { minVol: 100 },
        search: "shirt",
      },
      h.makeDeps("brand_1", "req_43"),
    );
    assert.ok(cachedResult);
    assert.equal(cachedResult.cached, true);
    assert.equal(h.calls.rankedKeywords.length, 1); // No new provider call
    assert.equal(h.upsertedMetrics.length, 1); // No new upsert call
  });

  it("getPagesPage passes offset, order, filters, scope and caches results", async () => {
    const h = createHarness();
    const result = await getPagesPage(
      {
        domain: "offcult.in",
        locationCode: 2356,
        languageCode: "en",
        page: 1,
        pageSize: 50,
        sortMode: "traffic",
        sortOrder: "desc",
        filters: { minTraffic: 10 },
      },
      h.makeDeps(),
    );

    assert.ok(result);
    assert.equal(result.cached, false);
    assert.equal(result.pages.length, 2);
    assert.equal(result.pages[0].relativePath, "/collections/oversized");
    assert.equal(h.calls.relevantPages.length, 1);

    const call = h.calls.relevantPages[0];
    assert.equal(call.ctx.feature, "domain.research");
    assert.equal(call.ctx.idempotencyKey, "domain.research:req_1:pages");
    assert.deepEqual(call.input.orderBy, ["metrics.organic.etv,desc"]);

    // Repeat -> cached
    const cachedResult = await getPagesPage(
      {
        domain: "offcult.in",
        locationCode: 2356,
        languageCode: "en",
        page: 1,
        pageSize: 50,
        sortMode: "traffic",
        sortOrder: "desc",
        filters: { minTraffic: 10 },
      },
      h.makeDeps(),
    );
    assert.ok(cachedResult);
    assert.equal(cachedResult.cached, true);
    assert.equal(h.calls.relevantPages.length, 1);
  });

  it("getSuggestedKeywords returns top 100 keywords sorted by etv desc", async () => {
    const h = createHarness();
    const result = await getSuggestedKeywords(
      { domain: "offcult.in", locationCode: 2356, languageCode: "en" },
      h.makeDeps(),
    );

    assert.equal(result.length, 3);
    assert.equal(result[0].keyword, "oversized t shirt");
    assert.equal(h.calls.rankedKeywords.length, 1);
    const call = h.calls.rankedKeywords[0];
    assert.equal(call.input.limit, 100);
    assert.deepEqual(call.input.orderBy, ["ranked_serp_element.serp_item.etv,desc"]);
  });
});
