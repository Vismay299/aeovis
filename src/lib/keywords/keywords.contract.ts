// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/types/schemas/keywords.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { defineRouteContract, type RouteContract } from "../http/routeContract.ts";
import { TAG_COLOR_KEYS } from "../../shared/tag-colors.ts";

export const keywordResearchRequestBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  keyword: z.string().trim().min(1).max(200),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  locationName: z.string().min(1).max(200).optional(),
  resultLimit: z.union([z.literal(150), z.literal(300), z.literal(500)]).default(150),
  mode: z.enum(["auto", "related", "suggestions", "ideas"]).default("auto"),
  clickstream: z.boolean().default(false),
  groupKeywords: z.boolean().default(false),
  maxUsd: z.number().positive().max(1000).optional(),
  requestId: z.string().min(1).max(200).optional(),
  cacheOnly: z.boolean().default(false),
});

export const keywordResearchResponseBody = z.looseObject({
  rows: z
    .array(
      z.looseObject({
        keyword: z.string(),
        searchVolume: z.number().nullable(),
        trend: z.array(
          z.looseObject({
            year: z.number(),
            month: z.number(),
            searchVolume: z.number(),
          }),
        ),
        cpc: z.number().nullable(),
        competition: z.number().nullable(),
        keywordDifficulty: z.number().nullable(),
        intent: z.string(),
      }),
    )
    .optional(),
  source: z.string().optional(),
  usedFallback: z.boolean().optional(),
  cached: z.boolean().optional(),
  notCached: z.boolean().optional(),
  fetchedAt: z.string().optional(),
});

export const serpRequestBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  keyword: z.string().trim().min(1).max(200),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  locationName: z.string().min(1).max(200).optional(),
  depth: z.union([z.literal(20), z.literal(100)]).default(20),
  maxUsd: z.number().positive().max(1000).optional(),
  requestId: z.string().min(1).max(200).optional(),
  cacheOnly: z.boolean().default(false),
});

export const serpResponseBody = z.looseObject({
  requestedKeyword: z.string().optional(),
  items: z
    .array(
      z.looseObject({
        rank: z.number(),
        title: z.string(),
        url: z.string(),
        domain: z.string(),
        description: z.string(),
        etv: z.number().nullable(),
        estimatedPaidTrafficCost: z.number().nullable(),
        referringDomains: z.number().nullable(),
        backlinks: z.number().nullable(),
        isNew: z.boolean(),
        rankChange: z.number().nullable(),
      }),
    )
    .optional(),
  depth: z.number().optional(),
  reason: z.string().optional(),
  cached: z.boolean().optional(),
  notCached: z.boolean().optional(),
  fetchedAt: z.string().optional(),
});

export const keywordResearchContract = defineRouteContract({
  id: "customer.keywords.research",
  method: "POST",
  path: "/api/customer/keywords/research",
  file: "src/app/api/customer/keywords/research/route.ts",
  auth: "workspace",
  request: keywordResearchRequestBody,
  response: keywordResearchResponseBody,
  errorCodes: [
    "invalid_request",
    "invalid_json",
    "invalid_location",
    "approval_required",
    "price_changed",
    "feature_unavailable",
    "research_invalid",
    "spend_refused",
    "daily_cap",
    "workspace_cap",
    "unauthenticated",
    "unauthorized",
    "workspace_not_found",
  ],
  examples: [
    {
      response: {
        rows: [
          {
            keyword: "seo tools",
            searchVolume: 1000,
            trend: [{ year: 2026, month: 10, searchVolume: 1000 }],
            cpc: 2.5,
            competition: 0.8,
            keywordDifficulty: 65,
            intent: "commercial",
          },
        ],
        source: "blended",
        usedFallback: false,
        cached: false,
        fetchedAt: "2026-11-10T12:00:00.000Z",
      },
    },
    {
      response: {
        notCached: true,
        cached: false,
      },
    },
  ],
});

export const serpContract = defineRouteContract({
  id: "customer.keywords.serp",
  method: "POST",
  path: "/api/customer/keywords/serp",
  file: "src/app/api/customer/keywords/serp/route.ts",
  auth: "workspace",
  request: serpRequestBody,
  response: serpResponseBody,
  errorCodes: [
    "invalid_request",
    "invalid_json",
    "invalid_location",
    "approval_required",
    "price_changed",
    "feature_unavailable",
    "spend_refused",
    "daily_cap",
    "workspace_cap",
    "unauthenticated",
    "unauthorized",
    "workspace_not_found",
  ],
  examples: [
    {
      response: {
        requestedKeyword: "seo tools",
        items: [
          {
            rank: 1,
            title: "Best SEO Tools 2026",
            url: "https://example.com/seo-tools",
            domain: "example.com",
            description: "Top seo tools overview.",
            etv: null,
            estimatedPaidTrafficCost: null,
            referringDomains: null,
            backlinks: null,
            isNew: false,
            rankChange: null,
          },
        ],
        depth: 20,
        cached: false,
        fetchedAt: "2026-11-10T12:00:00.000Z",
      },
    },
    {
      response: {
        notCached: true,
        cached: false,
      },
    },
  ],
});

// Phase 3 Schemas & Contracts

export const savedKeywordTagSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  normalizedName: z.string(),
  color: z.string().nullable(),
});

export const savedKeywordTagSummarySchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  normalizedName: z.string(),
  color: z.string().nullable(),
  keywordCount: z.number(),
});

export const savedKeywordRowSchema = z.looseObject({
  id: z.string(),
  keyword: z.string(),
  locationCode: z.number(),
  languageCode: z.string(),
  createdAt: z.string(),
  searchVolume: z.number().nullable(),
  cpc: z.number().nullable(),
  competition: z.number().nullable(),
  keywordDifficulty: z.number().nullable(),
  intent: z.string().nullable(),
  monthlySearches: z.array(
    z.looseObject({
      year: z.number(),
      month: z.number(),
      searchVolume: z.number(),
    }),
  ),
  fetchedAt: z.string().nullable(),
  tags: z.array(savedKeywordTagSchema),
});

export const savedKeywordsGetQuery = z.strictObject({
  brand_key: z.string().min(1).max(200),
  q: z.string().max(200).optional(),
  include: z.string().max(500).optional(),
  exclude: z.string().max(500).optional(),
  minVol: z.coerce.number().min(0).optional(),
  maxVol: z.coerce.number().min(0).optional(),
  minCpc: z.coerce.number().min(0).optional(),
  maxCpc: z.coerce.number().min(0).optional(),
  minKd: z.coerce.number().min(0).optional(),
  maxKd: z.coerce.number().min(0).optional(),
  tags: z.string().max(2500).optional(),
  tagNames: z.string().max(2500).optional(),
  page: z.coerce.number().int().positive().default(1),
  size: z.coerce.number().pipe(z.union([z.literal(50), z.literal(100), z.literal(250)])).default(50),
  sort: z.string().default("fetchedAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export const savedKeywordsGetResponse = z.looseObject({
  rows: z.array(savedKeywordRowSchema),
  totalCount: z.number(),
  page: z.number(),
  pageSize: z.number(),
  tags: z.array(savedKeywordTagSummarySchema),
});

export const savedKeywordsListContract = defineRouteContract({
  id: "customer.keywords.saved.list",
  method: "GET",
  path: "/api/customer/keywords/saved",
  file: "src/app/api/customer/keywords/saved/route.ts",
  auth: "workspace",
  query: savedKeywordsGetQuery,
  response: savedKeywordsGetResponse,
  errorCodes: [
    "invalid_request",
    "feature_unavailable",
    "unauthenticated",
    "unauthorized",
    "workspace_not_found",
  ],
  examples: [
    {
      response: {
        rows: [
          {
            id: "4c0e0000-0000-0000-0000-000000000001",
            keyword: "oversized t shirt",
            locationCode: 2356,
            languageCode: "en",
            createdAt: "2026-10-20T10:00:00Z",
            searchVolume: 74000,
            cpc: 0.41,
            competition: 1,
            keywordDifficulty: 38,
            intent: "transactional",
            monthlySearches: [],
            fetchedAt: "2026-10-20T09:59:00Z",
            tags: [
              {
                id: "9a100000-0000-0000-0000-000000000001",
                name: "Tees",
                normalizedName: "tees",
                color: null,
              },
            ],
          },
        ],
        totalCount: 1,
        page: 1,
        pageSize: 50,
        tags: [
          {
            id: "9a100000-0000-0000-0000-000000000001",
            name: "Tees",
            normalizedName: "tees",
            color: null,
            keywordCount: 1,
          },
        ],
      },
    },
  ],
});

export const savedKeywordsPostBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  keywords: z.array(z.string().trim().min(1).max(200)).min(1).max(500),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  tags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  tagMode: z.enum(["append", "replace"]).default("append"),
}).refine(
  (data) => data.tagMode !== "replace" || (data.tags && data.tags.length > 0),
  { message: "Replacement tags are required when tagMode is replace." },
);

export const savedKeywordsPostResponse = z.looseObject({
  savedKeywordIds: z.array(z.string()),
  created: z.number(),
});

export const savedKeywordsSaveContract = defineRouteContract({
  id: "customer.keywords.saved.save",
  method: "POST",
  path: "/api/customer/keywords/saved",
  file: "src/app/api/customer/keywords/saved/route.ts",
  auth: "workspace",
  request: savedKeywordsPostBody,
  response: savedKeywordsPostResponse,
  errorCodes: [
    "invalid_request",
    "invalid_json",
    "saved_keywords_limit",
    "tag_limit",
    "keywords_unavailable",
    "feature_unavailable",
    "unauthenticated",
    "unauthorized",
    "workspace_not_found",
  ],
  examples: [
    {
      response: {
        savedKeywordIds: ["4c0e0000-0000-0000-0000-000000000001"],
        created: 1,
      },
    },
  ],
});

export const savedKeywordsRemoveBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  savedKeywordIds: z.array(z.string().uuid()).min(1).max(2000),
});

export const savedKeywordsRemoveResponse = z.looseObject({
  deletedCount: z.number(),
});

export const savedKeywordsRemoveContract = defineRouteContract({
  id: "customer.keywords.saved.remove",
  method: "POST",
  path: "/api/customer/keywords/saved/remove",
  file: "src/app/api/customer/keywords/saved/remove/route.ts",
  auth: "workspace",
  request: savedKeywordsRemoveBody,
  response: savedKeywordsRemoveResponse,
  errorCodes: [
    "invalid_request",
    "invalid_json",
    "feature_unavailable",
    "unauthenticated",
    "unauthorized",
    "workspace_not_found",
  ],
  examples: [
    {
      response: {
        deletedCount: 2,
      },
    },
  ],
});

export const savedKeywordsTagsBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  savedKeywordIds: z.array(z.string().uuid()).min(1).max(2000),
  addTags: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  removeTagIds: z.array(z.string().uuid()).max(50).optional(),
}).refine(
  (data) => (data.addTags && data.addTags.length > 0) || (data.removeTagIds && data.removeTagIds.length > 0),
  { message: "Add or remove at least one tag." },
);

export const savedKeywordsTagsResponse = z.looseObject({
  taggedCount: z.number(),
  addedTags: z.array(savedKeywordTagSchema),
  removedTagIds: z.array(z.string()),
  removedAssignments: z.number(),
});

export const savedKeywordsTagsContract = defineRouteContract({
  id: "customer.keywords.saved.tags",
  method: "POST",
  path: "/api/customer/keywords/saved/tags",
  file: "src/app/api/customer/keywords/saved/tags/route.ts",
  auth: "workspace",
  request: savedKeywordsTagsBody,
  response: savedKeywordsTagsResponse,
  errorCodes: [
    "invalid_request",
    "invalid_json",
    "tag_limit",
    "feature_unavailable",
    "unauthenticated",
    "unauthorized",
    "workspace_not_found",
  ],
  examples: [
    {
      response: {
        taggedCount: 2,
        addedTags: [
          {
            id: "9a100000-0000-0000-0000-000000000001",
            name: "Tees",
            normalizedName: "tees",
            color: null,
          },
        ],
        removedTagIds: [],
        removedAssignments: 0,
      },
    },
  ],
});

export const tagPatchBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  name: z.string().trim().min(1).max(64).optional(),
  color: z.enum(TAG_COLOR_KEYS).nullable().optional(),
}).refine(
  (data) => data.name !== undefined || data.color !== undefined,
  { message: "Provide a name or color to update." },
);

export const tagPatchResponse = z.looseObject({
  tag: savedKeywordTagSchema,
});

export const tagPatchContract = defineRouteContract({
  id: "customer.keywords.tags.patch",
  method: "PATCH",
  path: "/api/customer/keywords/tags/[tagId]",
  file: "src/app/api/customer/keywords/tags/[tagId]/route.ts",
  auth: "workspace",
  request: tagPatchBody,
  response: tagPatchResponse,
  errorCodes: [
    "invalid_request",
    "invalid_json",
    "tag_not_found",
    "tag_name_taken",
    "feature_unavailable",
    "unauthenticated",
    "unauthorized",
    "workspace_not_found",
  ],
  examples: [
    {
      response: {
        tag: {
          id: "9a100000-0000-0000-0000-000000000001",
          name: "Tees",
          normalizedName: "tees",
          color: "sky",
        },
      },
    },
  ],
});

export const tagDeleteQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

export const tagDeleteResponse = z.looseObject({
  deleted: z.boolean(),
});

export const tagDeleteContract = defineRouteContract({
  id: "customer.keywords.tags.delete",
  method: "DELETE",
  path: "/api/customer/keywords/tags/[tagId]",
  file: "src/app/api/customer/keywords/tags/[tagId]/route.ts",
  auth: "workspace",
  query: tagDeleteQuery,
  response: tagDeleteResponse,
  errorCodes: [
    "invalid_request",
    "tag_not_found",
    "tag_in_use",
    "feature_unavailable",
    "unauthenticated",
    "unauthorized",
    "workspace_not_found",
  ],
  examples: [
    {
      response: {
        deleted: true,
      },
    },
  ],
});

export const savedKeywordsExportQuery = z.strictObject({
  brand_key: z.string().min(1).max(200),
  q: z.string().max(200).optional(),
  include: z.string().max(500).optional(),
  exclude: z.string().max(500).optional(),
  minVol: z.coerce.number().min(0).optional(),
  maxVol: z.coerce.number().min(0).optional(),
  minCpc: z.coerce.number().min(0).optional(),
  maxCpc: z.coerce.number().min(0).optional(),
  minKd: z.coerce.number().min(0).optional(),
  maxKd: z.coerce.number().min(0).optional(),
  tags: z.string().max(2500).optional(),
  tagNames: z.string().max(2500).optional(),
  sort: z.string().default("fetchedAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export const savedKeywordsExportResponse = z.looseObject({
  rows: z.array(savedKeywordRowSchema),
  totalCount: z.number(),
  truncated: z.boolean(),
});

export const savedKeywordsExportContract = defineRouteContract({
  id: "customer.keywords.saved.export",
  method: "GET",
  path: "/api/customer/keywords/saved/export",
  file: "src/app/api/customer/keywords/saved/export/route.ts",
  auth: "workspace",
  query: savedKeywordsExportQuery,
  response: savedKeywordsExportResponse,
  errorCodes: [
    "invalid_request",
    "feature_unavailable",
    "unauthenticated",
    "unauthorized",
    "workspace_not_found",
  ],
  examples: [
    {
      response: {
        rows: [
          {
            id: "4c0e0000-0000-0000-0000-000000000001",
            keyword: "oversized t shirt",
            locationCode: 2356,
            languageCode: "en",
            createdAt: "2026-10-20T10:00:00Z",
            searchVolume: 74000,
            cpc: 0.41,
            competition: 1,
            keywordDifficulty: 38,
            intent: "transactional",
            monthlySearches: [],
            fetchedAt: "2026-10-20T09:59:00Z",
            tags: [],
          },
        ],
        totalCount: 1,
        truncated: false,
      },
    },
  ],
});

export const savedKeywordsRefreshBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  maxUsd: z.number().positive().max(1000).optional(),
});

export const savedKeywordsRefreshResponse = z.looseObject({
  jobId: z.string(),
  status: z.literal("queued"),
  pollAfterSeconds: z.number(),
});

export const savedKeywordsRefreshContract = defineRouteContract({
  id: "customer.keywords.saved.refresh",
  method: "POST",
  path: "/api/customer/keywords/saved/refresh",
  file: "src/app/api/customer/keywords/saved/refresh/route.ts",
  auth: "workspace",
  request: savedKeywordsRefreshBody,
  response: savedKeywordsRefreshResponse,
  errorCodes: [
    "invalid_request",
    "invalid_json",
    "nothing_to_refresh",
    "refresh_running",
    "job_already_running",
    "approval_required",
    "price_changed",
    "feature_unavailable",
    "unauthenticated",
    "unauthorized",
    "workspace_not_found",
  ],
  examples: [
    {
      response: {
        jobId: "00000000-0000-0000-0000-000000000001",
        status: "queued" as const,
        pollAfterSeconds: 5,
      },
    },
  ],
});

export const keywordLocationsQuery = z.strictObject({
  brand_key: z.string().min(1).max(200),
  country: z.string().regex(/^[a-z]{2}$/i),
  q: z.string().min(1).max(100),
});

export const keywordLocationsResponse = z.looseObject({
  locations: z.array(
    z.looseObject({
      locationName: z.string(),
      displayLabel: z.string(),
      locationType: z.string(),
    }),
  ),
});

export const keywordLocationsContract = defineRouteContract({
  id: "customer.keywords.locations",
  method: "GET",
  path: "/api/customer/keywords/locations",
  file: "src/app/api/customer/keywords/locations/route.ts",
  auth: "workspace",
  query: keywordLocationsQuery,
  response: keywordLocationsResponse,
  errorCodes: [
    "invalid_request",
    "locations_unavailable",
    "feature_unavailable",
    "unauthenticated",
    "unauthorized",
    "workspace_not_found",
  ],
  examples: [
    {
      response: {
        locations: [
          {
            locationName: "Mumbai,Maharashtra,India",
            displayLabel: "Mumbai, Maharashtra, India",
            locationType: "City",
          },
        ],
      },
    },
  ],
});

export const clusterBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  savedKeywordIds: z.array(z.string().uuid()).min(10).max(500),
  maxUsd: z.number().positive().max(1000).optional(),
});

export const clusterResponse = z.looseObject({
  jobId: z.string(),
  status: z.literal("queued"),
  pollAfterSeconds: z.number(),
});

export const clusterContract = defineRouteContract({
  id: "customer.keywords.cluster",
  method: "POST",
  path: "/api/customer/keywords/cluster",
  file: "src/app/api/customer/keywords/cluster/route.ts",
  auth: "workspace",
  request: clusterBody,
  response: clusterResponse,
  errorCodes: [
    "invalid_request",
    "invalid_json",
    "too_few_keywords",
    "job_already_running",
    "approval_required",
    "price_changed",
    "feature_unavailable",
    "unauthenticated",
    "unauthorized",
    "workspace_not_found",
  ],
  examples: [
    {
      response: {
        jobId: "00000000-0000-0000-0000-000000000001",
        status: "queued" as const,
        pollAfterSeconds: 3,
      },
    },
  ],
});

export const clusterApplyBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  jobId: z.string().uuid(),
  clusters: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(64),
        savedKeywordIds: z.array(z.string().uuid()).min(1).max(500),
      }),
    )
    .min(1)
    .max(60),
});

export const clusterApplyResponse = z.looseObject({
  taggedCount: z.number(),
  tags: z.array(z.looseObject({})),
});

export const clusterApplyContract = defineRouteContract({
  id: "customer.keywords.cluster.apply",
  method: "POST",
  path: "/api/customer/keywords/cluster/apply",
  file: "src/app/api/customer/keywords/cluster/apply/route.ts",
  auth: "workspace",
  request: clusterApplyBody,
  response: clusterApplyResponse,
  errorCodes: [
    "invalid_request",
    "invalid_json",
    "job_not_found",
    "job_not_ready",
    "tag_limit",
    "feature_unavailable",
    "unauthenticated",
    "unauthorized",
    "workspace_not_found",
  ],
  examples: [
    {
      response: {
        taggedCount: 9,
        tags: [],
      },
    },
  ],
});

export const trackQuestionBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  keyword: z.string().trim().min(1).max(200),
  text: z.string().trim().min(2).max(1500),
  topic: z.string().trim().min(1).max(100).optional(),
  locationCode: z.number().int().positive(),
  languageCode: z.string().min(2).max(8),
});

export const trackQuestionResponse = z.looseObject({
  question: z.looseObject({
    id: z.string(),
    text: z.string(),
    status: z.string(),
    topic: z.string(),
  }),
  created: z.boolean(),
  revived: z.boolean(),
});

export const trackQuestionContract = defineRouteContract({
  id: "customer.keywords.track_question",
  method: "POST",
  path: "/api/customer/keywords/track-question",
  file: "src/app/api/customer/keywords/track-question/route.ts",
  auth: "workspace",
  request: trackQuestionBody,
  response: trackQuestionResponse,
  errorCodes: [
    "invalid_request",
    "invalid_json",
    "feature_unavailable",
    "question_limit",
    "topic_limit",
    "question_duplicate",
    "questions_unavailable",
    "unauthenticated",
    "unauthorized",
    "workspace_not_found",
  ],
  examples: [
    {
      response: {
        question: {
          id: "11111111-1111-4111-8111-111111111111",
          text: "Which brands make the best oversized t-shirts in India?",
          status: "active",
          topic: "General",
        },
        created: true,
        revived: false,
      },
    },
  ],
});

export const contracts: RouteContract[] = [
  keywordResearchContract,
  serpContract,
  savedKeywordsListContract,
  savedKeywordsSaveContract,
  savedKeywordsRemoveContract,
  savedKeywordsTagsContract,
  tagPatchContract,
  tagDeleteContract,
  savedKeywordsExportContract,
  savedKeywordsRefreshContract,
  keywordLocationsContract,
  clusterContract,
  clusterApplyContract,
  trackQuestionContract,
];
