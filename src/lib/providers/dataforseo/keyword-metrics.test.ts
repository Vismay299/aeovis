// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/keyword-metrics.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DataforseoCallContext } from "./client.ts";
import {
  fetchKeywordMetricsForList,
  type KeywordMetricsClient,
} from "./keyword-metrics.ts";

function fakeClient(overrides: {
  keywordOverview?: KeywordMetricsClient["labs"]["keywordOverview"];
  adsSearchVolume?: KeywordMetricsClient["ads"]["adsSearchVolume"];
}): KeywordMetricsClient {
  return {
    labs: {
      keywordOverview:
        overrides.keywordOverview ?? (async () => []),
    },
    ads: {
      adsSearchVolume:
        overrides.adsSearchVolume ?? (async () => []),
    },
  };
}

const dummyCall = (tag: string): DataforseoCallContext =>
  ({ idempotencyKey: `test-${tag}` }) as unknown as DataforseoCallContext;

describe("fetchKeywordMetricsForList", () => {
  it("normalizes Labs items and prefers clickstream-refined volume/trend", async () => {
    let capturedCtx: DataforseoCallContext | undefined;
    let capturedInput: unknown;

    const keywordOverview: KeywordMetricsClient["labs"]["keywordOverview"] = async (
      ctx,
      input,
    ) => {
      capturedCtx = ctx;
      capturedInput = input;
      return [
        {
          keyword: "best crm",
          keyword_info: {
            search_volume: 1000,
            cpc: 3.2,
            competition: 0.5,
            competition_level: "MEDIUM",
            monthly_searches: [{ year: 2026, month: 1, search_volume: 1000 }],
          },
          keyword_info_normalized_with_clickstream: {
            search_volume: 880,
            monthly_searches: [{ year: 2026, month: 1, search_volume: 880 }],
          },
          keyword_properties: { keyword_difficulty: 42 },
          search_intent_info: { main_intent: "commercial" },
        },
      ];
    };
    const client = fakeClient({ keywordOverview });

    const rows = await fetchKeywordMetricsForList(client, {
      keywords: ["best crm"],
      locationCode: 2840,
      languageCode: "en",
      includeClickstreamData: true,
      call: dummyCall,
    });

    assert.equal(capturedCtx?.idempotencyKey, "test-batch-0:labs");
    assert.deepEqual(capturedInput, {
      keywords: ["best crm"],
      locationCode: 2840,
      languageCode: "en",
      includeClickstreamData: true,
    });
    assert.deepEqual(rows, [
      {
        keyword: "best crm",
        searchVolume: 880,
        cpc: 3.2,
        competition: 0.5,
        competitionLevel: "MEDIUM",
        keywordDifficulty: 42,
        intent: "commercial",
        monthlySearches: [{ year: 2026, month: 1, searchVolume: 880 }],
      },
    ]);
  });

  it("routes Google Ads locations and scales competition_index to a 0-1 ratio", async () => {
    let capturedCtx: DataforseoCallContext | undefined;
    let capturedInput: unknown;

    const adsSearchVolume: KeywordMetricsClient["ads"]["adsSearchVolume"] = async (
      ctx,
      input,
    ) => {
      capturedCtx = ctx;
      capturedInput = input;
      return [
        {
          keyword: "hotel reykjavik",
          search_volume: 1300,
          cpc: 2.54,
          competition: "HIGH",
          competition_index: 42,
          monthly_searches: [{ year: 2026, month: 5, search_volume: 1300 }],
        },
        { keyword: undefined },
      ];
    };
    const client = fakeClient({ adsSearchVolume });

    // Location 2352 is Iceland (Google Ads provider)
    const rows = await fetchKeywordMetricsForList(client, {
      keywords: ["hotel reykjavik"],
      locationCode: 2352,
      languageCode: "is",
      call: dummyCall,
    });

    assert.equal(capturedCtx?.idempotencyKey, "test-batch-0:ads");
    assert.deepEqual(capturedInput, {
      keywords: ["hotel reykjavik"],
      locationCode: 2352,
      languageCode: "is",
      locationName: undefined,
    });
    // Item without a keyword is dropped; Ads carries no KD/intent.
    assert.deepEqual(rows, [
      {
        keyword: "hotel reykjavik",
        searchVolume: 1300,
        cpc: 2.54,
        competition: 0.42,
        competitionLevel: "HIGH",
        keywordDifficulty: null,
        intent: null,
        monthlySearches: [{ year: 2026, month: 5, searchVolume: 1300 }],
      },
    ]);
  });

  it("skips keywords Google Ads rejects instead of failing the batch", async () => {
    let capturedKeywords: string[] = [];

    const adsSearchVolume: KeywordMetricsClient["ads"]["adsSearchVolume"] = async (
      _ctx,
      input,
    ) => {
      capturedKeywords = input.keywords;
      return [];
    };

    const rows = await fetchKeywordMetricsForList(
      fakeClient({ adsSearchVolume }),
      {
        keywords: ["hotel reykjavik", "hotel (cheap)", "best hotel?"],
        locationCode: 2352,
        languageCode: "is",
        call: dummyCall,
      },
    );

    assert.deepEqual(capturedKeywords, ["hotel reykjavik"]);
    // Rejected keywords get empty metrics, so a refresh clears stale values.
    const cheap = rows.find((r) => r.keyword === "hotel (cheap)");
    const best = rows.find((r) => r.keyword === "best hotel?");
    assert.ok(cheap);
    assert.equal(cheap.searchVolume, null);
    assert.ok(best);
    assert.equal(best.searchVolume, null);
  });

  it("batches keyword lists above the per-call cap", async () => {
    let callCount = 0;
    const keywordOverview: KeywordMetricsClient["labs"]["keywordOverview"] = async (
      _ctx,
      input,
    ) => {
      callCount++;
      return input.keywords.map((keyword) => ({
        keyword,
        keyword_info: {},
      }));
    };
    const client = fakeClient({ keywordOverview });
    const keywords = Array.from({ length: 1500 }, (_, i) => `kw-${i}`);

    const rows = await fetchKeywordMetricsForList(client, {
      keywords,
      locationCode: 2840,
      languageCode: "en",
      call: dummyCall,
    });

    assert.equal(callCount, 3); // 700 + 700 + 100
    assert.equal(rows.length, 1500);
  });

  it("merges city-scoped Ads volume with national Labs KD for local requests", async () => {
    let capturedLocationName: string | undefined;

    const adsSearchVolume: KeywordMetricsClient["ads"]["adsSearchVolume"] = async (
      _ctx,
      input,
    ) => {
      capturedLocationName = input.locationName;
      return [
        {
          keyword: "plumber near me",
          search_volume: 260,
          cpc: 7.54,
          competition: "MEDIUM",
          competition_index: 55,
          monthly_searches: [],
        },
        // "emergency plumber near me" collapsed away by Google Ads normalization.
      ];
    };
    const keywordOverview: KeywordMetricsClient["labs"]["keywordOverview"] = async (
      _ctx,
      _input,
    ) => {
      return [
        {
          keyword: "plumber near me",
          keyword_info: { search_volume: 135000, cpc: 11.29 },
          keyword_properties: { keyword_difficulty: 76 },
          search_intent_info: { main_intent: "transactional" },
        },
        {
          keyword: "emergency plumber near me",
          keyword_info: { search_volume: 135000, cpc: 5.93 },
          keyword_properties: { keyword_difficulty: 17 },
          search_intent_info: { main_intent: "transactional" },
        },
      ];
    };
    const client = fakeClient({ adsSearchVolume, keywordOverview });

    const rows = await fetchKeywordMetricsForList(client, {
      keywords: [
        "plumber near me",
        "emergency plumber near me",
        "plumber (24/7)",
      ],
      locationCode: 2840,
      languageCode: "en",
      locationName: "Springfield,Illinois,United States",
      call: dummyCall,
    });

    assert.equal(capturedLocationName, "Springfield,Illinois,United States");
    // Local volume/CPC from Ads, national KD/intent from Labs.
    assert.equal(rows[0]?.keyword, "plumber near me");
    assert.equal(rows[0]?.searchVolume, 260);
    assert.equal(rows[0]?.cpc, 7.54);
    assert.equal(rows[0]?.keywordDifficulty, 76);
    assert.equal(rows[0]?.intent, "transactional");

    // Keyword Ads dropped: KD/intent survive, but the national volume/CPC
    // must NOT leak into a local request.
    assert.equal(rows[1]?.keyword, "emergency plumber near me");
    assert.equal(rows[1]?.searchVolume, null);
    assert.equal(rows[1]?.cpc, null);
    assert.equal(rows[1]?.keywordDifficulty, 17);
    assert.equal(rows[1]?.intent, "transactional");

    // Neither source returned it: an empty row still clears stale metrics.
    assert.equal(rows[2]?.keyword, "plumber (24/7)");
    assert.equal(rows[2]?.searchVolume, null);
    assert.equal(rows[2]?.keywordDifficulty, null);
  });
});
