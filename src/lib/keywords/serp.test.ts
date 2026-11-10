// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/keywords/services/research/serp.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  getSerpAnalysis,
  mapOrganicSerpItems,
  runSerpRequest,
  serpCacheInput,
  type SerpClient,
  type SerpDeps,
} from "./serp.ts";
import type { SerpLiveItem } from "../providers/dataforseo/serp.ts";
import type { CacheRow, CacheStore } from "../cache/store.ts";
import { CacheOnlyMiss } from "../research/cache.ts";
import { serpKeywordCostMultiplier } from "../pricing/index.ts";

function createMemoryCacheStore(): CacheStore {
  const map = new Map<string, CacheRow>();
  return {
    async read(key: string) {
      return map.get(key) ?? null;
    },
    async write(row: CacheRow) {
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

describe("getSerpAnalysis cache depth and anti-hijack", () => {
  const baseInput = {
    keyword: "seo tools",
    locationCode: 2840,
    languageCode: "en",
  };

  it("anti-hijack drops ai_overview and people_also_ask from organic items", () => {
    const rawItems: SerpLiveItem[] = [
      {
        type: "ai_overview",
        rank_group: 1,
        rank_absolute: 1,
        title: "AI Overview",
      },
      {
        type: "organic",
        rank_group: 1,
        rank_absolute: 2,
        title: "Best SEO Tools 2026",
        url: "https://example.com/best-seo-tools",
        domain: "example.com",
        description: "Review of the best SEO tools.",
        etv: 500,
        estimated_paid_traffic_cost: 150,
        backlinks_info: {
          referring_domains: 30,
          backlinks: 90,
        },
      },
      {
        type: "people_also_ask",
        rank_group: 2,
        rank_absolute: 3,
        title: "What are good SEO tools?",
      },
      {
        type: "organic",
        rank_group: 2,
        rank_absolute: 4,
        title: "Top 10 SEO Tools",
        url: "https://top10.example/seo",
        domain: "top10.example",
      },
    ];

    const mapped = mapOrganicSerpItems(rawItems);
    assert.equal(mapped.length, 2);
    assert.equal(mapped[0].rank, 1);
    assert.equal(mapped[0].domain, "example.com");
    assert.equal(mapped[0].etv, 500);
    assert.equal(mapped[0].referringDomains, 30);
    assert.equal(mapped[1].rank, 2);
    assert.equal(mapped[1].domain, "top10.example");
  });

  it("serves a depth-100 snapshot for a depth-20 request (ported case)", async () => {
    const store = createMemoryCacheStore();
    let liveCalls = 0;

    const mockSerp: SerpClient = {
      live: async () => {
        liveCalls++;
        return [];
      },
    };

    // Pre-populate depth-100 cache
    const cacheInput100 = serpCacheInput(baseInput, 100);
    const { cacheKey } = await import("../cache/providerCache.ts");
    const key100 = cacheKey(cacheInput100);
    await store.write({
      key: key100,
      namespace: cacheInput100.namespace,
      version: cacheInput100.version,
      scope: cacheInput100.scope,
      brandKey: null,
      value: {
        requestedKeyword: "seo tools",
        items: [
          {
            rank: 1,
            title: "Cached 100",
            url: "https://cached.example",
            domain: "cached.example",
            description: "",
            etv: null,
            estimatedPaidTrafficCost: null,
            referringDomains: null,
            backlinks: null,
            isNew: false,
            rankChange: null,
          },
        ],
        depth: 100,
      },
      storagePath: null,
      sizeBytes: 100,
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    const deps: SerpDeps = {
      serp: mockSerp,
      brandKey: "brand-1",
      requestId: "req-1",
      cachedDeps: { cacheDeps: { store } },
    };

    const res = await getSerpAnalysis({ ...baseInput, depth: 20 }, deps);
    assert.equal(liveCalls, 0, "no client calls made");
    assert.equal(res.cached, true);
    assert.equal(res.depth, 100);
    assert.equal(res.items[0].title, "Cached 100");
  });

  it("refetches live at depth 100 when only a depth-20 snapshot is cached (ported case)", async () => {
    const store = createMemoryCacheStore();
    let requestedDepth = 0;

    const mockSerp: SerpClient = {
      live: async (_call, input) => {
        requestedDepth = input.depth;
        return [
          {
            type: "organic",
            rank_group: 1,
            title: "Live 100",
            url: "https://live.example",
            domain: "live.example",
          },
        ];
      },
    };

    // Pre-populate depth-20 cache
    const cacheInput20 = serpCacheInput(baseInput, 20);
    const { cacheKey } = await import("../cache/providerCache.ts");
    const key20 = cacheKey(cacheInput20);
    await store.write({
      key: key20,
      namespace: cacheInput20.namespace,
      version: cacheInput20.version,
      scope: cacheInput20.scope,
      brandKey: null,
      value: {
        requestedKeyword: "seo tools",
        items: [
          {
            rank: 1,
            title: "Cached 20",
            url: "https://cached20.example",
            domain: "cached20.example",
            description: "",
            etv: null,
            estimatedPaidTrafficCost: null,
            referringDomains: null,
            backlinks: null,
            isNew: false,
            rankChange: null,
          },
        ],
        depth: 20,
      },
      storagePath: null,
      sizeBytes: 100,
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    const deps: SerpDeps = {
      serp: mockSerp,
      brandKey: "brand-1",
      requestId: "req-2",
      cachedDeps: { cacheDeps: { store } },
    };

    const res = await getSerpAnalysis({ ...baseInput, depth: 100 }, deps);
    assert.equal(requestedDepth, 100);
    assert.equal(res.cached, false);
    assert.equal(res.depth, 100);
    assert.equal(res.items[0].title, "Live 100");

    // The depth-100 snapshot is now in cache
    const key100 = cacheKey(serpCacheInput(baseInput, 100));
    const cachedRow100 = await store.read(key100);
    assert.ok(cachedRow100);
  });

  it("keeps a good snapshot when the deeper crawl comes back empty (ported case)", async () => {
    const store = createMemoryCacheStore();

    const mockSerp: SerpClient = {
      live: async () => [],
    };

    // Pre-populate depth-20 cache
    const cacheInput20 = serpCacheInput(baseInput, 20);
    const { cacheKey } = await import("../cache/providerCache.ts");
    const key20 = cacheKey(cacheInput20);
    await store.write({
      key: key20,
      namespace: cacheInput20.namespace,
      version: cacheInput20.version,
      scope: cacheInput20.scope,
      brandKey: null,
      value: {
        requestedKeyword: "seo tools",
        items: [
          {
            rank: 1,
            title: "Cached 20",
            url: "https://cached20.example",
            domain: "cached20.example",
            description: "",
            etv: null,
            estimatedPaidTrafficCost: null,
            referringDomains: null,
            backlinks: null,
            isNew: false,
            rankChange: null,
          },
        ],
        depth: 20,
      },
      storagePath: null,
      sizeBytes: 100,
      fetchedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    });

    const deps: SerpDeps = {
      serp: mockSerp,
      brandKey: "brand-1",
      requestId: "req-3",
      cachedDeps: { cacheDeps: { store } },
    };

    const res = await getSerpAnalysis({ ...baseInput, depth: 100 }, deps);
    assert.equal(res.items.length, 0);
    assert.equal(res.reason, "no_organic_results");

    // Ensure the empty result did not overwrite depth 20 or write depth 100
    const key100 = cacheKey(serpCacheInput(baseInput, 100));
    const cachedRow100 = await store.read(key100);
    assert.equal(cachedRow100, null, "empty result was not cached at depth 100");

    const cachedRow20 = await store.read(key20);
    assert.ok(cachedRow20, "depth 20 entry is still present");
  });

  it("passes locationName to assertLocalLocation when provided", async () => {
    let checkedLocation = "";
    const mockSerp: SerpClient = {
      live: async () => [
        {
          type: "organic",
          rank_group: 1,
          title: "Local Item",
          url: "https://local.example",
          domain: "local.example",
        },
      ],
    };

    const deps: SerpDeps = {
      serp: mockSerp,
      brandKey: "brand-1",
      requestId: "req-4",
      assertLocalLocation: async (_code, name) => {
        checkedLocation = name;
      },
      cachedDeps: { cacheDeps: { store: createMemoryCacheStore() } },
    };

    const res = await getSerpAnalysis(
      { ...baseInput, depth: 20, locationName: "Austin,Texas,United States" },
      deps,
    );

    assert.equal(checkedLocation, "Austin,Texas,United States");
    assert.equal(res.items[0].title, "Local Item");
  });

  it("detects search operators and reserves 5x multiplier", () => {
    assert.equal(serpKeywordCostMultiplier("site:example.com best shoes"), 5);
    assert.equal(serpKeywordCostMultiplier("intitle:shoes review"), 5);
    assert.equal(serpKeywordCostMultiplier("inurl:shoes-deals"), 5);
    assert.equal(serpKeywordCostMultiplier("filetype:pdf guide"), 5);
    assert.equal(serpKeywordCostMultiplier("cache:example.com"), 5);
    assert.equal(serpKeywordCostMultiplier("allintitle:example shoes"), 5);
    assert.equal(serpKeywordCostMultiplier("best shoes for running"), 1);
  });

  it("runSerpRequest handles cacheOnly miss with CacheOnlyMiss error", async () => {
    const store = createMemoryCacheStore();
    const ws = {
      brandKey: "test-brand",
      brand: {
        brandKey: "test-brand",
        role: "owner" as const,
        display_name: "Test Brand",
        website: "https://example.com",
        website_host: "example.com",
        aliases: [],
        is_active: true,
      },
    };

    await assert.rejects(
      async () => {
        await runSerpRequest(
          ws,
          {
            keyword: "uncached keyword",
            requestId: "req-cacheonly",
            cacheOnly: true,
          },
          {
            cachedDeps: { cacheDeps: { store } },
          },
        );
      },
      (err: unknown) => err instanceof CacheOnlyMiss,
    );
  });
});
