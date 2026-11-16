// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/types/schemas/backlinks.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { defineRouteContract, type RouteContract } from "../http/routeContract.ts";
import { researchScopeSchema } from "../../shared/researchScope.ts";
import {
  BACKLINKS_TABS,
  backlinksRowsFiltersSchema,
  backlinksRowsModeSchema,
  backlinksRowsSortFieldSchema,
  backlinksScopeParamSchema,
  referringDomainsFiltersSchema,
  referringDomainsSortFieldSchema,
  topPagesFiltersSchema,
  topPagesSortFieldSchema,
} from "../../shared/backlinks.ts";

export const backlinksBrandQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

export const BACKLINKS_COMMON_ERROR_CODES = [
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
  "subfolder_not_supported",
  "backlinks_unavailable",
  "already_tracked",
  "snapshot_target_limit",
  "snapshot_target_not_found",
  "snapshots_unavailable",
];

// --- 1. POST /api/customer/backlinks/overview ---
export const backlinksOverviewRequestBody = z.strictObject({
  target: z.string().trim().min(1).max(2048),
  scope: backlinksScopeParamSchema.optional(),
  tab: z.enum(BACKLINKS_TABS).default("backlinks"),
  pageSize: z
    .union([z.literal(50), z.literal(100), z.literal(200)])
    .default(50),
  cacheOnly: z.boolean().default(false),
  maxUsd: z.number().positive().max(1000).optional(),
  requestId: z.string().uuid(),
});

export const backlinksOverviewResponseSchema = z.union([
  z.looseObject({
    status: z.literal("ok"),
    target: z.string(),
    displayTarget: z.string(),
    scope: researchScopeSchema,
    summary: z.looseObject({
      rank: z.number().nullable(),
      backlinks: z.number().nullable(),
      referringPages: z.number().nullable(),
      referringDomains: z.number().nullable(),
      brokenBacklinks: z.number().nullable(),
      brokenPages: z.number().nullable(),
      backlinksSpamScore: z.number().nullable(),
      targetSpamScore: z.number().nullable(),
      newBacklinks: z.number().nullable(),
      lostBacklinks: z.number().nullable(),
      newReferringDomains: z.number().nullable(),
      lostReferringDomains: z.number().nullable(),
    }),
    trends: z.array(
      z.looseObject({
        date: z.string(),
        backlinks: z.number(),
        referringDomains: z.number(),
        rank: z.number().nullable(),
      }),
    ),
    newLostTrends: z.array(
      z.looseObject({
        date: z.string(),
        newBacklinks: z.number(),
        lostBacklinks: z.number(),
        newReferringDomains: z.number(),
        lostReferringDomains: z.number(),
      }),
    ),
    tracked: z
      .looseObject({
        interval: z.enum(["weekly", "monthly"]),
        nextRunAt: z.string(),
      })
      .nullable(),
    isOwnSite: z.boolean(),
    isDeclaredCompetitor: z.boolean(),
    cached: z.boolean(),
    fetchedAt: z.string(),
    provenance: z.looseObject({ gateway: z.literal("dataforseo") }),
  }),
  z.looseObject({
    status: z.literal("not_cached"),
    target: z.string(),
    displayTarget: z.string(),
    scope: researchScopeSchema,
  }),
]);

const EXAMPLE_OVERVIEW_RESPONSE = {
  status: "ok" as const,
  target: "offcult.in",
  displayTarget: "offcult.in",
  scope: "subdomains" as const,
  summary: {
    rank: 21,
    backlinks: 4120,
    referringPages: 2980,
    referringDomains: 312,
    brokenBacklinks: 14,
    brokenPages: 3,
    backlinksSpamScore: 12,
    targetSpamScore: 4,
    newBacklinks: 85,
    lostBacklinks: 40,
    newReferringDomains: 9,
    lostReferringDomains: 5,
  },
  trends: [
    {
      date: "2025-10-31",
      backlinks: 3810,
      referringDomains: 290,
      rank: 20,
    },
  ],
  newLostTrends: [
    {
      date: "2025-10-31",
      newBacklinks: 70,
      lostBacklinks: 22,
      newReferringDomains: 6,
      lostReferringDomains: 2,
    },
  ],
  tracked: null,
  isOwnSite: true,
  isDeclaredCompetitor: false,
  cached: false,
  fetchedAt: "2026-10-21T09:30:00.000Z",
  provenance: { gateway: "dataforseo" as const },
};

export const backlinksOverviewContract = defineRouteContract({
  id: "customer.backlinks.overview",
  method: "POST",
  path: "/api/customer/backlinks/overview",
  file: "src/app/api/customer/backlinks/overview/route.ts",
  auth: "workspace",
  query: backlinksBrandQuery,
  request: backlinksOverviewRequestBody,
  response: backlinksOverviewResponseSchema,
  errorCodes: BACKLINKS_COMMON_ERROR_CODES,
  examples: [{ response: EXAMPLE_OVERVIEW_RESPONSE }],
});

// --- 2. POST /api/customer/backlinks/rows ---
export const backlinksRowsRequestBody = z.strictObject({
  target: z.string().trim().min(1).max(2048),
  scope: backlinksScopeParamSchema.optional(),
  page: z.number().int().positive().default(1),
  pageSize: z
    .union([z.literal(50), z.literal(100), z.literal(200)])
    .default(50),
  sortField: backlinksRowsSortFieldSchema.default("firstSeen"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  filters: backlinksRowsFiltersSchema.default({}),
  mode: backlinksRowsModeSchema.default("one_per_domain"),
  hideSpam: z.boolean().default(true),
  cacheOnly: z.boolean().default(false),
  maxUsd: z.number().positive().max(1000).optional(),
  requestId: z.string().uuid(),
});

export const backlinksRowsResponseSchema = z.union([
  z.looseObject({
    status: z.literal("ok"),
    rows: z.array(
      z.looseObject({
        domainFrom: z.string(),
        urlFrom: z.string(),
        urlTo: z.string(),
        anchor: z.string().nullable(),
        itemType: z.string().nullable(),
        isDofollow: z.boolean(),
        relAttributes: z.array(z.string()).nullable(),
        rank: z.number().nullable(),
        domainFromRank: z.number().nullable(),
        pageFromRank: z.number().nullable(),
        spamScore: z.number().nullable(),
        firstSeen: z.string().nullable(),
        lastSeen: z.string().nullable(),
        isLost: z.boolean(),
        isBroken: z.boolean(),
        linksCount: z.number().nullable(),
      }),
    ),
    totalCount: z.number(),
    hasMore: z.boolean(),
    page: z.number(),
    pageSize: z.number(),
    cached: z.boolean(),
    fetchedAt: z.string(),
    provenance: z.looseObject({ gateway: z.literal("dataforseo") }),
  }),
  z.looseObject({
    status: z.literal("not_cached"),
    target: z.string(),
    displayTarget: z.string(),
    scope: researchScopeSchema,
  }),
]);

const EXAMPLE_ROWS_RESPONSE = {
  status: "ok" as const,
  rows: [
    {
      domainFrom: "source.example",
      urlFrom: "https://source.example/page",
      urlTo: "https://example.com/target",
      anchor: "anchor text",
      itemType: "anchor",
      isDofollow: true,
      relAttributes: ["noopener"],
      rank: 45,
      domainFromRank: 50,
      pageFromRank: 40,
      spamScore: 15,
      firstSeen: "2026-01-01T00:00:00Z",
      lastSeen: "2026-02-01T00:00:00Z",
      isLost: false,
      isBroken: false,
      linksCount: 1,
    },
  ],
  totalCount: 1,
  hasMore: false,
  page: 1,
  pageSize: 50,
  cached: false,
  fetchedAt: "2026-10-21T09:30:00.000Z",
  provenance: { gateway: "dataforseo" as const },
};

export const backlinksRowsContract = defineRouteContract({
  id: "customer.backlinks.rows",
  method: "POST",
  path: "/api/customer/backlinks/rows",
  file: "src/app/api/customer/backlinks/rows/route.ts",
  auth: "workspace",
  query: backlinksBrandQuery,
  request: backlinksRowsRequestBody,
  response: backlinksRowsResponseSchema,
  errorCodes: BACKLINKS_COMMON_ERROR_CODES,
  examples: [{ response: EXAMPLE_ROWS_RESPONSE }],
});

// --- 3. POST /api/customer/backlinks/referring-domains ---
export const referringDomainsRequestBody = z.strictObject({
  target: z.string().trim().min(1).max(2048),
  scope: backlinksScopeParamSchema.optional(),
  page: z.number().int().positive().default(1),
  pageSize: z
    .union([z.literal(50), z.literal(100), z.literal(200)])
    .default(50),
  sortField: referringDomainsSortFieldSchema.default("backlinks"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  filters: referringDomainsFiltersSchema.default({}),
  cacheOnly: z.boolean().default(false),
  maxUsd: z.number().positive().max(1000).optional(),
  requestId: z.string().uuid(),
});

export const referringDomainsResponseSchema = z.union([
  z.looseObject({
    status: z.literal("ok"),
    rows: z.array(
      z.looseObject({
        domain: z.string(),
        backlinks: z.number(),
        referringPages: z.number(),
        rank: z.number().nullable(),
        spamScore: z.number().nullable(),
        firstSeen: z.string().nullable(),
        brokenBacklinks: z.number(),
        brokenPages: z.number(),
      }),
    ),
    totalCount: z.number(),
    hasMore: z.boolean(),
    page: z.number(),
    pageSize: z.number(),
    cached: z.boolean(),
    fetchedAt: z.string(),
    provenance: z.looseObject({ gateway: z.literal("dataforseo") }),
  }),
  z.looseObject({
    status: z.literal("not_cached"),
    target: z.string(),
    displayTarget: z.string(),
    scope: researchScopeSchema,
  }),
]);

const EXAMPLE_REFERRING_DOMAINS_RESPONSE = {
  status: "ok" as const,
  rows: [
    {
      domain: "source.example",
      backlinks: 10,
      referringPages: 5,
      rank: 45,
      spamScore: 12,
      firstSeen: "2026-01-01T00:00:00Z",
      brokenBacklinks: 0,
      brokenPages: 0,
    },
  ],
  totalCount: 1,
  hasMore: false,
  page: 1,
  pageSize: 50,
  cached: false,
  fetchedAt: "2026-10-21T09:30:00.000Z",
  provenance: { gateway: "dataforseo" as const },
};

export const referringDomainsContract = defineRouteContract({
  id: "customer.backlinks.referring_domains",
  method: "POST",
  path: "/api/customer/backlinks/referring-domains",
  file: "src/app/api/customer/backlinks/referring-domains/route.ts",
  auth: "workspace",
  query: backlinksBrandQuery,
  request: referringDomainsRequestBody,
  response: referringDomainsResponseSchema,
  errorCodes: BACKLINKS_COMMON_ERROR_CODES,
  examples: [{ response: EXAMPLE_REFERRING_DOMAINS_RESPONSE }],
});

// --- 4. POST /api/customer/backlinks/top-pages ---
export const topPagesRequestBody = z.strictObject({
  target: z.string().trim().min(1).max(2048),
  scope: backlinksScopeParamSchema.optional(),
  page: z.number().int().positive().default(1),
  pageSize: z
    .union([z.literal(50), z.literal(100), z.literal(200)])
    .default(50),
  sortField: topPagesSortFieldSchema.default("backlinks"),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
  filters: topPagesFiltersSchema.default({}),
  cacheOnly: z.boolean().default(false),
  maxUsd: z.number().positive().max(1000).optional(),
  requestId: z.string().uuid(),
});

export const topPagesResponseSchema = z.union([
  z.looseObject({
    status: z.literal("ok"),
    rows: z.array(
      z.looseObject({
        page: z.string(),
        backlinks: z.number(),
        referringDomains: z.number(),
        rank: z.number().nullable(),
        brokenBacklinks: z.number(),
      }),
    ),
    totalCount: z.number(),
    hasMore: z.boolean(),
    page: z.number(),
    pageSize: z.number(),
    cached: z.boolean(),
    fetchedAt: z.string(),
    provenance: z.looseObject({ gateway: z.literal("dataforseo") }),
  }),
  z.looseObject({
    status: z.literal("not_cached"),
    target: z.string(),
    displayTarget: z.string(),
    scope: researchScopeSchema,
  }),
]);

const EXAMPLE_TOP_PAGES_RESPONSE = {
  status: "ok" as const,
  rows: [
    {
      page: "https://example.com/page",
      backlinks: 50,
      referringDomains: 12,
      rank: 35,
      brokenBacklinks: 0,
    },
  ],
  totalCount: 1,
  hasMore: false,
  page: 1,
  pageSize: 50,
  cached: false,
  fetchedAt: "2026-10-21T09:30:00.000Z",
  provenance: { gateway: "dataforseo" as const },
};

export const topPagesContract = defineRouteContract({
  id: "customer.backlinks.top_pages",
  method: "POST",
  path: "/api/customer/backlinks/top-pages",
  file: "src/app/api/customer/backlinks/top-pages/route.ts",
  auth: "workspace",
  query: backlinksBrandQuery,
  request: topPagesRequestBody,
  response: topPagesResponseSchema,
  errorCodes: BACKLINKS_COMMON_ERROR_CODES,
  examples: [{ response: EXAMPLE_TOP_PAGES_RESPONSE }],
});

// --- 5. POST /api/customer/backlinks/ahrefs-dr ---
export const ahrefsDomainRatingsRequestBody = z.strictObject({
  domains: z.array(z.string().trim().min(1).max(253)).min(1).max(100),
});

export const ahrefsDomainRatingsResponseSchema = z.looseObject({
  ratings: z.record(z.string(), z.number().nullable()),
});

const EXAMPLE_AHREFS_DR_RESPONSE = {
  ratings: { "bewakoof.com": 61, "www.example.in": null },
};

export const ahrefsDomainRatingsContract = defineRouteContract({
  id: "customer.backlinks.ahrefs_dr",
  method: "POST",
  path: "/api/customer/backlinks/ahrefs-dr",
  file: "src/app/api/customer/backlinks/ahrefs-dr/route.ts",
  auth: "workspace",
  query: backlinksBrandQuery,
  request: ahrefsDomainRatingsRequestBody,
  response: ahrefsDomainRatingsResponseSchema,
  errorCodes: BACKLINKS_COMMON_ERROR_CODES,
  examples: [{ response: EXAMPLE_AHREFS_DR_RESPONSE }],
});

// --- 6. F16 phase 5 tracked snapshot routes ---
export const snapshotTargetsQuery = backlinksBrandQuery;
export const snapshotTargetCreateRequestBody = z.strictObject({
  target: z.string().trim().min(3).max(255),
  scope: z.enum(["domain", "subdomains"]),
  interval: z.enum(["weekly", "monthly"]),
  label: z.string().trim().min(1).max(120).optional(),
  maxUsd: z.number().positive().max(1000).optional(),
});

const snapshotTargetSchema = z.looseObject({
  id: z.string(),
  target: z.string(),
  scope: z.enum(["domain", "subdomains"]),
  label: z.string().nullable(),
  interval: z.enum(["weekly", "monthly"]),
  enabled: z.boolean(),
  nextRunAt: z.string(),
  lastRunAt: z.string().nullable(),
  lastSkipReason: z.string().nullable(),
  lastSkipMessage: z.string().nullable(),
});

export const snapshotTargetsResponseSchema = z.looseObject({
  targets: z.array(snapshotTargetSchema),
});
export const snapshotTargetCreateResponseSchema = z.looseObject({
  target: snapshotTargetSchema,
});
export const snapshotTargetDeleteResponseSchema = z.looseObject({
  deleted: z.literal(true),
});
export const snapshotsQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  target: z.string().trim().min(3).max(255),
  scope: z.enum(["domain", "subdomains"]),
});
export const snapshotsResponseSchema = z.looseObject({
  snapshots: z.array(
    z.looseObject({
      capturedOn: z.string(),
      capturedAt: z.string().optional(),
      source: z.enum(["scheduled", "lookup"]),
      rank: z.number().nullable(),
      backlinks: z.number().nullable(),
      referringDomains: z.number().nullable(),
      referringPages: z.number().nullable(),
      brokenBacklinks: z.number().nullable(),
      brokenPages: z.number().nullable(),
      newBacklinks: z.number().nullable(),
      lostBacklinks: z.number().nullable(),
      newReferringDomains: z.number().nullable(),
      lostReferringDomains: z.number().nullable(),
      backlinksSpamScore: z.number().nullable(),
      targetSpamScore: z.number().nullable(),
    }),
  ),
});

export const snapshotTargetsGetContract = defineRouteContract({
  id: "customer.backlinks.snapshot_targets.get",
  method: "GET",
  path: "/api/customer/backlinks/snapshot-targets",
  file: "src/app/api/customer/backlinks/snapshot-targets/route.ts",
  auth: "workspace",
  query: snapshotTargetsQuery,
  response: snapshotTargetsResponseSchema,
  errorCodes: BACKLINKS_COMMON_ERROR_CODES,
  examples: [{ response: { targets: [] } }],
});

export const snapshotTargetsPostContract = defineRouteContract({
  id: "customer.backlinks.snapshot_targets.post",
  method: "POST",
  path: "/api/customer/backlinks/snapshot-targets",
  file: "src/app/api/customer/backlinks/snapshot-targets/route.ts",
  auth: "workspace_owner",
  query: snapshotTargetsQuery,
  request: snapshotTargetCreateRequestBody,
  response: snapshotTargetCreateResponseSchema,
  errorCodes: BACKLINKS_COMMON_ERROR_CODES,
  examples: [{ response: { target: { id: "uuid", target: "offcult.in", scope: "subdomains", label: null, interval: "weekly", enabled: true, nextRunAt: "2026-10-28T00:00:00.000Z", lastRunAt: null, lastSkipReason: null, lastSkipMessage: null } } }],
});

export const snapshotTargetsDeleteContract = defineRouteContract({
  id: "customer.backlinks.snapshot_targets.delete",
  method: "DELETE",
  path: "/api/customer/backlinks/snapshot-targets/[targetId]",
  file: "src/app/api/customer/backlinks/snapshot-targets/[targetId]/route.ts",
  auth: "workspace_owner",
  query: backlinksBrandQuery,
  response: snapshotTargetDeleteResponseSchema,
  errorCodes: BACKLINKS_COMMON_ERROR_CODES,
  examples: [{ response: { deleted: true } }],
});

export const snapshotsGetContract = defineRouteContract({
  id: "customer.backlinks.snapshots.get",
  method: "GET",
  path: "/api/customer/backlinks/snapshots",
  file: "src/app/api/customer/backlinks/snapshots/route.ts",
  auth: "workspace",
  query: snapshotsQuery,
  response: snapshotsResponseSchema,
  errorCodes: BACKLINKS_COMMON_ERROR_CODES,
  examples: [{ response: { snapshots: [] } }],
});

export const contracts: RouteContract[] = [
  backlinksOverviewContract,
  backlinksRowsContract,
  referringDomainsContract,
  topPagesContract,
  ahrefsDomainRatingsContract,
  snapshotTargetsGetContract,
  snapshotTargetsPostContract,
  snapshotTargetsDeleteContract,
  snapshotsGetContract,
];
