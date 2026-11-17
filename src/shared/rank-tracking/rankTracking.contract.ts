// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/types/schemas/rank-tracking.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { defineRouteContract, type RouteContract } from "../http/routeContract.ts";
import { DEVICES, RANK_SCHEDULES, COMPARE_PERIODS } from "../rank-tracking.ts";

const brandQuery = z.strictObject({ brand_key: z.string().min(1).max(200).optional() });

const scheduleTimeSchema = z.strictObject({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  weekday: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
}).passthrough();

const trackerSummary = z.looseObject({
  id: z.string(),
  domain: z.string(),
  locationCode: z.number(),
  languageCode: z.string(),
  locationName: z.string().nullable(),
  devices: z.enum(DEVICES),
  serpDepth: z.number(),
  scheduleInterval: z.enum(RANK_SCHEDULES),
  nextCheckAt: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  lastSkipReason: z.string().nullable(),
  lastSkipMessage: z.string().nullable(),
  approvedMaxUsd: z.number().nullable(),
  keywordCount: z.number(),
  lastRunStatus: z.string().nullable(),
  lastRunCompletedAt: z.string().nullable(),
});

const COMMON = [
  "invalid_request",
  "invalid_json",
  "auth_not_configured",
  "unauthenticated",
  "membership_unavailable",
  "workspace_not_found",
  "feature_unavailable",
  "feature_disabled",
  "tracker_not_found",
  "rank_tracking_unavailable",
];

export const listTrackersContract = defineRouteContract({
  id: "customer.rank-tracking.list",
  method: "GET",
  path: "/api/customer/rank-tracking/configs",
  file: "src/app/api/customer/rank-tracking/configs/route.ts",
  auth: "workspace",
  query: brandQuery,
  response: z.looseObject({ trackers: z.array(trackerSummary) }),
  errorCodes: COMMON,
  examples: [{ response: { trackers: [] } }],
});

export const createTrackerContract = defineRouteContract({
  id: "customer.rank-tracking.create",
  method: "POST",
  path: "/api/customer/rank-tracking/configs",
  file: "src/app/api/customer/rank-tracking/configs/route.ts",
  auth: "workspace",
  request: z.strictObject({
    brand_key: z.string().optional(),
    domain: z.string().trim().min(3).max(253),
    locationCode: z.number().int().positive().optional(),
    languageCode: z.string().min(2).max(10).optional(),
    locationName: z.string().trim().min(1).max(200).optional(),
    devices: z.enum(DEVICES).default("mobile"),
    serpDepth: z.number().int().min(10).max(100).default(40),
    scheduleInterval: z.enum(RANK_SCHEDULES).default("weekly"),
    scheduleTime: scheduleTimeSchema.optional(),
  }),
  response: z.looseObject({ tracker: trackerSummary }),
  errorCodes: [...COMMON, "invalid_domain", "schedule_weekday_required", "schedule_time_without_schedule", "invalid_location", "tracker_exists", "tracker_limit", "unknown_location"],
  examples: [{ response: { tracker: { id: "6f0c0000-0000-4000-8000-000000000000", domain: "offcult.in", locationCode: 2356, languageCode: "en", locationName: null, devices: "mobile", serpDepth: 40, scheduleInterval: "weekly", nextCheckAt: "2026-10-27T05:12:00.000Z", lastCheckedAt: null, lastSkipReason: null, lastSkipMessage: null, approvedMaxUsd: null, keywordCount: 0, lastRunStatus: null, lastRunCompletedAt: null } } }],
});

export const getTrackerContract = defineRouteContract({
  id: "customer.rank-tracking.get",
  method: "GET",
  path: "/api/customer/rank-tracking/configs/[configId]",
  file: "src/app/api/customer/rank-tracking/configs/[configId]/route.ts",
  auth: "workspace",
  query: brandQuery,
  response: z.looseObject({ tracker: trackerSummary }),
  errorCodes: COMMON,
  examples: [{ response: { tracker: { id: "6f0c0000-0000-4000-8000-000000000000", domain: "offcult.in", locationCode: 2356, languageCode: "en", locationName: null, devices: "mobile", serpDepth: 40, scheduleInterval: "weekly", nextCheckAt: null, lastCheckedAt: null, lastSkipReason: null, lastSkipMessage: null, approvedMaxUsd: null, keywordCount: 0, lastRunStatus: null, lastRunCompletedAt: null } } }],
});

export const updateTrackerContract = defineRouteContract({
  id: "customer.rank-tracking.update",
  method: "PATCH",
  path: "/api/customer/rank-tracking/configs/[configId]",
  file: "src/app/api/customer/rank-tracking/configs/[configId]/route.ts",
  auth: "workspace",
  request: z.strictObject({
    brand_key: z.string().optional(),
    domain: z.string().trim().min(3).max(253).optional(),
    locationCode: z.number().int().positive().optional(),
    languageCode: z.string().min(2).max(10).optional(),
    locationName: z.string().min(1).max(200).nullable().optional(),
    devices: z.enum(DEVICES).optional(),
    serpDepth: z.number().int().min(10).max(100).optional(),
    scheduleInterval: z.enum(RANK_SCHEDULES).optional(),
    scheduleTime: scheduleTimeSchema.optional(),
    isActive: z.boolean().optional(),
    maxUsd: z.number().positive().max(1000).optional(),
  }),
  response: z.looseObject({ tracker: trackerSummary }),
  errorCodes: [...COMMON, "approval_required", "price_changed", "tracker_exists", "unknown_location"],
  examples: [{ response: { tracker: { id: "6f0c0000-0000-4000-8000-000000000000", domain: "offcult.in", locationCode: 2356, languageCode: "en", locationName: null, devices: "mobile", serpDepth: 40, scheduleInterval: "weekly", nextCheckAt: null, lastCheckedAt: null, lastSkipReason: null, lastSkipMessage: null, approvedMaxUsd: 0.234, keywordCount: 0, lastRunStatus: null, lastRunCompletedAt: null } } }],
});

export const addKeywordsContract = defineRouteContract({
  id: "customer.rank-tracking.keywords.add",
  method: "POST",
  path: "/api/customer/rank-tracking/configs/[configId]/keywords",
  file: "src/app/api/customer/rank-tracking/configs/[configId]/keywords/route.ts",
  auth: "workspace",
  request: z.strictObject({
    brand_key: z.string().optional(),
    keywords: z.array(z.string().trim().min(1).max(200)).min(1).max(1000),
    matchCase: z.boolean().default(false),
    source: z.enum(["manual", "suggestions"]).default("manual"),
    maxUsd: z.number().positive().max(1000).optional(),
  }),
  response: z.looseObject({ added: z.number(), addedIds: z.array(z.string()), skipped: z.number(), metricsFromCache: z.number(), approval: z.any().nullable() }),
  errorCodes: [...COMMON, "approval_required", "price_changed", "keyword_limit"],
  examples: [{ response: { added: 18, addedIds: [], skipped: 2, metricsFromCache: 15, approval: null } }],
});

export const removeKeywordsContract = defineRouteContract({
  id: "customer.rank-tracking.keywords.remove",
  method: "POST",
  path: "/api/customer/rank-tracking/configs/[configId]/keywords/remove",
  file: "src/app/api/customer/rank-tracking/configs/[configId]/keywords/remove/route.ts",
  auth: "workspace",
  request: z.strictObject({ brand_key: z.string().optional(), keywordIds: z.array(z.string().uuid()).min(1).max(1000) }),
  response: z.looseObject({ removed: z.number(), removedIds: z.array(z.string()) }),
  errorCodes: COMMON,
  examples: [{ response: { removed: 2, removedIds: [] } }],
});

export const pinKeywordsContract = defineRouteContract({
  id: "customer.rank-tracking.keywords.pin",
  method: "POST",
  path: "/api/customer/rank-tracking/configs/[configId]/keywords/pin",
  file: "src/app/api/customer/rank-tracking/configs/[configId]/keywords/pin/route.ts",
  auth: "workspace",
  request: z.strictObject({ brand_key: z.string().optional(), keywordIds: z.array(z.string().uuid()).min(1).max(1000), pinned: z.boolean() }),
  response: z.looseObject({ updated: z.number(), updatedIds: z.array(z.string()) }),
  errorCodes: COMMON,
  examples: [{ response: { updated: 1, updatedIds: [] } }],
});

export const checkContract = defineRouteContract({
  id: "customer.rank-tracking.check",
  method: "POST",
  path: "/api/customer/rank-tracking/configs/[configId]/check",
  file: "src/app/api/customer/rank-tracking/configs/[configId]/check/route.ts",
  auth: "workspace",
  request: z.strictObject({ brand_key: z.string().optional(), keywordIds: z.array(z.string().uuid()).min(1).max(1000).optional(), maxUsd: z.number().positive().max(1000).optional() }),
  response: z.looseObject({ runId: z.string(), jobId: z.string(), status: z.string(), pollAfterSeconds: z.number() }),
  errorCodes: [...COMMON, "approval_required", "price_changed", "rank_check_running", "no_keywords", "tracker_archived", "daily_cap", "workspace_cap"],
  examples: [{ response: { runId: "a1000000-0000-4000-8000-000000000000", jobId: "b2000000-0000-4000-8000-000000000000", status: "queued", pollAfterSeconds: 3 } }],
});

export const latestRunContract = defineRouteContract({
  id: "customer.rank-tracking.runs.latest",
  method: "GET",
  path: "/api/customer/rank-tracking/configs/[configId]/runs/latest",
  file: "src/app/api/customer/rank-tracking/configs/[configId]/runs/latest/route.ts",
  auth: "workspace",
  query: brandQuery,
  response: z.looseObject({ run: z.any().nullable() }),
  errorCodes: COMMON,
  examples: [{ response: { run: null } }],
});

export const resultsContract = defineRouteContract({
  id: "customer.rank-tracking.results",
  method: "GET",
  path: "/api/customer/rank-tracking/configs/[configId]/results",
  file: "src/app/api/customer/rank-tracking/configs/[configId]/results/route.ts",
  auth: "workspace",
  query: z.strictObject({ brand_key: z.string().optional(), compare: z.enum(COMPARE_PERIODS).optional() }),
  response: z.looseObject({ rows: z.array(z.any()), run: z.any().nullable() }),
  errorCodes: COMMON,
  examples: [{ response: { rows: [], run: null } }],
});

export const trendContract = defineRouteContract({
  id: "customer.rank-tracking.trend",
  method: "GET",
  path: "/api/customer/rank-tracking/configs/[configId]/trend",
  file: "src/app/api/customer/rank-tracking/configs/[configId]/trend/route.ts",
  auth: "workspace",
  query: z.strictObject({ brand_key: z.string().optional(), device: z.enum(["desktop", "mobile"]).default("mobile"), sinceDays: z.coerce.number().int().positive().max(730).default(730) }),
  response: z.looseObject({ points: z.array(z.any()) }),
  errorCodes: COMMON,
  examples: [{ response: { points: [] } }],
});

export const matrixContract = defineRouteContract({
  id: "customer.rank-tracking.matrix",
  method: "GET",
  path: "/api/customer/rank-tracking/configs/[configId]/matrix",
  file: "src/app/api/customer/rank-tracking/configs/[configId]/matrix/route.ts",
  auth: "workspace",
  query: z.strictObject({ brand_key: z.string().optional(), device: z.enum(["desktop", "mobile"]).default("mobile"), runLimit: z.coerce.number().int().min(2).max(26).default(12) }),
  response: z.looseObject({ cells: z.array(z.any()) }),
  errorCodes: COMMON,
  examples: [{ response: { cells: [] } }],
});

export const historyContract = defineRouteContract({
  id: "customer.rank-tracking.history",
  method: "GET",
  path: "/api/customer/rank-tracking/configs/[configId]/keywords/[keywordId]/history",
  file: "src/app/api/customer/rank-tracking/configs/[configId]/keywords/[keywordId]/history/route.ts",
  auth: "workspace",
  query: z.strictObject({ brand_key: z.string().optional(), sinceDays: z.coerce.number().int().positive().max(730).default(90) }),
  response: z.looseObject({ points: z.array(z.any()) }),
  errorCodes: COMMON,
  examples: [{ response: { points: [] } }],
});

export const suggestionsContract = defineRouteContract({
  id: "customer.rank-tracking.suggestions",
  method: "POST",
  path: "/api/customer/rank-tracking/suggestions",
  file: "src/app/api/customer/rank-tracking/suggestions/route.ts",
  auth: "workspace",
  request: z.strictObject({
    brand_key: z.string().optional(),
    domain: z.string().trim().min(1).max(253),
    locationCode: z.number().int().positive(),
    languageCode: z.string().min(2).max(8).optional(),
    cacheOnly: z.boolean().default(false),
    maxUsd: z.number().positive().max(1000).optional(),
    requestId: z.string().uuid(),
  }),
  response: z.looseObject({
    keywords: z.array(z.looseObject({
      keyword: z.string(),
      position: z.number().nullable(),
      searchVolume: z.number().nullable(),
      traffic: z.number().nullable(),
      cpc: z.number().nullable(),
      keywordDifficulty: z.number().nullable(),
    })).nullable(),
    cached: z.boolean(),
    fetchedAt: z.string(),
  }),
  errorCodes: [...COMMON, "price_changed", "suggestions_unavailable", "rank_suggestions_unavailable", "daily_cap", "workspace_cap"],
  examples: [
    { response: { keywords: [{ keyword: "oversized t shirts", position: 7, searchVolume: 12100, traffic: 410.5, cpc: 0.41, keywordDifficulty: 34 }], cached: false, fetchedAt: "2026-10-27T05:12:00.000Z" } },
    { response: { keywords: null, cached: true, fetchedAt: "2026-10-27T05:12:00.000Z" } },
  ],
});

export const metricsRefreshContract = defineRouteContract({
  id: "customer.rank-tracking.metrics.refresh",
  method: "POST",
  path: "/api/customer/rank-tracking/configs/[configId]/metrics/refresh",
  file: "src/app/api/customer/rank-tracking/configs/[configId]/metrics/refresh/route.ts",
  auth: "workspace",
  request: z.strictObject({
    brand_key: z.string().optional(),
    maxUsd: z.number().positive().max(1000).optional(),
    requestId: z.string().uuid(),
  }),
  response: z.looseObject({ updated: z.number(), fromCache: z.number(), bought: z.number() }),
  errorCodes: [...COMMON, "approval_required", "price_changed", "nothing_to_refresh", "rank_metrics_unavailable", "daily_cap", "workspace_cap"],
  examples: [{ response: { updated: 20, fromCache: 15, bought: 5 } }],
});

export const trackAiQuestionContract = defineRouteContract({
  id: "customer.rank-tracking.keywords.ai-question",
  method: "POST",
  path: "/api/customer/rank-tracking/configs/[configId]/keywords/[keywordId]/ai-question",
  file: "src/app/api/customer/rank-tracking/configs/[configId]/keywords/[keywordId]/ai-question/route.ts",
  auth: "workspace",
  request: z.strictObject({
    brand_key: z.string().optional(),
    text: z.string().trim().min(2).max(1500),
    topic: z.string().trim().max(120).optional(),
  }),
  response: z.looseObject({
    questionId: z.string().uuid(),
    created: z.boolean(),
    revived: z.boolean(),
    linked: z.boolean(),
  }),
  errorCodes: [
    ...COMMON,
    "feature_unavailable",
    "keyword_not_found",
    "question_limit",
    "topic_limit",
    "question_duplicate",
    "questions_unavailable",
  ],
  examples: [
    {
      response: {
        questionId: "50000000-0000-4000-8000-000000000001",
        created: true,
        revived: false,
        linked: true,
      },
    },
  ],
});

export const contracts: RouteContract[] = [
  listTrackersContract,
  createTrackerContract,
  getTrackerContract,
  updateTrackerContract,
  addKeywordsContract,
  removeKeywordsContract,
  pinKeywordsContract,
  checkContract,
  latestRunContract,
  resultsContract,
  trendContract,
  matrixContract,
  historyContract,
  suggestionsContract,
  metricsRefreshContract,
  trackAiQuestionContract,
];
