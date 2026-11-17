// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/google-analytics-tools.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * F20 §6.2.2 — Assistant tools for Google Analytics and Search Opportunities.
 *
 * Ten read-only, free tools. All inputs are closed (z.strictObject) and all
 * outputs are loose (z.looseObject) matching the route payloads.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getOrganicOverview } from "./overview.ts";
import { runReport } from "./reporting.ts";
import { getMeasurementHealth } from "./measurementHealth.ts";
import { getOpportunities } from "./opportunities.ts";

export type Ga4ToolBrand = {
  brandKey: string;
  [key: string]: unknown;
};

export type Ga4ToolContext = {
  admin: SupabaseClient;
  brand: Ga4ToolBrand;
  userId: string;
  deps?: {
    getOrganicOverview?: typeof getOrganicOverview;
    runReport?: typeof runReport;
    getMeasurementHealth?: typeof getMeasurementHealth;
    getOpportunities?: typeof getOpportunities;
    serviceDeps?: Record<string, unknown>;
  };
};

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

function validateDatePair(
  val: { startDate?: unknown; endDate?: unknown },
  ctx: z.RefinementCtx,
) {
  const hasStart = typeof val.startDate === "string" && val.startDate.length > 0;
  const hasEnd = typeof val.endDate === "string" && val.endDate.length > 0;
  if (hasStart !== hasEnd) {
    ctx.addIssue({
      code: "custom",
      message: "Provide both startDate and endDate, or neither.",
      path: ["startDate"],
    });
  } else if (
    hasStart &&
    hasEnd &&
    typeof val.startDate === "string" &&
    typeof val.endDate === "string" &&
    val.startDate > val.endDate
  ) {
    ctx.addIssue({
      code: "custom",
      message: "startDate must be on or before endDate.",
      path: ["startDate"],
    });
  }
}

function withDateValidation<T extends z.ZodRawShape>(shape: T) {
  return z
    .strictObject({
      startDate: z.string().regex(DATE_REGEX, "startDate must be YYYY-MM-DD").optional(),
      endDate: z.string().regex(DATE_REGEX, "endDate must be YYYY-MM-DD").optional(),
      ...shape,
    })
    .superRefine((val: any, ctx) => validateDatePair(val, ctx));
}

// Outputs
export const overviewOutputSchema = z.looseObject({
  status: z.string(),
  source: z.looseObject({}).optional(),
  request: z.looseObject({}).optional(),
  current: z.looseObject({}).nullable().optional(),
  previous: z.looseObject({}).nullable().optional(),
  comparison: z.looseObject({}).optional(),
  trend: z.array(z.record(z.string(), z.unknown())).optional(),
  trendFilled: z.boolean().optional(),
  diagnostics: z.array(z.unknown()).optional(),
  reportMetadata: z.looseObject({}).optional(),
  warnings: z.array(z.string()).optional(),
  quota: z.looseObject({}).nullable().optional(),
  dataAsOf: z.string().optional(),
  cached: z.boolean().optional(),
});

export const reportOutputSchema = z.looseObject({
  status: z.string(),
  source: z.looseObject({}).optional(),
  request: z.looseObject({}).optional(),
  rowCount: z.number().optional(),
  totalRowCount: z.number().optional(),
  rows: z.array(z.record(z.string(), z.unknown())).optional(),
  pageInfo: z.looseObject({}).optional(),
  reportMetadata: z.looseObject({}).optional(),
  quota: z.looseObject({}).nullable().optional(),
  warnings: z.array(z.string()).optional(),
  comparison: z.looseObject({}).optional(),
  ecommerceActivity: z.looseObject({}).optional(),
  siteSearchActivity: z.looseObject({}).optional(),
  diagnostics: z.array(z.unknown()).optional(),
  dataAsOf: z.string().optional(),
  cached: z.boolean().optional(),
});

export const measurementHealthOutputSchema = z.looseObject({
  status: z.string(),
  source: z.looseObject({}).optional(),
  summary: z.looseObject({}).optional(),
  issues: z.array(z.string()).optional(),
  webStreams: z.array(z.record(z.string(), z.unknown())).optional(),
  otherStreams: z.array(z.record(z.string(), z.unknown())).optional(),
  keyEvents: z.array(z.record(z.string(), z.unknown())).optional(),
  customDefinitions: z.looseObject({}).optional(),
  dataAsOf: z.string().optional(),
  cached: z.boolean().optional(),
});

export const opportunityOutputSchema = z.looseObject({
  status: z.string(),
  source: z.looseObject({}).optional(),
  request: z.looseObject({}).optional(),
  rowCount: z.number().optional(),
  totalCandidateRows: z.number().optional(),
  rows: z.array(z.record(z.string(), z.unknown())).optional(),
  scoring: z.looseObject({}).optional(),
  coverage: z.looseObject({}).optional(),
  truncated: z.looseObject({}).optional(),
  warnings: z.array(z.string()).optional(),
  reportMetadata: z.looseObject({}).optional(),
  quota: z.looseObject({}).nullable().optional(),
  dataAsOf: z.string().optional(),
  cached: z.boolean().optional(),
});

// 1. Organic Overview
export const getOverviewInputSchema = withDateValidation({
  trend: z.enum(["daily", "weekly"]).optional().default("daily"),
});

export const getGoogleAnalyticsOrganicOverviewTool = {
  name: "get_google_analytics_organic_overview",
  description:
    "Organic overview: Answer whether organic traffic is improving with top-line sessions, users, engagement, key events, transactions, revenue, an equal-length previous-period comparison, and a daily or weekly trend. Read-only. Free. Requires Google Analytics to be connected in Workspace settings.",
  input: getOverviewInputSchema,
  output: overviewOutputSchema,
  handler: async (ctx: Ga4ToolContext, rawInput?: unknown) => {
    const input = getOverviewInputSchema.parse(rawInput ?? {});
    const fn = ctx.deps?.getOrganicOverview ?? getOrganicOverview;
    const result = await fn(
      ctx.admin,
      ctx.brand,
      {
        startDate: input.startDate,
        endDate: input.endDate,
        trend: input.trend,
      },
      ctx.deps?.serviceDeps,
    );
    return overviewOutputSchema.parse(result);
  },
};

// 2. Organic Landing Pages
export const getLandingPagesInputSchema = withDateValidation({
  limit: z.number().int().min(1).max(1000).optional().default(100),
  offset: z.number().int().min(0).optional().default(0),
});

export const getGoogleAnalyticsOrganicLandingPagesTool = {
  name: "get_google_analytics_organic_landing_pages",
  description:
    "Organic landing pages: Read organic-search landing page sessions, engagement, key events, transactions, and revenue from the connected GA4 property. Read-only. Free. Requires Google Analytics to be connected in Workspace settings.",
  input: getLandingPagesInputSchema,
  output: reportOutputSchema,
  handler: async (ctx: Ga4ToolContext, rawInput?: unknown) => {
    const input = getLandingPagesInputSchema.parse(rawInput ?? {});
    const fn = ctx.deps?.runReport ?? runReport;
    const result = await fn(
      ctx.admin,
      ctx.brand,
      {
        kind: "landing_pages",
        startDate: input.startDate,
        endDate: input.endDate,
        channel: "organic_search",
        limit: input.limit,
        offset: input.offset,
      },
      ctx.deps?.serviceDeps,
    );
    return reportOutputSchema.parse(result);
  },
};

// 3. Page Performance
export const getPagePerformanceInputSchema = withDateValidation({
  limit: z.number().int().min(1).max(1000).optional().default(100),
  offset: z.number().int().min(0).optional().default(0),
  channel: z.enum(["organic_search", "all"]).optional().default("organic_search"),
  includeDate: z.boolean().optional().default(false),
});

export const getGoogleAnalyticsPagePerformanceTool = {
  name: "get_google_analytics_page_performance",
  description:
    "Page performance: Read page views, users, engagement duration, and key events from the connected GA4 property. Organic Search is the default; set channel to all to include every channel. Read-only. Free. Requires Google Analytics to be connected in Workspace settings.",
  input: getPagePerformanceInputSchema,
  output: reportOutputSchema,
  handler: async (ctx: Ga4ToolContext, rawInput?: unknown) => {
    const input = getPagePerformanceInputSchema.parse(rawInput ?? {});
    const fn = ctx.deps?.runReport ?? runReport;
    const result = await fn(
      ctx.admin,
      ctx.brand,
      {
        kind: "page_performance",
        startDate: input.startDate,
        endDate: input.endDate,
        channel: input.channel,
        includeDate: input.includeDate,
        limit: input.limit,
        offset: input.offset,
      },
      ctx.deps?.serviceDeps,
    );
    return reportOutputSchema.parse(result);
  },
};

// 4. Key Events
export const getKeyEventsInputSchema = withDateValidation({
  limit: z.number().int().min(1).max(1000).optional().default(100),
  offset: z.number().int().min(0).optional().default(0),
  breakdown: z.enum(["event", "event_and_landing_page"]).optional().default("event"),
  channel: z.enum(["organic_search", "all"]).optional().default("organic_search"),
  comparePreviousPeriod: z.boolean().optional().default(false),
});

export const getGoogleAnalyticsKeyEventsTool = {
  name: "get_google_analytics_key_events",
  description:
    "Key events: Read active GA4 key events with counts and users by event or organic landing page. Previous-period comparison is available for the event breakdown. Read-only. Free. Requires Google Analytics to be connected in Workspace settings.",
  input: getKeyEventsInputSchema,
  output: reportOutputSchema,
  handler: async (ctx: Ga4ToolContext, rawInput?: unknown) => {
    const input = getKeyEventsInputSchema.parse(rawInput ?? {});
    const fn = ctx.deps?.runReport ?? runReport;
    const result = await fn(
      ctx.admin,
      ctx.brand,
      {
        kind: "key_events",
        startDate: input.startDate,
        endDate: input.endDate,
        channel: input.channel,
        breakdown: input.breakdown,
        comparePreviousPeriod: input.comparePreviousPeriod,
        limit: input.limit,
        offset: input.offset,
      },
      ctx.deps?.serviceDeps,
    );
    return reportOutputSchema.parse(result);
  },
};

// 5. Traffic Acquisition
export const getTrafficAcquisitionInputSchema = withDateValidation({
  limit: z.number().int().min(1).max(1000).optional().default(100),
  offset: z.number().int().min(0).optional().default(0),
  breakdown: z.enum(["channel_group", "source_medium", "campaign"]).optional().default("channel_group"),
  comparePreviousPeriod: z.boolean().optional().default(false),
});

export const getGoogleAnalyticsTrafficAcquisitionTool = {
  name: "get_google_analytics_traffic_acquisition",
  description:
    "Traffic acquisition: Compare session acquisition by channel group, source/medium, or campaign, including sessions, users, engagement, key events, transactions, and revenue. Read-only. Free. Requires Google Analytics to be connected in Workspace settings.",
  input: getTrafficAcquisitionInputSchema,
  output: reportOutputSchema,
  handler: async (ctx: Ga4ToolContext, rawInput?: unknown) => {
    const input = getTrafficAcquisitionInputSchema.parse(rawInput ?? {});
    const fn = ctx.deps?.runReport ?? runReport;
    const result = await fn(
      ctx.admin,
      ctx.brand,
      {
        kind: "traffic_acquisition",
        startDate: input.startDate,
        endDate: input.endDate,
        channel: "all",
        acquisitionBreakdown: input.breakdown,
        comparePreviousPeriod: input.comparePreviousPeriod,
        limit: input.limit,
        offset: input.offset,
      },
      ctx.deps?.serviceDeps,
    );
    return reportOutputSchema.parse(result);
  },
};

// 6. Ecommerce Performance
export const getEcommerceInputSchema = withDateValidation({
  limit: z.number().int().min(1).max(1000).optional().default(100),
  offset: z.number().int().min(0).optional().default(0),
  breakdown: z.enum(["item", "landing_page"]).optional().default("item"),
  onlyWithTransactions: z.boolean().optional().default(false),
  channel: z.enum(["organic_search", "all"]).optional().default("organic_search"),
});

export const getGoogleAnalyticsEcommercePerformanceTool = {
  name: "get_google_analytics_ecommerce_performance",
  description:
    "Ecommerce performance: Read item views, add-to-cart units, purchases, and item revenue by item, or transactions and purchase revenue by landing page. Read-only. Free. Requires Google Analytics to be connected in Workspace settings.",
  input: getEcommerceInputSchema,
  output: reportOutputSchema,
  handler: async (ctx: Ga4ToolContext, rawInput?: unknown) => {
    const input = getEcommerceInputSchema.parse(rawInput ?? {});
    const fn = ctx.deps?.runReport ?? runReport;
    const result = await fn(
      ctx.admin,
      ctx.brand,
      {
        kind: "ecommerce_performance",
        startDate: input.startDate,
        endDate: input.endDate,
        channel: input.channel,
        ecommerceBreakdown: input.breakdown,
        ecommerceOnlyWithTransactions: input.onlyWithTransactions,
        limit: input.limit,
        offset: input.offset,
      },
      ctx.deps?.serviceDeps,
    );
    return reportOutputSchema.parse(result);
  },
};

// 7. Site Search
export const getSiteSearchInputSchema = withDateValidation({
  limit: z.number().int().min(1).max(1000).optional().default(100),
  offset: z.number().int().min(0).optional().default(0),
});

export const getGoogleAnalyticsSiteSearchTool = {
  name: "get_google_analytics_site_search",
  description:
    "Site search: Read measured internal search terms with search events, users, sessions, engaged sessions, and engagement rate. Read-only. Free. Requires Google Analytics to be connected in Workspace settings.",
  input: getSiteSearchInputSchema,
  output: reportOutputSchema,
  handler: async (ctx: Ga4ToolContext, rawInput?: unknown) => {
    const input = getSiteSearchInputSchema.parse(rawInput ?? {});
    const fn = ctx.deps?.runReport ?? runReport;
    const result = await fn(
      ctx.admin,
      ctx.brand,
      {
        kind: "site_search",
        startDate: input.startDate,
        endDate: input.endDate,
        channel: "all",
        limit: input.limit,
        offset: input.offset,
      },
      ctx.deps?.serviceDeps,
    );
    return reportOutputSchema.parse(result);
  },
};

// 8. Audience Breakdown
export const getAudienceInputSchema = withDateValidation({
  limit: z.number().int().min(1).max(1000).optional().default(100),
  offset: z.number().int().min(0).optional().default(0),
  breakdown: z.enum(["device", "country", "new_vs_returning"]).optional().default("device"),
  channel: z.enum(["organic_search", "all"]).optional().default("organic_search"),
  comparePreviousPeriod: z.boolean().optional().default(false),
});

export const getGoogleAnalyticsAudienceBreakdownTool = {
  name: "get_google_analytics_audience_breakdown",
  description:
    "Audience breakdown: Read device, country, or new-versus-returning users, sessions, engagement, and key events. Read-only. Free. Requires Google Analytics to be connected in Workspace settings.",
  input: getAudienceInputSchema,
  output: reportOutputSchema,
  handler: async (ctx: Ga4ToolContext, rawInput?: unknown) => {
    const input = getAudienceInputSchema.parse(rawInput ?? {});
    const fn = ctx.deps?.runReport ?? runReport;
    const result = await fn(
      ctx.admin,
      ctx.brand,
      {
        kind: "audience_breakdown",
        startDate: input.startDate,
        endDate: input.endDate,
        channel: input.channel,
        audienceBreakdown: input.breakdown,
        comparePreviousPeriod: input.comparePreviousPeriod,
        limit: input.limit,
        offset: input.offset,
      },
      ctx.deps?.serviceDeps,
    );
    return reportOutputSchema.parse(result);
  },
};

// 9. Measurement Health
export const getMeasurementHealthInputSchema = z.strictObject({});

export const getGoogleAnalyticsMeasurementHealthTool = {
  name: "get_google_analytics_measurement_health",
  description:
    "Measurement health: Diagnose the connected property's data streams, web measurement IDs, enhanced-measurement settings, key events, and custom definitions. Read-only. Free. Requires Google Analytics to be connected in Workspace settings.",
  input: getMeasurementHealthInputSchema,
  output: measurementHealthOutputSchema,
  handler: async (ctx: Ga4ToolContext, rawInput?: unknown) => {
    getMeasurementHealthInputSchema.parse(rawInput ?? {});
    const fn = ctx.deps?.getMeasurementHealth ?? getMeasurementHealth;
    const result = await fn(ctx.admin, ctx.brand, ctx.deps?.serviceDeps);
    return measurementHealthOutputSchema.parse(result);
  },
};

// 10. Search Opportunities
export const getOpportunitiesInputSchema = withDateValidation({
  limit: z.number().int().min(1).max(100).optional().default(50),
});

export const getSearchOpportunitiesTool = {
  name: "get_search_opportunities",
  description:
    "Search opportunities: Ranks pages at Search Console positions 4–20 by demand, business value and reachability. Requires Search Console too. Read-only. Free. Requires Google Analytics to be connected in Workspace settings.",
  input: getOpportunitiesInputSchema,
  output: opportunityOutputSchema,
  handler: async (ctx: Ga4ToolContext, rawInput?: unknown) => {
    const input = getOpportunitiesInputSchema.parse(rawInput ?? {});
    const fn = ctx.deps?.getOpportunities ?? getOpportunities;
    const result = await fn(
      ctx.admin,
      ctx.brand,
      {
        startDate: input.startDate,
        endDate: input.endDate,
        limit: input.limit,
      },
      ctx.deps?.serviceDeps,
    );
    return opportunityOutputSchema.parse(result);
  },
};

export const ga4Tools = [
  getGoogleAnalyticsOrganicOverviewTool,
  getGoogleAnalyticsOrganicLandingPagesTool,
  getGoogleAnalyticsPagePerformanceTool,
  getGoogleAnalyticsKeyEventsTool,
  getGoogleAnalyticsTrafficAcquisitionTool,
  getGoogleAnalyticsEcommercePerformanceTool,
  getGoogleAnalyticsSiteSearchTool,
  getGoogleAnalyticsAudienceBreakdownTool,
  getGoogleAnalyticsMeasurementHealthTool,
  getSearchOpportunitiesTool,
] as const;
