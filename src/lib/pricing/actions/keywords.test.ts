import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  estimateKeywordResearch,
  estimateSerpRun,
  keywordResearchAction,
  serpRunAction,
} from "./keywords.ts";
import type { PricingContext } from "../pricedActions.ts";

function fakeContext(brandKey = "brand-test"): PricingContext {
  return {
    brandKey,
    admin: {} as any,
    env: {},
    now: new Date("2026-11-10T12:00:00Z"),
  };
}

describe("keywords priced actions", () => {
  it("worked example matches $0.0755 total and $0.0455 expected for India defaults", async () => {
    // Offcult, India (2356), "oversized t shirt", defaults: 150 auto
    const quote = await estimateKeywordResearch(
      fakeContext(),
      {
        keyword: "oversized t shirt",
        locationCode: 2356,
        languageCode: "en",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
        groupKeywords: false,
      },
    );

    assert.equal(quote.totalUsd, 0.0755);
    assert.equal(quote.expectedUsd, 0.0455);
    assert.equal(quote.lines.length, 4);
    assert.equal(quote.lines[0].label, "Phrase-match ideas");
    assert.equal(quote.lines[0].totalUsd, 0.021);
    assert.equal(quote.lines[1].label, "Category ideas");
    assert.equal(quote.lines[1].totalUsd, 0.021);
    assert.equal(
      quote.lines[2].label,
      "Related keywords (only if the first two find fewer than 5)",
    );
    assert.equal(quote.lines[2].totalUsd, 0.03);
    assert.equal(
      quote.lines[3].label,
      "Top 20 Google results for “oversized t shirt”",
    );
    assert.equal(quote.lines[3].totalUsd, 0.0035);
    assert.equal(quote.units[0].count, 150);
    assert.equal(quote.warnings[0].code, "cache_note");
  });

  it("clickstream doubles Labs lines", async () => {
    const quote = await estimateKeywordResearch(
      fakeContext(),
      {
        keyword: "oversized t shirt",
        locationCode: 2840,
        languageCode: "en",
        resultLimit: 150,
        mode: "auto",
        clickstream: true,
        groupKeywords: false,
      },
    );

    // Doubled Labs lines:
    // suggestions (75): (0.012 + 75 * 0.00012) * 2 = 0.042
    // ideas (75): (0.012 + 75 * 0.00012) * 2 = 0.042
    // related (150): (0.012 + 150 * 0.00012) * 2 = 0.060
    // SERP (20): 0.0035 (SERP is not a Labs keyword line)
    // Total = 0.042 + 0.042 + 0.060 + 0.0035 = 0.1475
    // Expected = 0.042 + 0.042 + 0.0035 = 0.0875
    assert.equal(quote.lines[0].totalUsd, 0.042);
    assert.equal(quote.lines[1].totalUsd, 0.042);
    assert.equal(quote.lines[2].totalUsd, 0.06);
    assert.equal(quote.lines[3].totalUsd, 0.0035);
    assert.equal(quote.totalUsd, 0.1475);
    assert.equal(quote.expectedUsd, 0.0875);
  });

  it("Ads country one $0.09 line plus SERP and ads_only warning", async () => {
    // 2044 = Bahamas (googleAdsOnly)
    const quote = await estimateKeywordResearch(
      fakeContext(),
      {
        keyword: "beach resort",
        locationCode: 2044,
        languageCode: "en",
        resultLimit: 150,
        mode: "auto",
        clickstream: true, // ignored for Ads countries
        groupKeywords: false,
      },
    );

    // Google Ads ideas: $0.09, SERP: $0.0035
    assert.equal(quote.lines.length, 2);
    assert.equal(quote.lines[0].label, "Keyword ideas from Google Ads");
    assert.equal(quote.lines[0].totalUsd, 0.09);
    assert.equal(
      quote.lines[1].label,
      "Top 20 Google results for “beach resort”",
    );
    assert.equal(quote.lines[1].totalUsd, 0.0035);
    assert.equal(quote.totalUsd, 0.0935);
    assert.equal(quote.expectedUsd, 0.0935);

    const adsWarning = quote.warnings.find((w) => w.code === "ads_only");
    assert.ok(adsWarning);
    assert.equal(
      adsWarning?.message,
      "Keyword data for this country comes from Google Ads: no difficulty or intent.",
    );
  });

  it("adds local volume line when locationName is provided", async () => {
    const quote = await estimateKeywordResearch(
      fakeContext(),
      {
        keyword: "coffee shop",
        locationCode: 2840,
        languageCode: "en",
        locationName: "Austin,Texas,United States",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
        groupKeywords: false,
      },
    );

    const localLine = quote.lines.find(
      (l) => l.label === "Local volume for Austin,Texas,United States",
    );
    assert.ok(localLine);
    assert.equal(localLine?.totalUsd, 0.09);
  });

  it("recent_research warning text from a stubbed findRecentResearch", async () => {
    const fakeRow = {
      id: "res-1",
      entryDate: "2026-11-08",
      summary: "Found 150 keyword ideas.",
      spendUsd: 0.05,
      createdAt: "2026-11-08T10:00:00Z",
    };

    const quote = await estimateKeywordResearch(
      fakeContext(),
      {
        keyword: "shoes",
        locationCode: 2840,
        languageCode: "en",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
        groupKeywords: false,
      },
      {
        findRecentResearch: async () => fakeRow as any,
      },
    );

    const recentWarning = quote.warnings.find(
      (w) => w.code === "recent_research",
    );
    assert.ok(recentWarning);
    assert.equal(
      recentWarning?.message,
      "You researched this on 2026-11-08: Found 150 keyword ideas. Results older than 24 hours are bought again.",
    );
  });

  it("serp run action quotes depth 20 and 100 without requiring approval", async () => {
    assert.equal(serpRunAction.requireApproval, false);
    assert.equal(keywordResearchAction.requireApproval, true);

    const quote20 = await estimateSerpRun(fakeContext(), {
      keyword: "seo tools",
      depth: 20,
    });
    assert.equal(quote20.totalUsd, 0.0035);
    assert.equal(quote20.expectedUsd, 0.0035);
    assert.equal(quote20.lines[0].label, "Top 20 Google results");

    const quote100 = await estimateSerpRun(fakeContext(), {
      keyword: "seo tools",
      depth: 100,
    });
    // Depth 100: 10 pages -> 0.002 + 9 * 0.0015 = 0.0155
    assert.equal(quote100.totalUsd, 0.0155);
    assert.equal(quote100.expectedUsd, 0.0155);
    assert.equal(quote100.lines[0].label, "Top 100 Google results");
    assert.equal(quote100.warnings[0].code, "cache_note");
  });
});
