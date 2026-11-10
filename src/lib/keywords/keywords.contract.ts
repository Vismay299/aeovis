// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/types/schemas/keywords.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { defineRouteContract, type RouteContract } from "../http/routeContract.ts";

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

export const contracts: RouteContract[] = [
  keywordResearchContract,
  serpContract,
];
