// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/pricing.ts, src/shared/rank-tracking.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import {
  AI_LIVE_RECORD_COST_USD,
  AI_RECORD_COST_USD,
  llmResponseUsd,
} from "../ai-visibility-pricing.ts";
import type { LlmResponseModelSlug } from "../ai-visibility-pricing.ts";

export { llmResponseUsd };

/**
 * Raw DataForSEO USD upper bound for one metered call, computed from the
 * fetcher's input before the call is made. The metering seam reserves this
 * estimate and settles on the provider's real `cost`, so every number here
 * must be >= what DataForSEO actually charges for that input. Overestimating
 * only refuses a call slightly early at the tail of a balance; underestimating
 * lets spend past the balance.
 *
 * Prices are raw (pre-markup) USD from DataForSEO's per-account price table
 * (the `price` object on the free GET /v3/appendix/user_data), read Sep 2026.
 * That table has only each endpoint's base price, so per-page, per-depth and
 * token-priced shapes are "measured": set from real billed costs, which the
 * free POST /v3/<api>/id_list returns per task alongside the request
 * parameters for the last month. Re-check a price against id_list, not a
 * one-off fixture.
 */

// DataForSEO Labs (dataforseo.com/pricing/dataforseo-labs/dataforseo-google-api):
// per task + per returned row, doubled with include_clickstream_data.
export const LABS_TASK_USD = 0.012;
export const LABS_ROW_USD = 0.00012;

// Keywords Data Google Ads, live mode (dataforseo.com/pricing/keywords-data/google-ads).
export const GOOGLE_ADS_LIVE_TASK_USD = 0.09;

// Backlinks API, uniform across endpoints (dataforseo.com/pricing/backlinks/backlinks).
export const BACKLINKS_TASK_USD = 0.024;
export const BACKLINKS_ROW_USD = 0.000036;

// Business Data (dataforseo.com/pricing/business-data/*). Task-queue posts run
// at priority 2, which doubles the standard-queue rates quoted on the pricing
// pages.
export const BUSINESS_LISTINGS_TASK_USD = 0.012;
export const BUSINESS_LISTINGS_ROW_USD = 0.00036;
export const MY_BUSINESS_INFO_LIVE_USD = 0.0054;
// measured: billed per 20 rows of depth ($0.0054 at depth 10 and 20, $0.0108
// at 30, $0.027 at 100).
export const QUESTIONS_ANSWERS_PER_20_USD = 0.0054;
// uncalibrated: the list prices undershoot the fixtures, which bill $0.00375
// (regular) and $0.01 (extended_reviews) for one depth-20 priority post.
export const REVIEWS_PRIORITY_TASK_USD = 0.001;
export const REVIEWS_PRIORITY_PER_10_USD = 0.0015;
export const EXTENDED_REVIEWS_PRIORITY_PER_20_USD = 0.01;
export const UPDATES_PRIORITY_TASK_USD = 0.003;
export const UPDATES_PRIORITY_PER_10_USD = 0.0015;

// OnPage Lighthouse, live (dataforseo.com/pricing/on-page/lighthouse-api);
// fixtures show $0.00425 billed.
export const LIGHTHOUSE_LIVE_USD = 0.005;

// AI Optimization (dataforseo.com/pricing/ai-optimization/llm-mentions):
// $0.1 per request + $0.001 per row on every llm_mentions endpoint.
export const LLM_MENTIONS_TASK_USD = 0.1;
export const LLM_MENTIONS_ROW_USD = 0.001;
// measured: the aggregate endpoints and top_pages return one result row, and
// every observed call billed $0.101.
const LLM_MENTIONS_ONE_ROW_USD = LLM_MENTIONS_TASK_USD + LLM_MENTIONS_ROW_USD;

// SERP Google Maps and Local Finder, live. measured: Maps bills one request
// through depth 100 ($0.002 at depth 20 and 100), and no caller asks for
// more. Local Finder bills every page of 10 at the first-page rate ($0.02 at
// depth 100).
export const LOCAL_SERP_PAGE_USD = 0.002;
// SERP Google Maps, queued at high priority. measured: task_post bills $0.0012
// per task at depth 20.
export const LOCAL_SERP_TASK_USD = 0.0012;

// DataForSEO Live API: cost of the first page (10 results) and of each
// additional page (75% of base).
export const LIVE_BASE_PAGE_COST_USD = 0.002;
export const LIVE_EXTRA_PAGE_COST_USD = 0.0015;

// DataForSEO task queue (standard priority): cost of the first page (10
// results) and of each additional page (75% of base).
export const QUEUED_BASE_PAGE_COST_USD = 0.0006;
export const QUEUED_EXTRA_PAGE_COST_USD = 0.00045;

// Google Organic bills 5x when the keyword contains an advanced search
// operator (docs.dataforseo.com/v3/serp/google/organic/live/advanced). The
// docs say "contains", so match anywhere: a false match only over-holds.
const SERP_OPERATOR_KEYWORD =
  /(allinanchor|allintext|allintitle|allinurl|cache|define|definition|filetype|id|inanchor|info|intext|intitle|inurl|link|site):/i;
export const SERP_OPERATOR_KEYWORD_MULTIPLIER = 5;

// Default depth for keyword SERP analysis. DataForSEO crawls (and bills) one
// Google page of 10 results at a time, so depth is the single lever on both
// latency and cost here. Keep this low — callers that need to see deeper ranks
// pass an explicit depth.
export const SERP_ANALYSIS_DEPTH = 20;

/** DataForSEO bills SERPs in pages of 10; depth outside 10-100 is rejected. */
export function clampSerpDepth(depth: number): number {
  return Math.min(100, Math.max(10, depth));
}

/** Default row limit on the Backlinks endpoints. */
export const BACKLINKS_DEFAULT_LIMIT = 100;

/** LLM mentions requests default to 100 rows and never exceed 1,000. */
export function resolveLlmMentionsLimit(limit?: number): number {
  return Math.min(1000, Math.max(1, Math.floor(limit ?? 100)));
}

const LLM_RESPONSE_WEB_SEARCH_DEFAULT = true;

/** DataForSEO cost for a single SERP request at the given depth. */
export function costPerSerpAtDepth(
  depth: number,
  method: "live" | "queued",
): number {
  const pages = depth / 10;
  return method === "queued"
    ? QUEUED_BASE_PAGE_COST_USD + (pages - 1) * QUEUED_EXTRA_PAGE_COST_USD
    : LIVE_BASE_PAGE_COST_USD + (pages - 1) * LIVE_EXTRA_PAGE_COST_USD;
}

export function serpKeywordCostMultiplier(keyword: string): number {
  return SERP_OPERATOR_KEYWORD.test(keyword)
    ? SERP_OPERATOR_KEYWORD_MULTIPLIER
    : 1;
}

function labsUsd(rows: number, clickstream?: boolean): number {
  return (LABS_TASK_USD + rows * LABS_ROW_USD) * (clickstream ? 2 : 1);
}

function backlinksUsd(rows: number): number {
  return BACKLINKS_TASK_USD + rows * BACKLINKS_ROW_USD;
}

/** SERP endpoints bill per page of 10; a partial page is a full page. */
function serpUsd(
  depth: number,
  method: "live" | "queued",
  keyword: string,
): number {
  return (
    costPerSerpAtDepth(Math.ceil(depth / 10) * 10, method) *
    serpKeywordCostMultiplier(keyword)
  );
}

function daysInclusive(from: string, to: string): number {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Math.max(1, Math.floor(ms / 86_400_000) + 1);
}

// Local input shapes: the estimators are pure, so F02 binds them to its fetchers and
// every consumer builds the input it already has.
type BusinessListingsInput = { limit: number };
type QuestionsAnswersInput = { depth: number };
type ReviewsTaskPostInput = { depth: number; includeOtherSources: boolean };
type UpdatesTaskPostInput = { depth: number };
type BacklinksRowsInput = { limit?: number };
type BacklinksHistoryInput = { dateFrom: string; dateTo: string };
type LabsRowsInput = { limit: number; includeClickstreamData?: boolean };
type LabsOverviewInput = {
  keywords: readonly string[];
  includeClickstreamData?: boolean;
};
type KeywordsAdsInput = { dateFrom?: string; dateTo?: string };
type SerpLiveInput = { keyword: string; depth?: number };
type SerpRankCheckInput = { keyword: string; depth: number };
type RankCheckTasksInput = {
  tasks: readonly { keyword: string }[];
  depth: number;
};
type LocalSerpInput = { searchType: string; depth: number };
type LocalTaskPostInput = { locationCoordinates: readonly string[] };
type LlmMentionsSearchInput = { limit?: number };
type TrackingTasksInput = { tasks: readonly unknown[] };
type LlmResponseInput = {
  modelSlug: LlmResponseModelSlug;
  webSearch?: boolean;
};
// Flat-priced endpoints ignore their input; the shape stays open so F13/F17/F18
// can pass the request they are about to send.
type FlatInput = Record<string, unknown>;

/** One raw-USD upper-bound estimator per DataForSEO entry point. */
export const dataforseoPricing = {
  business: {
    businessListings: (input: BusinessListingsInput) =>
      BUSINESS_LISTINGS_TASK_USD + input.limit * BUSINESS_LISTINGS_ROW_USD,
    questionsAnswers: (input: QuestionsAnswersInput) =>
      Math.ceil(input.depth / 20) * QUESTIONS_ANSWERS_PER_20_USD,
    myBusinessInfo: (_input: FlatInput) => MY_BUSINESS_INFO_LIVE_USD,
    reviewsTaskPost: (input: ReviewsTaskPostInput) =>
      input.includeOtherSources
        ? Math.ceil(input.depth / 20) * EXTENDED_REVIEWS_PRIORITY_PER_20_USD
        : REVIEWS_PRIORITY_TASK_USD +
          Math.ceil(input.depth / 10) * REVIEWS_PRIORITY_PER_10_USD,
    updatesTaskPost: (input: UpdatesTaskPostInput) =>
      UPDATES_PRIORITY_TASK_USD +
      Math.ceil(input.depth / 10) * UPDATES_PRIORITY_PER_10_USD,
  },
  backlinks: {
    summary: (_input: FlatInput) => backlinksUsd(1),
    rows: (input: BacklinksRowsInput) =>
      backlinksUsd(input.limit ?? BACKLINKS_DEFAULT_LIMIT),
    referringDomains: (input: BacklinksRowsInput) =>
      backlinksUsd(input.limit ?? BACKLINKS_DEFAULT_LIMIT),
    domainPages: (input: BacklinksRowsInput) =>
      backlinksUsd(input.limit ?? BACKLINKS_DEFAULT_LIMIT),
    history: (input: BacklinksHistoryInput) =>
      backlinksUsd(daysInclusive(input.dateFrom, input.dateTo)),
  },
  keywords: {
    related: (input: LabsRowsInput) =>
      labsUsd(input.limit, input.includeClickstreamData),
    suggestions: (input: LabsRowsInput) =>
      labsUsd(input.limit, input.includeClickstreamData),
    ideas: (input: LabsRowsInput) =>
      labsUsd(input.limit, input.includeClickstreamData),
    adsIdeas: (_input: KeywordsAdsInput) => GOOGLE_ADS_LIVE_TASK_USD,
    adsSearchVolume: (_input: KeywordsAdsInput) => GOOGLE_ADS_LIVE_TASK_USD,
  },
  domain: {
    rankOverview: (_input: FlatInput) => labsUsd(1),
    rankedKeywords: (input: LabsRowsInput) => labsUsd(input.limit),
    relevantPages: (input: LabsRowsInput) => labsUsd(input.limit),
  },
  serp: {
    live: (input: SerpLiveInput) =>
      serpUsd(
        clampSerpDepth(input.depth ?? SERP_ANALYSIS_DEPTH),
        "live",
        input.keyword,
      ),
    rankCheck: (input: SerpRankCheckInput) =>
      serpUsd(clampSerpDepth(input.depth), "live", input.keyword),
    rankCheckTaskPost: (input: RankCheckTasksInput) =>
      input.tasks.reduce(
        (sum, task) =>
          sum + serpUsd(clampSerpDepth(input.depth), "queued", task.keyword),
        0,
      ),
    local: (input: LocalSerpInput) =>
      input.searchType === "maps"
        ? LOCAL_SERP_PAGE_USD
        : Math.ceil(input.depth / 10) * LOCAL_SERP_PAGE_USD,
    localTaskPost: (input: LocalTaskPostInput) =>
      input.locationCoordinates.length * LOCAL_SERP_TASK_USD,
  },
  labs: {
    keywordOverview: (input: LabsOverviewInput) =>
      labsUsd(input.keywords.length, input.includeClickstreamData),
    serpCompetitors: (input: LabsRowsInput) => labsUsd(input.limit),
  },
  lighthouse: {
    live: (_input: FlatInput) => LIGHTHOUSE_LIVE_USD,
  },
  aiSearch: {
    mentionsSearch: (input: LlmMentionsSearchInput) =>
      LLM_MENTIONS_TASK_USD +
      resolveLlmMentionsLimit(input.limit) * LLM_MENTIONS_ROW_USD,
    aggregatedMetrics: (_input: FlatInput) => LLM_MENTIONS_ONE_ROW_USD,
    topPages: (_input: FlatInput) => LLM_MENTIONS_ONE_ROW_USD,
    crossAggregatedMetrics: (_input: FlatInput) => LLM_MENTIONS_ONE_ROW_USD,
    // One standard-queue answer per task, on every tracked engine.
    trackingTaskPost: (input: TrackingTasksInput) =>
      input.tasks.length * AI_RECORD_COST_USD,
    // One live answer, on every tracked engine.
    trackingLive: (_input: FlatInput) => AI_LIVE_RECORD_COST_USD,
    llmResponse: (input: LlmResponseInput) =>
      llmResponseUsd(
        input.modelSlug,
        input.webSearch ?? LLM_RESPONSE_WEB_SEARCH_DEFAULT,
      ),
  },
} as const;
