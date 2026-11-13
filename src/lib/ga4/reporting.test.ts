// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ga4/services/Ga4ReportingService.test.ts:77-340
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encryptToken } from "../gsc/oauthCrypto.js";
import { runReport } from "./reporting.ts";
import { Ga4ReportError } from "./errors.ts";
import { Ga4DataApiError } from "./client.ts";
import { fakeGa4Admin } from "./fakeAdmin.testkit.ts";

process.env.GSC_TOKEN_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../tests/fixtures/f20/${name}`, import.meta.url), "utf8"));

const OWNER = "11111111-1111-4111-8111-111111111111";
const GRANT = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-08-06T15:00:00.000Z");

function grantRow() {
  return {
    id: GRANT,
    user_id: OWNER,
    google_sub: "google-sub-a",
    google_email: "owner@example.com",
    status: "active",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    access_token_expires_at: new Date(NOW + 3_600_000).toISOString(),
    encrypted_access_token: JSON.stringify(encryptToken("ga4_tok", `ga4:${OWNER}:google-sub-a:access`)),
    encrypted_refresh_token: null,
  };
}

function connectionRow() {
  return {
    id: "conn-1",
    brand_key: "acme",
    grant_id: GRANT,
    connected_by: OWNER,
    google_sub: "google-sub-a",
    connected_account_email: "owner@example.com",
    property_id: "properties/22",
    property_display_name: "Site B",
    property_time_zone: "Asia/Kolkata",
    property_currency_code: "INR",
    account_display_name: "Client",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

function seeded(connections: unknown[] = [connectionRow()]) {
  return fakeGa4Admin({
    ga4_grants: [grantRow()],
    ga4_connections: connections as never[],
    customer_brand_memberships: [
      { brand_key: "acme", user_id: OWNER, role: "owner" },
      { brand_key: "acme", user_id: "22222222-2222-4222-8222-222222222222", role: "member" },
    ],
  });
}

const ws = { brandKey: "acme", user: { id: OWNER, email: "owner@example.com" }, role: "owner" as const };
const depsBase = { now: () => NOW };

function dataFetch(responses: Response[]) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const queue = [...responses];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = null;
    }
    calls.push({ url, body });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch to ${url}`);
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const landingHeaders = {
  dimensionHeaders: [{ name: "hostName" }, { name: "landingPage" }],
  metricHeaders: [
    "sessions",
    "activeUsers",
    "engagedSessions",
    "engagementRate",
    "keyEvents",
    "sessionKeyEventRate",
    "transactions",
    "purchaseRevenue",
  ].map((name) => ({ name })),
};

describe("Ga4ReportingService port", () => {
  it("builds and normalizes the organic landing-page report", async () => {
    const { fetchImpl, calls } = dataFetch([Response.json(fixture("run-report-landing-pages.json"))]);
    const result = await runReport(seeded(), ws, { kind: "landing_pages", limit: 1, offset: 1 }, { ...depsBase, fetchImpl });
    assert.deepEqual((calls[0].body as { dateRanges: unknown }).dateRanges, [{ startDate: "2026-07-09", endDate: "2026-08-05" }]);
    assert.deepEqual((calls[0].body as { dimensionFilter: unknown }).dimensionFilter, {
      filter: {
        fieldName: "sessionDefaultChannelGroup",
        stringFilter: { matchType: "EXACT", value: "Organic Search" },
      },
    });
    assert.equal((calls[0].body as { offset: string }).offset, "1");
    assert.equal((calls[0].body as { limit: string }).limit, "1");
    assert.deepEqual(result.rows[0], {
      hostName: "example.com",
      landingPage: "/guides/seo",
      sessions: 20,
      activeUsers: 18,
      engagedSessions: 14,
      engagementRate: 0.7,
      keyEvents: 3,
      sessionKeyEventRate: 0.15,
      transactions: 1,
      purchaseRevenue: 99.5,
    });
    assert.deepEqual(result.pageInfo, { offset: 1, limit: 1, hasMore: true, nextOffset: 2 });
    assert.equal(result.reportMetadata.hasLimitedData, true);
    assert.deepEqual(result.quota?.tokensPerDay, { consumed: 10, remaining: 90 });
    assert.deepEqual(result.request.reportKind, "landing_pages");
    assert.equal(result.cached, false);
    assert.equal(typeof result.dataAsOf, "string");
  });

  it("clamps a future endDate, keeps a long startDate, and nulls restricted metrics", async () => {
    const restricted = {
      ...landingHeaders,
      rows: [
        {
          dimensionValues: [{ value: "example.com" }, { value: "/" }],
          metricValues: ["1", "1", "1", "1", "1", "1", "1", "0"].map((value) => ({ value })),
        },
      ],
      rowCount: 1,
      metadata: {
        schemaRestrictionResponse: {
          activeMetricRestrictions: [{ metricName: "purchaseRevenue", restrictedMetricTypes: ["COST_DATA"] }],
        },
      },
    };
    const { fetchImpl } = dataFetch([Response.json(restricted)]);
    const result = await runReport(
      seeded(),
      ws,
      { kind: "landing_pages", startDate: "2025-01-01", endDate: "2026-08-20" },
      { ...depsBase, fetchImpl },
    );
    assert.deepEqual(result.request.resolvedDateRange, { startDate: "2025-01-01", endDate: "2026-08-05" });
    assert.deepEqual(result.warnings, ["end_date_clamped"]);
    assert.equal(result.rows[0]?.purchaseRevenue, null);
  });

  it("returns stable connection and quota errors", async () => {
    await assert.rejects(runReport(seeded([]), ws, { kind: "landing_pages" }, depsBase), (err: unknown) =>
      (err as { code?: string }).code === "ga4_not_connected",
    );

    const quotaBody = fixture("run-report-429.json");
    const { fetchImpl } = dataFetch([new Response(JSON.stringify(quotaBody), { status: 429, headers: { "retry-after": "60" } })]);
    const failure = runReport(seeded(), ws, { kind: "landing_pages" }, { ...depsBase, fetchImpl });
    await assert.rejects(failure, (err: unknown) => err instanceof Ga4ReportError);
    await assert.rejects(failure, (err: unknown) => (err as Ga4ReportError).code === "ga4_quota_exhausted");
    const err = await failure.catch((e: unknown) => e as Ga4ReportError);
    assert.equal((err as Ga4ReportError).retryAfterSeconds, 60);

    // Direct mapping unit: 400 → incompatible, 401 → reconnect.
    const { mapGa4ReportError } = await import("./reporting.ts");
    assert.throws(() => mapGa4ReportError(new Ga4DataApiError(400, "bad")), (e: unknown) => (e as Ga4ReportError).code === "ga4_report_incompatible");
  });

  it("rejects half-ranges and reversed dates before calling Google", async () => {
    const { fetchImpl, calls } = dataFetch([]);
    await assert.rejects(
      runReport(seeded(), ws, { kind: "landing_pages", startDate: "2026-07-01" }, { ...depsBase, fetchImpl }),
      (err: unknown) => (err as Ga4ReportError).code === "validation_error",
    );
    await assert.rejects(
      runReport(seeded(), ws, { kind: "landing_pages", startDate: "2026-07-20", endDate: "2026-07-01" }, { ...depsBase, fetchImpl }),
      (err: unknown) => (err as Ga4ReportError).code === "validation_error",
    );
    assert.equal(calls.length, 0);
  });

  it("builds the non-obvious request shapes each report kind adds", async () => {
    const cases: Array<{ input: Record<string, unknown>; match: Record<string, unknown> }> = [
      {
        input: { kind: "site_search", channel: "all" },
        match: {
          dimensionFilter: {
            andGroup: {
              expressions: [
                { filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "view_search_results" } } },
                { notExpression: { filter: { fieldName: "searchTerm", stringFilter: { matchType: "EXACT", value: "(not set)" } } } },
              ],
            },
          },
        },
      },
      {
        input: { kind: "page_performance", channel: "all", includeDate: true },
        match: { dimensions: [{ name: "hostName" }, { name: "pagePath" }, { name: "date" }], dimensionFilter: undefined },
      },
      {
        input: { kind: "key_events", channel: "organic_search" },
        match: { metricFilter: { filter: { fieldName: "keyEvents", numericFilter: { operation: "GREATER_THAN", value: { doubleValue: 0 } } } } },
      },
      {
        input: { kind: "ecommerce_performance", ecommerceBreakdown: "landing_page", ecommerceOnlyWithTransactions: true, channel: "organic_search" },
        match: {
          dimensions: [{ name: "hostName" }, { name: "landingPage" }],
          metricFilter: { filter: { fieldName: "transactions", numericFilter: { operation: "GREATER_THAN", value: { doubleValue: 0 } } } },
        },
      },
    ];
    for (const { input, match } of cases) {
      const { fetchImpl, calls } = dataFetch([Response.json({})]);
      await runReport(seeded(), ws, input as never, { ...depsBase, fetchImpl });
      for (const [key, value] of Object.entries(match)) {
        assert.deepEqual((calls[0].body as Record<string, unknown>)[key], value);
      }
    }
  });

  it("treats a headerless previous-period response as empty instead of malformed", async () => {
    const current = {
      dimensionHeaders: [{ name: "deviceCategory" }],
      metricHeaders: ["activeUsers", "sessions", "engagementRate", "keyEvents"].map((name) => ({ name })),
      rows: [{ dimensionValues: [{ value: "mobile" }], metricValues: ["10", "12", "0.5", "2"].map((value) => ({ value })) }],
      rowCount: 1,
    };
    const { fetchImpl } = dataFetch([Response.json(current), Response.json(fixture("run-report-headerless.json"))]);
    const result = await runReport(
      seeded(),
      ws,
      { kind: "audience_breakdown", audienceBreakdown: "device", comparePreviousPeriod: true },
      { ...depsBase, fetchImpl },
    );
    assert.deepEqual(result.comparison?.rows, [
      {
        dimensions: { deviceCategory: "mobile" },
        metrics: {
          activeUsers: { current: 10, previous: null, absoluteChange: null, percentChange: null },
          sessions: { current: 12, previous: null, absoluteChange: null, percentChange: null },
          engagementRate: { current: 0.5, previous: null, absoluteChange: null, percentChange: null },
          keyEvents: { current: 2, previous: null, absoluteChange: null, percentChange: null },
        },
      },
    ]);
    assert.deepEqual(result.comparison?.coverage.previous, { fetchedRowCount: 0, totalRowCount: 0 });
  });

  it("fetches the real page beyond the diagnostic buffer at high offsets", async () => {
    const metricNames = ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents", "transactions", "purchaseRevenue"];
    const page = (start: number, length: number) => ({
      dimensionHeaders: [{ name: "sessionSourceMedium" }],
      metricHeaders: metricNames.map((name) => ({ name })),
      rows: Array.from({ length }, (_, i) => ({
        dimensionValues: [{ value: `source-${start + i} / referral` }],
        metricValues: metricNames.map(() => ({ value: "1" })),
      })),
      rowCount: 1100,
    });
    for (const { offset, hasMore, nextOffset } of [{ offset: 950, hasMore: true, nextOffset: 1050 }, { offset: 1000, hasMore: false, nextOffset: null }]) {
      const { fetchImpl, calls } = dataFetch([Response.json(page(0, 1000)), Response.json(page(offset, 100))]);
      const result = await runReport(
        seeded(),
        ws,
        { kind: "traffic_acquisition", acquisitionBreakdown: "source_medium", channel: "all", offset, limit: 100 },
        { ...depsBase, fetchImpl },
      );
      assert.equal(calls.length, 2);
      assert.deepEqual({ offset: (calls[1].body as { offset: string }).offset, limit: (calls[1].body as { limit: string }).limit }, { offset: String(offset), limit: "100" });
      assert.equal(result.rows.length, 100);
      assert.equal(result.rows[0]?.sessionSourceMedium, `source-${offset} / referral`);
      assert.deepEqual(result.pageInfo, { offset, limit: 100, hasMore, nextOffset });
    }
  });
});
