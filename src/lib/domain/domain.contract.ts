// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/types/schemas/domain.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { defineRouteContract, type RouteContract } from "../http/routeContract.ts";
import { researchScopeSchema } from "../../shared/researchScope.ts";

export const domainBrandQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

export const DOMAIN_COMMON_ERROR_CODES = [
  "invalid_request",
  "auth_not_configured",
  "unauthenticated",
  "membership_unavailable",
  "workspace_not_found",
  "feature_unavailable",
  "feature_disabled",
  "price_changed",
  "approval_required",
  "invalid_target",
  "filters_over_budget",
  "invalid_location",
  "domain_unavailable",
];

// --- 1. POST /api/customer/domain/overview ---
export const domainOverviewRequestBody = z.strictObject({
  domain: z.string().trim().min(1).max(2048),
  scope: researchScopeSchema.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  cacheOnly: z.boolean().default(false),
  maxUsd: z.number().positive().max(1000).optional(),
  requestId: z.string().uuid(),
});

export const domainOverviewResponseSchema = z.union([
  z.looseObject({
    status: z.literal("ok"),
    domain: z.string(),
    displayTarget: z.string(),
    scope: researchScopeSchema,
    organicTraffic: z.number().nullable(),
    organicKeywords: z.number().nullable(),
    hasData: z.boolean(),
    market: z.looseObject({
      locationCode: z.number(),
      languageCode: z.string(),
      country: z.string(),
    }),
    isOwnSite: z.boolean(),
    isDeclaredCompetitor: z.boolean(),
    cached: z.boolean(),
    fetchedAt: z.string(),
    provenance: z.looseObject({ gateway: z.literal("dataforseo") }),
  }),
  z.looseObject({
    status: z.literal("not_cached"),
    domain: z.string(),
    displayTarget: z.string(),
    scope: researchScopeSchema,
    market: z.looseObject({
      locationCode: z.number(),
      languageCode: z.string(),
      country: z.string(),
    }),
  }),
]);

const EXAMPLE_OVERVIEW_RESPONSE = {
  status: "ok" as const,
  domain: "offcult.in",
  displayTarget: "offcult.in",
  scope: "subdomains" as const,
  organicTraffic: 1840,
  organicKeywords: 312,
  hasData: true,
  market: { locationCode: 2356, languageCode: "en", country: "India" },
  isOwnSite: true,
  isDeclaredCompetitor: false,
  cached: false,
  fetchedAt: "2026-10-21T09:30:00.000Z",
  provenance: { gateway: "dataforseo" as const },
};

export const domainOverviewContract = defineRouteContract({
  id: "customer.domain.overview",
  method: "POST",
  path: "/api/customer/domain/overview",
  file: "src/app/api/customer/domain/overview/route.ts",
  auth: "workspace",
  query: domainBrandQuery,
  request: domainOverviewRequestBody,
  response: domainOverviewResponseSchema,
  errorCodes: DOMAIN_COMMON_ERROR_CODES,
  examples: [{ response: EXAMPLE_OVERVIEW_RESPONSE }],
});

// --- 2. POST /api/customer/domain/keywords ---
export const domainKeywordsFiltersSchema = z.strictObject({
  include: z.string().optional(),
  exclude: z.string().optional(),
  minTraffic: z.number().optional(),
  maxTraffic: z.number().optional(),
  minVol: z.number().optional(),
  maxVol: z.number().optional(),
  minVolume: z.number().optional(),
  maxVolume: z.number().optional(),
  minCpc: z.number().optional(),
  maxCpc: z.number().optional(),
  minKd: z.number().optional(),
  maxKd: z.number().optional(),
  minDifficulty: z.number().optional(),
  maxDifficulty: z.number().optional(),
  minRank: z.number().optional(),
  maxRank: z.number().optional(),
});

export const domainKeywordsRequestBody = z.strictObject({
  domain: z.string().trim().min(1).max(2048),
  scope: researchScopeSchema.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  cacheOnly: z.boolean().default(false),
  maxUsd: z.number().positive().max(1000).optional(),
  requestId: z.string().uuid(),
  page: z.number().int().positive().default(1),
  pageSize: z
    .union([z.literal(50), z.literal(100), z.literal(200)])
    .default(50),
  sortMode: z
    .enum(["rank", "traffic", "volume", "score", "cpc"])
    .default("traffic"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  filters: domainKeywordsFiltersSchema.default({}),
  search: z.string().max(200).optional(),
});

export const domainKeywordsResponseSchema = z.union([
  z.looseObject({
    status: z.literal("ok"),
    domain: z.string(),
    page: z.number(),
    pageSize: z.number(),
    totalCount: z.number().nullable(),
    hasMore: z.boolean(),
    keywords: z.array(
      z.looseObject({
        keyword: z.string(),
        position: z.number().nullable(),
        searchVolume: z.number().nullable(),
        traffic: z.number().nullable(),
        cpc: z.number().nullable(),
        url: z.string().nullable(),
        relativeUrl: z.string().nullable(),
        keywordDifficulty: z.number().nullable(),
      }),
    ),
    cached: z.boolean(),
    fetchedAt: z.string(),
    provenance: z.looseObject({ gateway: z.literal("dataforseo") }),
  }),
  z.looseObject({
    status: z.literal("not_cached"),
    domain: z.string(),
    page: z.number(),
    pageSize: z.number(),
  }),
]);

const EXAMPLE_KEYWORDS_RESPONSE = {
  status: "ok" as const,
  domain: "offcult.in",
  page: 1,
  pageSize: 50,
  totalCount: 312,
  hasMore: true,
  keywords: [
    {
      keyword: "oversized t shirt",
      position: 7,
      searchVolume: 74000,
      traffic: 1290.5,
      cpc: 0.41,
      url: "https://offcult.in/collections/oversized",
      relativeUrl: "/collections/oversized",
      keywordDifficulty: 38,
    },
  ],
  cached: true,
  fetchedAt: "2026-10-21T09:30:01.000Z",
  provenance: { gateway: "dataforseo" as const },
};

export const domainKeywordsContract = defineRouteContract({
  id: "customer.domain.keywords",
  method: "POST",
  path: "/api/customer/domain/keywords",
  file: "src/app/api/customer/domain/keywords/route.ts",
  auth: "workspace",
  query: domainBrandQuery,
  request: domainKeywordsRequestBody,
  response: domainKeywordsResponseSchema,
  errorCodes: DOMAIN_COMMON_ERROR_CODES,
  examples: [{ response: EXAMPLE_KEYWORDS_RESPONSE }],
});

// --- 3. POST /api/customer/domain/pages ---
export const domainPagesFiltersSchema = z.strictObject({
  include: z.string().optional(),
  exclude: z.string().optional(),
  minTraffic: z.number().optional(),
  maxTraffic: z.number().optional(),
  minVol: z.number().optional(),
  maxVol: z.number().optional(),
});

export const domainPagesRequestBody = z.strictObject({
  domain: z.string().trim().min(1).max(2048),
  scope: researchScopeSchema.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  cacheOnly: z.boolean().default(false),
  maxUsd: z.number().positive().max(1000).optional(),
  requestId: z.string().uuid(),
  page: z.number().int().positive().default(1),
  pageSize: z
    .union([z.literal(50), z.literal(100), z.literal(200)])
    .default(50),
  sortMode: z.enum(["traffic", "keywords"]).default("traffic"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  filters: domainPagesFiltersSchema.default({}),
  search: z.string().max(200).optional(),
});

export const domainPagesResponseSchema = z.union([
  z.looseObject({
    status: z.literal("ok"),
    domain: z.string(),
    page: z.number(),
    pageSize: z.number(),
    totalCount: z.number().nullable(),
    hasMore: z.boolean(),
    pages: z.array(
      z.looseObject({
        page: z.string(),
        relativePath: z.string().nullable(),
        organicTraffic: z.number().nullable(),
        keywords: z.number().nullable(),
      }),
    ),
    cached: z.boolean(),
    fetchedAt: z.string(),
    provenance: z.looseObject({ gateway: z.literal("dataforseo") }),
  }),
  z.looseObject({
    status: z.literal("not_cached"),
    domain: z.string(),
    page: z.number(),
    pageSize: z.number(),
  }),
]);

const EXAMPLE_PAGES_RESPONSE = {
  status: "ok" as const,
  domain: "offcult.in",
  page: 1,
  pageSize: 50,
  totalCount: 42,
  hasMore: false,
  pages: [
    {
      page: "https://offcult.in/collections/oversized",
      relativePath: "/collections/oversized",
      organicTraffic: 1290.5,
      keywords: 34,
    },
  ],
  cached: false,
  fetchedAt: "2026-10-21T09:30:02.000Z",
  provenance: { gateway: "dataforseo" as const },
};

export const domainPagesContract = defineRouteContract({
  id: "customer.domain.pages",
  method: "POST",
  path: "/api/customer/domain/pages",
  file: "src/app/api/customer/domain/pages/route.ts",
  auth: "workspace",
  query: domainBrandQuery,
  request: domainPagesRequestBody,
  response: domainPagesResponseSchema,
  errorCodes: DOMAIN_COMMON_ERROR_CODES,
  examples: [{ response: EXAMPLE_PAGES_RESPONSE }],
});

// --- 4. POST /api/customer/domain/competitors ---
export const SERP_COMPETITOR_RESULT_TYPES = [
  "organic",
  "paid",
  "featured_snippet",
  "local_pack",
] as const;

export const domainCompetitorsRequestBody = z.strictObject({
  domain: z.string().trim().min(1).max(2048),
  scope: researchScopeSchema.optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(8).optional(),
  keywords: z.array(z.string().trim().min(1).max(120)).min(1).max(100),
  resultTypes: z
    .array(z.enum(SERP_COMPETITOR_RESULT_TYPES))
    .min(1)
    .max(4)
    .default(["organic", "local_pack"]),
  includeSubdomains: z.boolean().default(true),
  sortBy: z
    .enum(["visibility", "traffic_estimate", "avg_position", "keyword_count"])
    .default("visibility"),
  limit: z.number().int().min(10).max(100).default(50),
  cacheOnly: z.boolean().default(false),
  maxUsd: z.number().positive().max(1000).optional(),
  requestId: z.string().uuid(),
});

export const domainCompetitorsResponseSchema = z.union([
  z.looseObject({
    status: z.literal("ok"),
    keywordCount: z.number(),
    competitors: z.array(
      z.looseObject({
        domain: z.string(),
        keywordsCount: z.number().nullable(),
        avgPosition: z.number().nullable(),
        medianPosition: z.number().nullable(),
        visibility: z.number().nullable(),
        etv: z.number().nullable(),
        isOwnSite: z.boolean(),
        isDeclaredCompetitor: z.boolean(),
      }),
    ),
    cached: z.boolean(),
    fetchedAt: z.string(),
    provenance: z.looseObject({ gateway: z.literal("dataforseo") }),
  }),
  z.looseObject({
    status: z.literal("not_cached"),
    keywordCount: z.number(),
    competitors: z.array(z.any()).default([]),
  }),
]);

const EXAMPLE_COMPETITORS_RESPONSE = {
  status: "ok" as const,
  keywordCount: 50,
  competitors: [
    {
      domain: "bewakoof.com",
      keywordsCount: 31,
      avgPosition: 4.2,
      medianPosition: 3,
      visibility: 0.41,
      etv: 18120.5,
      isOwnSite: false,
      isDeclaredCompetitor: true,
    },
  ],
  cached: false,
  fetchedAt: "2026-10-21T09:31:00.000Z",
  provenance: { gateway: "dataforseo" as const },
};

export const domainCompetitorsContract = defineRouteContract({
  id: "customer.domain.competitors",
  method: "POST",
  path: "/api/customer/domain/competitors",
  file: "src/app/api/customer/domain/competitors/route.ts",
  auth: "workspace",
  query: domainBrandQuery,
  request: domainCompetitorsRequestBody,
  response: domainCompetitorsResponseSchema,
  errorCodes: DOMAIN_COMMON_ERROR_CODES,
  examples: [{ response: EXAMPLE_COMPETITORS_RESPONSE }],
});

// --- 5. POST /api/customer/domain/competitors/add ---
export const domainCompetitorAddRequestBody = z.strictObject({
  domain: z.string().trim().min(3).max(255),
  name: z.string().trim().min(1).max(120).optional(),
});

export const domainCompetitorAddResponseSchema = z.looseObject({
  competitor: z.looseObject({
    domain: z.string(),
    name: z.string().nullable(),
  }),
  added: z.boolean(),
});

const EXAMPLE_COMPETITOR_ADD_RESPONSE = {
  competitor: {
    domain: "bewakoof.com",
    name: null,
  },
  added: true,
};

export const domainCompetitorAddContract = defineRouteContract({
  id: "customer.domain.competitors.add",
  method: "POST",
  path: "/api/customer/domain/competitors/add",
  file: "src/app/api/customer/domain/competitors/add/route.ts",
  auth: "workspace",
  query: domainBrandQuery,
  request: domainCompetitorAddRequestBody,
  response: domainCompetitorAddResponseSchema,
  errorCodes: [
    ...DOMAIN_COMMON_ERROR_CODES,
    "context_invalid",
    "context_cap",
    "context_unavailable",
  ],
  examples: [{ response: EXAMPLE_COMPETITOR_ADD_RESPONSE }],
});

// --- 6. GET /api/customer/domain/competitors/declared ---
export const domainCompetitorsDeclaredResponseSchema = z.looseObject({
  available: z.boolean(),
  competitors: z.array(
    z.looseObject({
      domain: z.string(),
      name: z.string().nullable(),
    }),
  ),
  ownHost: z.string().optional(),
});

const EXAMPLE_COMPETITORS_DECLARED_RESPONSE = {
  available: true,
  competitors: [{ domain: "bewakoof.com", name: "Bewakoof" }],
  ownHost: "offcult.in",
};

export const domainCompetitorsDeclaredContract = defineRouteContract({
  id: "customer.domain.competitors.declared",
  method: "GET",
  path: "/api/customer/domain/competitors/declared",
  file: "src/app/api/customer/domain/competitors/declared/route.ts",
  auth: "workspace",
  query: domainBrandQuery,
  response: domainCompetitorsDeclaredResponseSchema,
  errorCodes: DOMAIN_COMMON_ERROR_CODES,
  examples: [{ response: EXAMPLE_COMPETITORS_DECLARED_RESPONSE }],
});

export const contracts: RouteContract[] = [
  domainOverviewContract,
  domainKeywordsContract,
  domainPagesContract,
  domainCompetitorsContract,
  domainCompetitorAddContract,
  domainCompetitorsDeclaredContract,
];
