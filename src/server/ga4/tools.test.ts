import test from "node:test";
import assert from "node:assert/strict";
import { ZodError } from "zod";
import {
  ga4Tools,
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
  type Ga4ToolContext,
} from "./tools.ts";
import { TOOL_NAMES } from "../tools/names.ts";

const EXPECTED_TOOL_NAMES = [
  "get_google_analytics_organic_overview",
  "get_google_analytics_organic_landing_pages",
  "get_google_analytics_page_performance",
  "get_google_analytics_key_events",
  "get_google_analytics_traffic_acquisition",
  "get_google_analytics_ecommerce_performance",
  "get_google_analytics_site_search",
  "get_google_analytics_audience_breakdown",
  "get_google_analytics_measurement_health",
  "get_search_opportunities",
] as const;

const REQUIRED_SUFFIX =
  "Read-only. Free. Requires Google Analytics to be connected in Workspace settings.";

function createMockContext(overrides?: Partial<Ga4ToolContext>): Ga4ToolContext {
  return {
    admin: {} as any,
    brand: { brandKey: "acme-corp" },
    userId: "usr_test_123",
    ...overrides,
  };
}

test("F20-AC-26: exports exactly ten tools matching TOOL_NAMES", () => {
  assert.equal(ga4Tools.length, 10);
  const toolNames = ga4Tools.map((t) => t.name);
  assert.deepEqual(toolNames, EXPECTED_TOOL_NAMES);

  for (const name of EXPECTED_TOOL_NAMES) {
    assert.ok(
      (TOOL_NAMES as readonly string[]).includes(name),
      `TOOL_NAMES must include ${name}`,
    );
  }
});

test("F20-AC-26: every description starts with the report name and ends with the standard safety suffix", () => {
  const reportPrefixes: Record<string, string> = {
    get_google_analytics_organic_overview: "Organic overview",
    get_google_analytics_organic_landing_pages: "Organic landing pages",
    get_google_analytics_page_performance: "Page performance",
    get_google_analytics_key_events: "Key events",
    get_google_analytics_traffic_acquisition: "Traffic acquisition",
    get_google_analytics_ecommerce_performance: "Ecommerce performance",
    get_google_analytics_site_search: "Site search",
    get_google_analytics_audience_breakdown: "Audience breakdown",
    get_google_analytics_measurement_health: "Measurement health",
    get_search_opportunities: "Search opportunities",
  };

  for (const tool of ga4Tools) {
    const prefix = reportPrefixes[tool.name];
    assert.ok(
      tool.description.startsWith(prefix),
      `${tool.name} description should start with '${prefix}', got '${tool.description}'`,
    );
    assert.ok(
      tool.description.endsWith(REQUIRED_SUFFIX),
      `${tool.name} description should end with '${REQUIRED_SUFFIX}'`,
    );
  }

  assert.ok(
    getSearchOpportunitiesTool.description.includes(
      "Ranks pages at Search Console positions 4–20 by demand, business value and reachability. Requires Search Console too.",
    ),
  );
});

test("F20-AC-26: all inputs are closed (z.strictObject) and reject unexpected properties", () => {
  for (const tool of ga4Tools) {
    assert.throws(
      () => tool.input.parse({ unexpectedField: "bad" }),
      (err) => err instanceof ZodError,
      `${tool.name} must reject unexpected properties`,
    );
  }
});

test("F20-AC-26: date validation requires both startDate and endDate, or neither", () => {
  const dateTools = ga4Tools.filter(
    (t) => t.name !== "get_google_analytics_measurement_health",
  );

  for (const tool of dateTools) {
    // Only startDate
    assert.throws(
      () => tool.input.parse({ startDate: "2026-01-01" }),
      (err: any) =>
        err instanceof ZodError &&
        err.issues.some((i: any) => i.message.includes("Provide both startDate and endDate")),
      `${tool.name} must reject startDate without endDate`,
    );

    // Only endDate
    assert.throws(
      () => tool.input.parse({ endDate: "2026-01-10" }),
      (err: any) =>
        err instanceof ZodError &&
        err.issues.some((i: any) => i.message.includes("Provide both startDate and endDate")),
      `${tool.name} must reject endDate without startDate`,
    );

    // Invalid format
    assert.throws(
      () => tool.input.parse({ startDate: "01/01/2026", endDate: "10/01/2026" }),
      (err) => err instanceof ZodError,
      `${tool.name} must reject non-YYYY-MM-DD dates`,
    );

    // startDate > endDate
    assert.throws(
      () => tool.input.parse({ startDate: "2026-02-01", endDate: "2026-01-01" }),
      (err: any) =>
        err instanceof ZodError &&
        err.issues.some((i: any) => i.message.includes("startDate must be on or before endDate")),
      `${tool.name} must reject startDate after endDate`,
    );

    // Both valid
    const parsed = tool.input.parse({
      startDate: "2026-01-01",
      endDate: "2026-01-28",
    }) as any;
    assert.equal(parsed.startDate, "2026-01-01");
    assert.equal(parsed.endDate, "2026-01-28");

    // Neither (defaults accepted)
    const emptyParsed = tool.input.parse({}) as any;
    assert.equal(emptyParsed.startDate, undefined);
    assert.equal(emptyParsed.endDate, undefined);
  }
});

test("F20-AC-26: measurement health input is strictly empty", () => {
  const parsed = getGoogleAnalyticsMeasurementHealthTool.input.parse({});
  assert.deepEqual(parsed, {});
  assert.throws(
    () => getGoogleAnalyticsMeasurementHealthTool.input.parse({ limit: 10 }),
    (err) => err instanceof ZodError,
  );
});

test("F20-AC-26: tool-specific input defaults and validation limits", () => {
  // Overview
  assert.equal(getGoogleAnalyticsOrganicOverviewTool.input.parse({}).trend, "daily");
  assert.equal(
    getGoogleAnalyticsOrganicOverviewTool.input.parse({ trend: "weekly" }).trend,
    "weekly",
  );
  assert.throws(() =>
    getGoogleAnalyticsOrganicOverviewTool.input.parse({ trend: "monthly" }),
  );

  // Landing pages
  const lp = getGoogleAnalyticsOrganicLandingPagesTool.input.parse({});
  assert.equal(lp.limit, 100);
  assert.equal(lp.offset, 0);
  assert.throws(() =>
    getGoogleAnalyticsOrganicLandingPagesTool.input.parse({ limit: 0 }),
  );
  assert.throws(() =>
    getGoogleAnalyticsOrganicLandingPagesTool.input.parse({ limit: 1001 }),
  );

  // Page performance
  const pp = getGoogleAnalyticsPagePerformanceTool.input.parse({});
  assert.equal(pp.channel, "organic_search");
  assert.equal(pp.includeDate, false);

  // Key events
  const ke = getGoogleAnalyticsKeyEventsTool.input.parse({});
  assert.equal(ke.breakdown, "event");
  assert.equal(ke.comparePreviousPeriod, false);

  // Traffic acquisition
  const ta = getGoogleAnalyticsTrafficAcquisitionTool.input.parse({});
  assert.equal(ta.breakdown, "channel_group");
  assert.equal(ta.comparePreviousPeriod, false);

  // Ecommerce performance
  const ep = getGoogleAnalyticsEcommercePerformanceTool.input.parse({});
  assert.equal(ep.breakdown, "item");
  assert.equal(ep.onlyWithTransactions, false);
  assert.equal(ep.channel, "organic_search");

  // Site search
  const ss = getGoogleAnalyticsSiteSearchTool.input.parse({});
  assert.equal(ss.limit, 100);
  assert.equal(ss.offset, 0);

  // Audience breakdown
  const ab = getGoogleAnalyticsAudienceBreakdownTool.input.parse({});
  assert.equal(ab.breakdown, "device");
  assert.equal(ab.comparePreviousPeriod, false);

  // Search opportunities
  const so = getSearchOpportunitiesTool.input.parse({});
  assert.equal(so.limit, 50);
  assert.throws(() => getSearchOpportunitiesTool.input.parse({ limit: 0 }));
  assert.throws(() => getSearchOpportunitiesTool.input.parse({ limit: 101 }));
});

test("F20-AC-26: handler calls getOrganicOverview and parses output matching route payload", async () => {
  let calledWith: any = null;
  const mockOverviewResult = {
    status: "ok",
    source: {
      provider: "google_analytics",
      propertyId: "properties/123456789",
      propertyDisplayName: "Test Site",
    },
    request: {
      requestedDateRange: { startDate: "2026-01-01", endDate: "2026-01-28" },
      resolvedDateRange: { startDate: "2026-01-01", endDate: "2026-01-28" },
      trend: "daily",
    },
    current: { sessions: 1200, activeUsers: 900 },
    previous: { sessions: 1000, activeUsers: 800 },
    comparison: {
      sessions: { current: 1200, previous: 1000, absoluteChange: 200, percentChange: 0.2 },
    },
    trend: [{ date: "2026-01-01", sessions: 45 }],
    trendFilled: true,
    diagnostics: [],
    reportMetadata: { hasLimitedData: false },
    warnings: [],
    dataAsOf: "2026-01-29T00:00:00.000Z",
    cached: true,
  };

  const ctx = createMockContext({
    deps: {
      getOrganicOverview: async (admin, brand, input) => {
        calledWith = { admin, brand, input };
        return mockOverviewResult;
      },
    },
  });

  const output = await getGoogleAnalyticsOrganicOverviewTool.handler(ctx, {
    startDate: "2026-01-01",
    endDate: "2026-01-28",
    trend: "daily",
  });

  assert.equal(calledWith.brand.brandKey, "acme-corp");
  assert.equal(calledWith.input.startDate, "2026-01-01");
  assert.equal(calledWith.input.endDate, "2026-01-28");
  assert.equal(calledWith.input.trend, "daily");
  assert.equal(output.status, "ok");
  assert.equal(output.cached, true);
  assert.equal((output.current as any).sessions, 1200);
});

test("F20-AC-26: handler calls runReport for report tools and maps options correctly", async () => {
  const calls: Array<{ kind: string; args: any }> = [];
  const mockReportResult = {
    status: "ok",
    source: { provider: "google_analytics", propertyId: "properties/123" },
    request: {},
    rowCount: 2,
    totalRowCount: 2,
    rows: [{ page: "/home", sessions: 50 }, { page: "/about", sessions: 20 }],
    pageInfo: { offset: 0, limit: 100, hasMore: false },
    reportMetadata: { hasLimitedData: false },
    warnings: [],
    dataAsOf: "2026-01-29T00:00:00.000Z",
    cached: false,
  };

  const runReportMock = async (_admin: any, _brand: any, input: any) => {
    calls.push({ kind: input.kind, args: input });
    return mockReportResult;
  };

  const ctx = createMockContext({
    deps: { runReport: runReportMock as any },
  });

  // 1. Landing pages
  await getGoogleAnalyticsOrganicLandingPagesTool.handler(ctx, { limit: 50 });
  assert.equal(calls[0].kind, "landing_pages");
  assert.equal(calls[0].args.channel, "organic_search");
  assert.equal(calls[0].args.limit, 50);

  // 2. Page performance
  await getGoogleAnalyticsPagePerformanceTool.handler(ctx, {
    channel: "all",
    includeDate: true,
  });
  assert.equal(calls[1].kind, "page_performance");
  assert.equal(calls[1].args.channel, "all");
  assert.equal(calls[1].args.includeDate, true);

  // 3. Key events
  await getGoogleAnalyticsKeyEventsTool.handler(ctx, {
    breakdown: "event_and_landing_page",
    comparePreviousPeriod: true,
  });
  assert.equal(calls[2].kind, "key_events");
  assert.equal(calls[2].args.breakdown, "event_and_landing_page");
  assert.equal(calls[2].args.comparePreviousPeriod, true);

  // 4. Traffic acquisition
  await getGoogleAnalyticsTrafficAcquisitionTool.handler(ctx, {
    breakdown: "source_medium",
    comparePreviousPeriod: true,
  });
  assert.equal(calls[3].kind, "traffic_acquisition");
  assert.equal(calls[3].args.channel, "all");
  assert.equal(calls[3].args.acquisitionBreakdown, "source_medium");
  assert.equal(calls[3].args.comparePreviousPeriod, true);

  // 5. Ecommerce performance
  await getGoogleAnalyticsEcommercePerformanceTool.handler(ctx, {
    breakdown: "landing_page",
    onlyWithTransactions: true,
  });
  assert.equal(calls[4].kind, "ecommerce_performance");
  assert.equal(calls[4].args.ecommerceBreakdown, "landing_page");
  assert.equal(calls[4].args.ecommerceOnlyWithTransactions, true);

  // 6. Site search
  await getGoogleAnalyticsSiteSearchTool.handler(ctx, {});
  assert.equal(calls[5].kind, "site_search");
  assert.equal(calls[5].args.channel, "all");

  // 7. Audience breakdown
  await getGoogleAnalyticsAudienceBreakdownTool.handler(ctx, {
    breakdown: "country",
  });
  assert.equal(calls[6].kind, "audience_breakdown");
  assert.equal(calls[6].args.audienceBreakdown, "country");
});

test("F20-AC-26: handler calls getMeasurementHealth and parses output", async () => {
  let healthCalled = false;
  const mockHealthResult = {
    status: "ok",
    source: { provider: "google_analytics", propertyId: "properties/123" },
    summary: { webStreamCount: 1, keyEventCount: 2, issueCount: 0 },
    issues: [],
    webStreams: [{ streamId: "12345", measurementId: "G-XYZ", displayName: "Web" }],
    otherStreams: [],
    keyEvents: [{ eventName: "purchase", countingMethod: "ONCE_PER_EVENT" }],
    customDefinitions: { dimensions: [], metrics: [] },
    dataAsOf: "2026-01-29T00:00:00.000Z",
    cached: true,
  };

  const ctx = createMockContext({
    deps: {
      getMeasurementHealth: async () => {
        healthCalled = true;
        return mockHealthResult;
      },
    },
  });

  const output = await getGoogleAnalyticsMeasurementHealthTool.handler(ctx, {});
  assert.ok(healthCalled);
  assert.equal(output.status, "ok");
  assert.equal((output.summary as any).webStreamCount, 1);
});

test("F20-AC-26: handler calls getOpportunities and parses output", async () => {
  let oppArgs: any = null;
  const mockOpportunitiesResult = {
    status: "ok",
    source: { provider: "google_analytics_and_search_console" },
    request: { dateRange: { startDate: "2026-01-01", endDate: "2026-01-28" } },
    rowCount: 1,
    totalCandidateRows: 5,
    rows: [
      {
        page: "https://example.com/page-1",
        normalizedPage: "example.com/page-1",
        clicks: 120,
        impressions: 4000,
        ctr: 0.03,
        position: 8.5,
        joinStatus: "matched",
        ga4: { sessions: 85, keyEvents: 4, engagementRate: 0.65 },
        score: 72,
        scoreComponents: { demand: 80, businessValue: 60, reachability: 70 },
      },
    ],
    scoring: { maxClicks: 120, maxSessions: 85 },
    coverage: { matchedRows: 1, candidateRows: 5 },
    truncated: { gsc: false, ga4: false },
    warnings: [],
    dataAsOf: "2026-01-29T00:00:00.000Z",
    cached: false,
  };

  const ctx = createMockContext({
    deps: {
      getOpportunities: async (_admin, _brand, input) => {
        oppArgs = input;
        return mockOpportunitiesResult;
      },
    },
  });

  const output = await getSearchOpportunitiesTool.handler(ctx, {
    startDate: "2026-01-01",
    endDate: "2026-01-28",
    limit: 25,
  });

  assert.equal(oppArgs.startDate, "2026-01-01");
  assert.equal(oppArgs.endDate, "2026-01-28");
  assert.equal(oppArgs.limit, 25);
  assert.equal(output.rowCount, 1);
  assert.equal((output.rows as any[])[0].score, 72);
});

test("F20-AC-26: handlers propagate underlying service errors", async () => {
  const ctx = createMockContext({
    deps: {
      getOrganicOverview: async () => {
        throw new Error("ga4_not_connected");
      },
    },
  });

  await assert.rejects(
    () => getGoogleAnalyticsOrganicOverviewTool.handler(ctx, {}),
    /ga4_not_connected/,
  );
});
