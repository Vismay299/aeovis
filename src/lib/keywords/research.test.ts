// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/keywords/services/research/research.test.ts:63-140
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryCacheStore } from "../cache/memoryStore.ts";
import { applyKeywordFiltersAndSort, EMPTY_FILTERS } from "../../shared/keyword-filtering.ts";
import type { KeywordResearchRow } from "../../shared/keywords.ts";
import { research, type ResearchDeps } from "./research.ts";

function createMockClients(overrides: {
  suggestions?: (call: any, input: any) => Promise<any[]>;
  ideas?: (call: any, input: any) => Promise<any[]>;
  related?: (call: any, input: any) => Promise<any[]>;
  adsIdeas?: (call: any, input: any) => Promise<any[]>;
} = {}) {
  const calls: { client: string; method: string; call: any; input: any }[] = [];

  const labs = {
    keywords: {
      suggestions: async (call: any, input: any) => {
        calls.push({ client: "labs", method: "suggestions", call, input });
        return overrides.suggestions ? overrides.suggestions(call, input) : [];
      },
      ideas: async (call: any, input: any) => {
        calls.push({ client: "labs", method: "ideas", call, input });
        return overrides.ideas ? overrides.ideas(call, input) : [];
      },
      related: async (call: any, input: any) => {
        calls.push({ client: "labs", method: "related", call, input });
        return overrides.related ? overrides.related(call, input) : [];
      },
      keywordOverview: async () => [],
      serpCompetitors: async () => [],
    },
    labs: {
      keywordOverview: async () => [],
      serpCompetitors: async () => [],
    },
    domain: {
      rankOverview: async () => ({}),
      rankedKeywords: async () => [],
      relevantPages: async () => [],
    },
  };

  const ads = {
    adsIdeas: async (call: any, input: any) => {
      calls.push({ client: "ads", method: "adsIdeas", call, input });
      return overrides.adsIdeas ? overrides.adsIdeas(call, input) : [];
    },
    adsSearchVolume: async () => [],
  };

  return { labs: labs as any, ads: ads as any, calls };
}

describe("research", () => {
  it("keeps shared-volume keywords independently filterable through research and cache (ported :63-140)", async () => {
    const seed: KeywordResearchRow = {
      keyword: "caregiving",
      searchVolume: 110000,
      trend: [
        { year: 2026, month: 6, searchVolume: 90500 },
        { year: 2026, month: 7, searchVolume: 110000 },
      ],
      cpc: 8.25,
      competition: 0.4,
      keywordDifficulty: 60,
      intent: "informational",
    };
    const opportunity: KeywordResearchRow = {
      ...seed,
      keyword: "caregiver",
      keywordDifficulty: 20,
      intent: "commercial",
    };
    const siblings: KeywordResearchRow[] = [
      "respite care",
      "elder care",
      "adult day care",
      "care home",
    ].map((keyword) => ({ ...seed, keyword, searchVolume: 500 }));

    const cacheStore = createMemoryCacheStore();
    const upserted: KeywordResearchRow[][] = [];

    const { labs, ads, calls } = createMockClients({
      suggestions: async () => [
        {
          keyword: seed.keyword,
          keyword_info: {
            search_volume: seed.searchVolume,
            cpc: seed.cpc,
            competition: seed.competition,
            monthly_searches: seed.trend,
          },
          keyword_properties: { keyword_difficulty: seed.keywordDifficulty },
          search_intent_info: { main_intent: seed.intent },
        },
      ],
      ideas: async (_call, input) => {
        const pool = input.ignoreSynonyms ? siblings : [opportunity, ...siblings];
        return pool.map((r) => ({
          keyword: r.keyword,
          keyword_info: {
            search_volume: r.searchVolume,
            cpc: r.cpc,
            competition: r.competition,
            monthly_searches: r.trend,
          },
          keyword_properties: { keyword_difficulty: r.keywordDifficulty },
          search_intent_info: { main_intent: r.intent },
        }));
      },
    });

    const deps: ResearchDeps = {
      labs,
      ads,
      upsertMetrics: async (rows) => {
        upserted.push(rows);
      },
      requestId: "req-1",
      brandKey: "brand-a",
      cachedDeps: { cacheDeps: { store: cacheStore } },
    };

    const input = {
      keyword: "caregiving",
      locationCode: 2840,
      languageCode: "en",
      resultLimit: 150 as const,
      mode: "auto" as const,
      clickstream: false,
      groupKeywords: true,
    };

    const fresh = await research(input, deps);
    const cached = await research(input, deps);

    assert.equal(calls.length, 2, "2 calls on fresh, 0 on cached");
    assert.deepEqual(cached.result, fresh.result);
    assert.ok(fresh.result.rows.some((r) => r.keyword === "caregiver"));
    assert.equal(fresh.result.source, "blended");
    assert.equal(upserted.length, 1);
    assert.ok(upserted[0].some((r) => r.keyword === "caregiver" && r.keywordDifficulty === 20 && r.intent === "commercial"));

    const filtered = applyKeywordFiltersAndSort({
      rows: cached.result.rows,
      filters: { ...EMPTY_FILTERS, maxKd: "30", intents: "commercial" },
      sortField: "keyword",
      sortDir: "asc",
    });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].keyword, "caregiver");

    const coreOnly = await research({ ...input, groupKeywords: false }, deps);
    assert.ok(!coreOnly.result.rows.some((r) => r.keyword === "caregiver"));
  });

  it("auto blend uses ceil(L/2) per leg and interleaves", async () => {
    const limits: number[] = [];
    const cacheStore = createMemoryCacheStore();

    const { labs, ads } = createMockClients({
      suggestions: async (_call, input) => {
        limits.push(input.limit);
        return [
          { keyword: "seed", keyword_info: { search_volume: 100 } },
          { keyword: "sugg1", keyword_info: { search_volume: 90 } },
          { keyword: "sugg2", keyword_info: { search_volume: 80 } },
          { keyword: "sugg3", keyword_info: { search_volume: 70 } },
        ];
      },
      ideas: async (_call, input) => {
        limits.push(input.limit);
        return [
          { keyword: "idea1", keyword_info: { search_volume: 85 } },
          { keyword: "idea2", keyword_info: { search_volume: 75 } },
          { keyword: "idea3", keyword_info: { search_volume: 65 } },
        ];
      },
    });

    const deps: ResearchDeps = {
      labs,
      ads,
      upsertMetrics: async () => {},
      requestId: "req-2",
      brandKey: "brand-a",
      cachedDeps: { cacheDeps: { store: cacheStore } },
    };

    const res = await research(
      {
        keyword: "seed",
        locationCode: 2840,
        languageCode: "en",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
        groupKeywords: false,
      },
      deps,
    );

    assert.deepEqual(limits, [75, 75]);
    assert.equal(res.result.source, "blended");
    assert.equal(res.result.usedFallback, false);
    // Interleaving: seed, idea1, sugg1, idea2, sugg2, idea3, sugg3
    assert.equal(res.result.rows[0].keyword, "seed");
    assert.equal(res.result.rows[1].keyword, "idea1");
    assert.equal(res.result.rows[2].keyword, "sugg1");
  });

  it("fallback when < 5 non-seed rows returned in auto blend", async () => {
    let relatedCalled = false;
    const cacheStore = createMemoryCacheStore();

    const { labs, ads } = createMockClients({
      suggestions: async () => [
        { keyword: "seed", keyword_info: { search_volume: 100 } },
        { keyword: "s1", keyword_info: { search_volume: 50 } },
      ],
      ideas: async () => [
        { keyword: "i1", keyword_info: { search_volume: 40 } },
      ],
      related: async () => {
        relatedCalled = true;
        return [
          { keyword_data: { keyword: "r1", keyword_info: { search_volume: 30 } } },
          { keyword_data: { keyword: "r2", keyword_info: { search_volume: 20 } } },
          { keyword_data: { keyword: "r3", keyword_info: { search_volume: 10 } } },
        ];
      },
    });

    const deps: ResearchDeps = {
      labs,
      ads,
      upsertMetrics: async () => {},
      requestId: "req-3",
      brandKey: "brand-a",
      cachedDeps: { cacheDeps: { store: cacheStore } },
    };

    const res = await research(
      {
        keyword: "seed",
        locationCode: 2840,
        languageCode: "en",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
        groupKeywords: false,
      },
      deps,
    );

    assert.equal(relatedCalled, true);
    assert.equal(res.result.source, "blended");
    assert.equal(res.result.usedFallback, true);
    assert.ok(res.result.rows.some((r) => r.keyword === "r1"));
  });

  it("suggestions rejects while ideas resolves: both settled before throw", async () => {
    let ideasSettled = false;
    const cacheStore = createMemoryCacheStore();

    const { labs, ads } = createMockClients({
      suggestions: async () => {
        throw new Error("suggestions failed");
      },
      ideas: async () => {
        await new Promise((r) => setTimeout(r, 20));
        ideasSettled = true;
        return [{ keyword: "idea", keyword_info: { search_volume: 10 } }];
      },
    });

    const deps: ResearchDeps = {
      labs,
      ads,
      upsertMetrics: async () => {},
      requestId: "req-4",
      brandKey: "brand-a",
      cachedDeps: { cacheDeps: { store: cacheStore } },
    };

    await assert.rejects(
      async () => {
        await research(
          {
            keyword: "seed",
            locationCode: 2840,
            languageCode: "en",
            resultLimit: 150,
            mode: "auto",
          },
          deps,
        );
      },
      /suggestions failed/,
    );

    assert.equal(ideasSettled, true, "ideas leg settled before error thrown");
  });

  it("Ads country one call and normalized cache key", async () => {
    // Location 2044 = Bahamas (in LOCATION_OPTIONS with googleAdsOnly: true)
    const cacheStore = createMemoryCacheStore();
    const { labs, ads, calls } = createMockClients({
      adsIdeas: async () => [
        { keyword: "tour", search_volume: 100, competition_index: 30, cpc: 1.0 },
      ],
    });

    const deps: ResearchDeps = {
      labs,
      ads,
      upsertMetrics: async () => {},
      requestId: "req-5",
      brandKey: "brand-a",
      cachedDeps: { cacheDeps: { store: cacheStore } },
    };

    // First call with mode="suggestions", clickstream=true, groupKeywords=true
    const res1 = await research(
      {
        keyword: "tour",
        locationCode: 2044,
        languageCode: "en",
        resultLimit: 150,
        mode: "suggestions",
        clickstream: true,
        groupKeywords: true,
      },
      deps,
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0].client, "ads");
    assert.equal(calls[0].method, "adsIdeas");
    assert.equal(res1.result.source, "google_ads");
    assert.equal(res1.result.rows[0].keywordDifficulty, null);
    assert.equal(res1.result.rows[0].intent, "unknown");

    // Second call with different ignored options (mode="ideas", clickstream=false, groupKeywords=false)
    const res2 = await research(
      {
        keyword: "tour",
        locationCode: 2044,
        languageCode: "en",
        resultLimit: 150,
        mode: "ideas",
        clickstream: false,
        groupKeywords: false,
      },
      deps,
    );

    assert.equal(calls.length, 1, "second call hit cache because normalized options matched");
    assert.equal(res2.cached, true);
    assert.deepEqual(res2.result, res1.result);
  });

  it("second request from another brandKey makes zero client calls", async () => {
    const cacheStore = createMemoryCacheStore();
    const { labs, ads, calls } = createMockClients({
      suggestions: async () => [
        { keyword: "shoes", keyword_info: { search_volume: 500 } },
        { keyword: "sneakers", keyword_info: { search_volume: 400 } },
        { keyword: "boots", keyword_info: { search_volume: 300 } },
      ],
      ideas: async () => [
        { keyword: "loafers", keyword_info: { search_volume: 200 } },
        { keyword: "sandals", keyword_info: { search_volume: 100 } },
        { keyword: "slippers", keyword_info: { search_volume: 50 } },
      ],
    });

    const depsA: ResearchDeps = {
      labs,
      ads,
      upsertMetrics: async () => {},
      requestId: "req-a",
      brandKey: "brand-alpha",
      cachedDeps: { cacheDeps: { store: cacheStore } },
    };

    const depsB: ResearchDeps = {
      labs,
      ads,
      upsertMetrics: async () => {},
      requestId: "req-b",
      brandKey: "brand-beta",
      cachedDeps: { cacheDeps: { store: cacheStore } },
    };

    const input = {
      keyword: "shoes",
      locationCode: 2840,
      languageCode: "en",
      resultLimit: 150 as const,
      mode: "auto" as const,
      clickstream: false,
      groupKeywords: false,
    };

    const resA = await research(input, depsA);
    assert.equal(resA.cached, false);
    assert.equal(calls.length, 2);

    // Brand B asks for the same global market data
    const resB = await research(input, depsB);
    assert.equal(resB.cached, true);
    assert.equal(calls.length, 2, "zero new client calls for brand B");
    assert.deepEqual(resB.result, resA.result);
  });

  it("empty rows are not cached", async () => {
    const cacheStore = createMemoryCacheStore();
    let callCount = 0;

    const { labs, ads } = createMockClients({
      suggestions: async () => {
        callCount++;
        return [];
      },
      ideas: async () => [],
      related: async () => [],
    });

    const deps: ResearchDeps = {
      labs,
      ads,
      upsertMetrics: async () => {},
      requestId: "req-empty",
      brandKey: "brand-a",
      cachedDeps: { cacheDeps: { store: cacheStore } },
    };

    const input = {
      keyword: "nonexistentkeywordxyz123",
      locationCode: 2840,
      languageCode: "en",
      resultLimit: 150 as const,
      mode: "auto" as const,
    };

    const res1 = await research(input, deps);
    assert.equal(res1.result.rows.length, 0);
    assert.equal(callCount, 1);

    // Second call should NOT hit cache because keep condition (rows.length > 0) failed
    const res2 = await research(input, deps);
    assert.equal(callCount, 2, "called provider again because empty rows were not cached");
    assert.equal(res2.cached, false);
  });

  it("upsertMetrics called through keepAlive for a fetch and never on a hit", async () => {
    const cacheStore = createMemoryCacheStore();
    let upsertCount = 0;
    let keepAliveCount = 0;

    const { labs, ads } = createMockClients({
      suggestions: async () => [
        { keyword: "seed", keyword_info: { search_volume: 100 } },
        { keyword: "w1", keyword_info: { search_volume: 50 } },
        { keyword: "w2", keyword_info: { search_volume: 40 } },
      ],
      ideas: async () => [
        { keyword: "w3", keyword_info: { search_volume: 30 } },
        { keyword: "w4", keyword_info: { search_volume: 20 } },
      ],
    });

    const deps: ResearchDeps = {
      labs,
      ads,
      upsertMetrics: async () => {
        upsertCount++;
      },
      keepAlive: (promise) => {
        keepAliveCount++;
        void promise;
      },
      requestId: "req-metrics",
      brandKey: "brand-a",
      cachedDeps: { cacheDeps: { store: cacheStore } },
    };

    const input = {
      keyword: "seed",
      locationCode: 2840,
      languageCode: "en",
      resultLimit: 150 as const,
      mode: "auto" as const,
    };

    // First request: fetch
    const res1 = await research(input, deps);
    assert.equal(res1.fetched, true);
    assert.equal(upsertCount, 1, "upsertMetrics called on fetch");
    assert.equal(keepAliveCount, 1, "keepAlive received upsert promise on fetch");

    // Second request: cache hit
    const res2 = await research(input, deps);
    assert.equal(res2.cached, true);
    assert.equal(upsertCount, 1, "upsertMetrics NOT called on cache hit");
    assert.equal(keepAliveCount, 1, "keepAlive NOT called on cache hit");
  });
});
