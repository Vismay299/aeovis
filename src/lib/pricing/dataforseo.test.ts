// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/pricing.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKLINKS_DEFAULT_LIMIT,
  SERP_ANALYSIS_DEPTH,
  clampSerpDepth,
  costPerSerpAtDepth,
  dataforseoPricing,
  resolveLlmMentionsLimit,
  serpKeywordCostMultiplier,
} from "./dataforseo.ts";

/** Raw USD, compared to the ten decimal places the ported cases are quoted at. */
function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
}

test("Labs research, 500 rows with clickstream (incident shape)", () => {
  near(
    dataforseoPricing.keywords.related({
      limit: 500,
      includeClickstreamData: true,
    }),
    0.144,
  );
});

test("Labs research, default 150 rows", () => {
  near(dataforseoPricing.keywords.suggestions({ limit: 150 }), 0.03);
});

test("live SERP at the default depth (2 pages)", () => {
  near(dataforseoPricing.serp.live({ keyword: "seo" }), 0.0035);
});

test("live SERP for a keyword with a search operator (billed 5x)", () => {
  near(
    dataforseoPricing.serp.live({ keyword: "site:example.com seo" }),
    0.0175,
  );
});

test("Lighthouse run", () => {
  near(dataforseoPricing.lighthouse.live({}), 0.005);
});

test("backlinks history over one year", () => {
  near(
    dataforseoPricing.backlinks.history({
      dateFrom: "2025-09-09",
      dateTo: "2026-09-08",
    }),
    0.024 + 365 * 0.000036,
  );
});

test("holds at least the billed cost of a depth-20 reviews post", () => {
  const regular = dataforseoPricing.business.reviewsTaskPost({
    depth: 20,
    includeOtherSources: false,
  });
  assert.ok(regular >= 0.00375);
  near(regular, 0.004);

  const extended = dataforseoPricing.business.reviewsTaskPost({
    depth: 20,
    includeOtherSources: true,
  });
  assert.ok(extended >= 0.01);
  near(extended, 0.01);
});

// Real bills read from DataForSEO's id_list, each above the earlier estimate.
test("holds at least the measured bill: Q&A at depth 10 and 30", () => {
  const shallow = dataforseoPricing.business.questionsAnswers({ depth: 10 });
  assert.ok(shallow >= 0.0054);
  near(shallow, 0.0054);

  const deep = dataforseoPricing.business.questionsAnswers({ depth: 30 });
  assert.ok(deep >= 0.0108);
  near(deep, 0.0108);
});

test("holds at least the measured bill: Local Finder at depth 100", () => {
  const estimateUsd = dataforseoPricing.serp.local({
    searchType: "local_finder",
    depth: 100,
  });
  assert.ok(estimateUsd >= 0.02);
  near(estimateUsd, 0.02);
});

test("holds at least the measured bill: Maps tasks queued at high priority", () => {
  const estimateUsd = dataforseoPricing.serp.localTaskPost({
    locationCoordinates: ["1,1,13z", "2,2,13z"],
  });
  assert.ok(estimateUsd >= 0.0024);
  near(estimateUsd, 0.0024);
});

test("holds at least the measured bill: Claude response with web search", () => {
  const estimateUsd = dataforseoPricing.aiSearch.llmResponse({
    modelSlug: "claude",
    webSearch: true,
  });
  assert.ok(estimateUsd >= 0.142357);
  near(estimateUsd, 0.18);
});

test("bills a partial SERP page as a full page of 10", () => {
  // depth 25 is three pages of 10, never two and a half.
  near(dataforseoPricing.serp.live({ keyword: "seo", depth: 25 }), 0.005);
});

test("applies the operator multiplier to a live rank check", () => {
  near(
    dataforseoPricing.serp.rankCheck({
      keyword: "site:example.com seo",
      depth: 20,
    }),
    0.0175,
  );
  assert.equal(serpKeywordCostMultiplier("site:example.com seo"), 5);
  assert.equal(serpKeywordCostMultiplier("seo"), 1);
});

test("prices a queued task_post batch the way the rank check estimate does", () => {
  // Operator keywords bill 5x, so approvals must see the same mix.
  const keywords = Array.from({ length: 100 }, (_, i) =>
    i % 10 === 0 ? `site:example.com kw ${i}` : `kw ${i}`,
  );
  const estimateUsd = dataforseoPricing.serp.rankCheckTaskPost({
    tasks: keywords.map((keyword) => ({ keyword })),
    depth: 20,
  });
  const perPassUsd = keywords.reduce(
    (sum, keyword) =>
      sum +
      costPerSerpAtDepth(20, "queued") * serpKeywordCostMultiplier(keyword),
    0,
  );

  near(estimateUsd, perPassUsd);
  // The rank check estimate F15 owns is the worst case: this post plus two
  // queued retries.
  near(3 * estimateUsd, 3 * perPassUsd);
  // Every tenth keyword of the 100 carries an operator: 10 at 5x, 90 at 1x.
  near(estimateUsd, (90 + 10 * 5) * costPerSerpAtDepth(20, "queued"));
});

test("prices a live operator rank check the way the rank check estimate does", () => {
  const keyword = "site:example.com seo";
  const liveUsd = dataforseoPricing.serp.rankCheck({ keyword, depth: 20 });
  const retryUsd = dataforseoPricing.serp.rankCheckTaskPost({
    tasks: [{ keyword }],
    depth: 20,
  });
  // The estimate is the worst case: the live call plus two queued retries.
  near(
    liveUsd + 2 * retryUsd,
    serpKeywordCostMultiplier(keyword) *
      (costPerSerpAtDepth(20, "live") + 2 * costPerSerpAtDepth(20, "queued")),
  );
});

test("clamps SERP depth to DataForSEO's 10-100 page range", () => {
  assert.equal(clampSerpDepth(5), 10);
  assert.equal(clampSerpDepth(25), 25);
  assert.equal(clampSerpDepth(700), 100);
  assert.equal(SERP_ANALYSIS_DEPTH, 20);
  assert.equal(BACKLINKS_DEFAULT_LIMIT, 100);
});

test("resolves the LLM mentions row limit", () => {
  assert.equal(resolveLlmMentionsLimit(), 100);
  assert.equal(resolveLlmMentionsLimit(0), 1);
  assert.equal(resolveLlmMentionsLimit(250), 250);
  assert.equal(resolveLlmMentionsLimit(5_000), 1_000);
});

test("prices the flat and default-shaped endpoints", () => {
  near(
    dataforseoPricing.backlinks.rows({}),
    0.024 + BACKLINKS_DEFAULT_LIMIT * 0.000036,
  );
  near(dataforseoPricing.backlinks.summary({}), 0.024 + 0.000036);
  near(dataforseoPricing.business.myBusinessInfo({}), 0.0054);
  near(dataforseoPricing.domain.rankOverview({}), 0.012 + 0.00012);
  near(dataforseoPricing.keywords.adsIdeas({}), 0.09);
  near(dataforseoPricing.keywords.adsSearchVolume({}), 0.09);
  near(dataforseoPricing.aiSearch.mentionsSearch({}), 0.1 + 100 * 0.001);
  near(dataforseoPricing.aiSearch.aggregatedMetrics({}), 0.101);
  near(dataforseoPricing.aiSearch.topPages({}), 0.101);
  near(dataforseoPricing.aiSearch.crossAggregatedMetrics({}), 0.101);
  near(dataforseoPricing.aiSearch.trackingTaskPost({ tasks: [{}, {}] }), 0.0024);
  near(dataforseoPricing.aiSearch.trackingLive({}), 0.004);
});
