import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AdsKeywordIdeaItem } from "../../shared/providers/dataforseo/google-ads.ts";
import type { LabsKeywordDataItem } from "../../shared/providers/dataforseo/labs.ts";
import {
  mapAdsKeywordItems,
  mapKeywordDataItems,
  fetchGoogleAdsResearchRows,
  fetchResearchRowsBySource,
} from "./researchData.ts";

describe("mapAdsKeywordItems", () => {
  it("dedupes case-variant keywords and skips empty ones", () => {
    const items: AdsKeywordIdeaItem[] = [
      { keyword: "northern lights tour", search_volume: 320, competition_index: 45, cpc: 2.5 },
      { keyword: "Northern Lights Tour", search_volume: 320 },
      { keyword: undefined },
    ];
    const rows = mapAdsKeywordItems(items);

    assert.equal(rows.length, 1);
    assert.equal(rows[0].keyword, "northern lights tour");
    assert.equal(rows[0].searchVolume, 320);
    assert.equal(rows[0].competition, 0.45);
    assert.equal(rows[0].cpc, 2.5);
    assert.equal(rows[0].keywordDifficulty, null);
    assert.equal(rows[0].intent, "unknown");
    assert.deepEqual(rows[0].trend, []);
  });
});

describe("mapKeywordDataItems", () => {
  it("prefers clickstream search volume when available and parses intent", () => {
    const items: LabsKeywordDataItem[] = [
      {
        keyword: "best shoes",
        keyword_info: {
          search_volume: 5000,
          cpc: 1.2,
          competition: 0.8,
          monthly_searches: [{ year: 2026, month: 9, search_volume: 5000 }],
        },
        keyword_info_normalized_with_clickstream: {
          search_volume: 6200,
          monthly_searches: [{ year: 2026, month: 9, search_volume: 6200 }],
        },
        keyword_properties: { keyword_difficulty: 55 },
        search_intent_info: { main_intent: "Commercial" },
      },
      {
        keyword: "Best Shoes", // duplicate case variant
        keyword_info: { search_volume: 5000 },
      },
    ];

    const rows = mapKeywordDataItems(items);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].keyword, "best shoes");
    assert.equal(rows[0].searchVolume, 6200);
    assert.equal(rows[0].cpc, 1.2);
    assert.equal(rows[0].competition, 0.8);
    assert.equal(rows[0].keywordDifficulty, 55);
    assert.equal(rows[0].intent, "commercial");
    assert.equal(rows[0].trend.length, 1);
    assert.equal(rows[0].trend[0].searchVolume, 6200);
  });
});

describe("fetchGoogleAdsResearchRows and fetchResearchRowsBySource", () => {
  it("routes fetchGoogleAdsResearchRows through ads.adsIdeas", async () => {
    let called = false;
    const fakeAds = {
      adsIdeas: async (_call: any, input: any) => {
        called = true;
        assert.equal(input.keyword, "test");
        return [{ keyword: "test idea", search_volume: 100 }];
      },
    };

    const rows = await fetchGoogleAdsResearchRows(
      {
        seedKeyword: "test",
        locationCode: 2840,
        languageCode: "en",
        resultLimit: 10,
        call: { brandKey: "b1", idempotencyKey: "k1" },
      },
      { ads: fakeAds as any }
    );

    assert.equal(called, true);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].keyword, "test idea");
  });

  it("routes suggestions, ideas, and related in fetchResearchRowsBySource", async () => {
    const calledSources: string[] = [];
    const fakeLabs = {
      keywords: {
        suggestions: async () => {
          calledSources.push("suggestions");
          return [{ keyword: "sugg" }];
        },
        ideas: async () => {
          calledSources.push("ideas");
          return [{ keyword: "idea" }];
        },
        related: async () => {
          calledSources.push("related");
          return [{ keyword_data: { keyword: "rel" } }];
        },
      },
    };

    const baseParams = {
      seedKeyword: "test",
      locationCode: 2840,
      languageCode: "en",
      resultLimit: 10,
      call: { brandKey: "b1", idempotencyKey: "k1" },
    };

    const suggRows = await fetchResearchRowsBySource(
      { ...baseParams, source: "suggestions" },
      { labs: fakeLabs as any }
    );
    assert.equal(suggRows[0].keyword, "sugg");

    const ideaRows = await fetchResearchRowsBySource(
      { ...baseParams, source: "ideas" },
      { labs: fakeLabs as any }
    );
    assert.equal(ideaRows[0].keyword, "idea");

    const relRows = await fetchResearchRowsBySource(
      { ...baseParams, source: "related" },
      { labs: fakeLabs as any }
    );
    assert.equal(relRows[0].keyword, "rel");

    assert.deepEqual(calledSources, ["suggestions", "ideas", "related"]);
  });
});
