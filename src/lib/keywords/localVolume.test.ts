// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/keywords/services/research/research.test.ts:158-267
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMemoryCacheStore } from "../cache/memoryStore.ts";
import type { KeywordResearchRow } from "../../shared/keywords.ts";
import { research, type ResearchDeps } from "./research.ts";
import { assertLocalResearchLocation, localizeResearchRows } from "./localVolume.ts";

const AUSTIN = "Austin,Texas,United States";
const registry = async () => [
  { locationCode: 1026201, locationName: AUSTIN, locationType: "City", displayLabel: "Austin, Texas, United States" },
];

const nationalPlumber: KeywordResearchRow = {
  keyword: "plumber",
  searchVolume: 673000,
  trend: [{ year: 2026, month: 8, searchVolume: 673000 }],
  cpc: 34.32,
  competition: 0.1,
  keywordDifficulty: 31,
  intent: "commercial",
};

const localInput = {
  keyword: "plumber",
  locationCode: 2840,
  languageCode: "en",
  locationName: AUSTIN,
  resultLimit: 150 as const,
  mode: "suggestions" as const,
  clickstream: true,
  groupKeywords: false,
};

function toLabsItem(row: KeywordResearchRow) {
  return {
    keyword: row.keyword,
    keyword_info: {
      search_volume: row.searchVolume,
      cpc: row.cpc,
      competition: row.competition,
      monthly_searches: row.trend.map((t) => ({ year: t.year, month: t.month, search_volume: t.searchVolume })),
    },
    keyword_properties: { keyword_difficulty: row.keywordDifficulty },
    search_intent_info: { main_intent: row.intent },
  };
}

type Harness = {
  deps: ResearchDeps;
  labsCalls: any[];
  adsCalls: { call: any; input: any }[];
  upserted: KeywordResearchRow[][];
  setLabsRows(rows: KeywordResearchRow[]): void;
  setAdsItems(items: any[]): void;
};

function harness(): Harness {
  let labsRows: KeywordResearchRow[] = [];
  let adsItems: any[] = [];
  const labsCalls: any[] = [];
  const adsCalls: { call: any; input: any }[] = [];
  const upserted: KeywordResearchRow[][] = [];
  const store = createMemoryCacheStore();
  const leg = async (_call: any, input: any) => {
    labsCalls.push(input);
    return labsRows.map(toLabsItem);
  };
  const deps: ResearchDeps = {
    labs: { keywords: { suggestions: leg, ideas: leg, related: leg } } as any,
    ads: {
      adsIdeas: async () => [],
      adsSearchVolume: async (call: any, input: any) => {
        adsCalls.push({ call, input });
        return adsItems;
      },
    } as any,
    upsertMetrics: async (rows) => {
      upserted.push(rows);
    },
    assertLocalLocation: (code, name) =>
      assertLocalResearchLocation(code, name, { fetchSerpLocationsForCountry: registry }),
    keepAlive: (promise) => void promise,
    requestId: "req-local",
    brandKey: "brand-a",
    cachedDeps: { cacheDeps: { store } },
  };
  return {
    deps, labsCalls, adsCalls, upserted,
    setLabsRows: (rows) => { labsRows = rows; },
    setAdsItems: (items) => { adsItems = items; },
  };
}

describe("local volume (F13-AC-20)", () => {
  let h: Harness;
  beforeEach(() => { h = harness(); });

  it("replaces national volume with local volume and never falls back to national", async () => {
    const collapsed = { ...nationalPlumber, keyword: "plumbers" };
    const adsRejected = { ...nationalPlumber, keyword: "plumber (24/7)" };
    h.setLabsRows([nationalPlumber, collapsed, adsRejected]);
    h.setAdsItems([
      { keyword: "plumber", search_volume: 2900, cpc: 36.67, competition_index: 20, monthly_searches: [{ year: 2026, month: 8, search_volume: 2900 }] },
    ]);

    const result = await research(localInput, h.deps);

    assert.deepEqual(result.result.rows, [
      { ...nationalPlumber, searchVolume: 2900, trend: [{ year: 2026, month: 8, searchVolume: 2900 }], cpc: 36.67, competition: 0.2 },
      ...[collapsed, adsRejected].map((row) => ({ ...row, searchVolume: null, trend: [], cpc: null, competition: null })),
    ]);
    // Local volume replaces clickstream volume, so the national leg skips it.
    assert.equal(h.labsCalls[0].includeClickstreamData, false);
    assert.equal(h.adsCalls.length, 1);
    assert.deepEqual(h.adsCalls[0].input.keywords, ["plumber", "plumbers"]);
    assert.equal(h.adsCalls[0].input.locationName, AUSTIN);
    assert.equal(h.adsCalls[0].call.idempotencyKey, "keywords.research:req-local:local_volume");
    assert.equal(h.adsCalls[0].call.feature, "keywords.research");
    // Keyword metrics are stored per country: only national numbers persist, once.
    assert.equal(h.upserted.length, 1);
    assert.equal(h.upserted[0].find((r) => r.keyword === "plumber")?.searchVolume, 673000);
    assert.equal(h.upserted.flat().some((r) => r.searchVolume === 2900), false);

    const again = await research(localInput, h.deps);
    assert.equal(again.cached, true);
    assert.deepEqual(again.result, result.result);
    assert.equal(h.adsCalls.length, 1);
  });

  it("stores national metrics for a local search whose national result is cached", async () => {
    const nationalInput = { ...localInput, keyword: "electrician", locationName: undefined, clickstream: false };
    h.setLabsRows([{ ...nationalPlumber, keyword: "electrician", searchVolume: 90500 }]);
    await research(nationalInput, h.deps);
    const labsCallsAfterNational = h.labsCalls.length;
    const upsertsAfterNational = h.upserted.length;

    await research({ ...nationalInput, locationName: AUSTIN }, h.deps);

    assert.equal(h.labsCalls.length, labsCallsAfterNational, "national rows came from the cache");
    const fresh = h.upserted.slice(upsertsAfterNational);
    assert.equal(fresh.length, 1);
    assert.equal(fresh[0][0].keyword, "electrician");
    assert.equal(fresh[0][0].searchVolume, 90500);
  });

  it("rejects a location outside the country's registry before any paid call", async () => {
    await assert.rejects(
      research({ ...localInput, locationName: "Austin, TX" }, h.deps),
      (err: any) => {
        assert.equal(err.status, 409);
        assert.equal(err.code, "unknown_location");
        assert.equal(err.message, '"Austin, TX" is not a city, county, or region we can find in United States.');
        return true;
      },
    );
    assert.equal(h.labsCalls.length, 0);
    assert.equal(h.adsCalls.length, 0);
  });
});

describe("localizeResearchRows", () => {
  it("makes no Ads call when no row is an Ads-valid keyword", async () => {
    let calls = 0;
    const rows = await localizeResearchRows(
      [{ ...nationalPlumber, keyword: "plumber!!" }],
      { locationCode: 2840, locationName: AUSTIN, languageCode: "en", call: { brandKey: "b", idempotencyKey: "k", feature: "keywords.research" } as any },
      { ads: { adsSearchVolume: async () => { calls++; return []; } } as any },
    );
    assert.equal(calls, 0);
    assert.equal(rows[0].searchVolume, null);
  });
});
