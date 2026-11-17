// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ga4/services/Ga4OrganicOverviewService.test.ts:50-158
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encryptToken } from "../gsc/oauthCrypto.js";
import { getOrganicOverview } from "./overview.ts";
import { fakeGa4Admin } from "./fakeAdmin.testkit.ts";

process.env.GSC_TOKEN_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../tests/fixtures/f20/${name}`, import.meta.url), "utf8"));

const OWNER = "11111111-1111-4111-8111-111111111111";
const GRANT = "33333333-3333-4333-8333-333333333333";
const NOW = Date.parse("2026-08-06T15:00:00.000Z");

function admin() {
  return fakeGa4Admin({
    ga4_grants: [
      {
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
      },
    ],
    ga4_connections: [
      {
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
      },
    ],
    customer_brand_memberships: [{ brand_key: "acme", user_id: OWNER, role: "owner" }],
  });
}

const ws = { brandKey: "acme", user: { id: OWNER, email: "owner@example.com" }, role: "owner" as const };

function dataFetch(responses: Response[]) {
  const calls: string[] = [];
  const queue = [...responses];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    const next = queue.shift();
    if (!next) throw new Error("unexpected fetch");
    return next;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const metricValues = (values: string[]) => values.map((value) => ({ value }));

describe("GA4 organic overview", () => {
  it("returns an equal-length comparison and flags a truncated trend", async () => {
    const trendWeekly = {
      dimensionHeaders: [{ name: "yearWeek" }],
      metricHeaders: ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents", "transactions", "purchaseRevenue"].map((name) => ({ name })),
      rows: [{ dimensionValues: [{ value: "202631" }], metricValues: metricValues(["100", "80", "70", "0.7", "10", "4", "500"]) }],
      rowCount: 1200,
    };
    const { fetchImpl, calls } = dataFetch([
      Response.json(fixture("run-report-overview-current.json")),
      Response.json(fixture("run-report-overview-previous.json")),
      Response.json(trendWeekly),
    ]);
    const result = await getOrganicOverview(
      admin(),
      ws,
      { startDate: "2026-07-09", endDate: "2026-08-05", trend: "weekly" },
      { now: () => NOW, fetchImpl },
    );
    assert.deepEqual(result.request.previousDateRange, { startDate: "2026-06-11", endDate: "2026-07-08" });
    assert.deepEqual(result.comparison.sessions, { current: 100, previous: 80, absoluteChange: 20, percentChange: 0.25 });
    assert.deepEqual(result.trend[0], {
      yearWeek: "202631",
      sessions: 100,
      activeUsers: 80,
      engagedSessions: 70,
      engagementRate: 0.7,
      keyEvents: 10,
      transactions: 4,
      purchaseRevenue: 500,
    });
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.warnings, ["trend_truncated"]);
    assert.equal(calls.length, 3);
    assert.equal(result.cached, false);
  });

  it("flags a material key-event decline with explicit evidence", async () => {
    const report = (keyEvents: string) => ({
      metricHeaders: ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents", "transactions", "purchaseRevenue"].map((name) => ({ name })),
      rows: [{ dimensionValues: [], metricValues: metricValues(["100", "80", "70", "0.7", keyEvents, "0", "0"]) }],
      rowCount: 1,
    });
    const { fetchImpl } = dataFetch([Response.json(report("3")), Response.json(report("10")), Response.json({ dimensionHeaders: [{ name: "date" }], metricHeaders: ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents", "transactions", "purchaseRevenue"].map((name) => ({ name })), rowCount: 0 })]);
    const result = await getOrganicOverview(admin(), ws, { trend: "daily" }, { now: () => NOW, fetchImpl });
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.code, "key_events_sharp_decline");
    assert.deepEqual(result.diagnostics[0]?.evidence, { current: 3, previous: 10, percentChange: -0.7 });
    assert.deepEqual(result.diagnostics[0]?.threshold, { minimumPreviousKeyEvents: 5, percentChange: -0.5 });
  });

  it("zero-fills missing days only when the trend is complete and unlimited", async () => {
    const current = fixture("run-report-overview-current.json");
    const previous = fixture("run-report-overview-previous.json");
    const trendMissingDay = {
      dimensionHeaders: [{ name: "date" }],
      metricHeaders: ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents", "transactions", "purchaseRevenue"].map((name) => ({ name })),
      rows: [
        { dimensionValues: [{ value: "20260801" }], metricValues: metricValues(["30", "25", "20", "0.66", "3", "1", "100"]) },
        { dimensionValues: [{ value: "20260803" }], metricValues: metricValues(["40", "32", "28", "0.7", "4", "2", "150"]) },
      ],
      rowCount: 2,
    };
    const filled = await getOrganicOverview(
      admin(),
      ws,
      { startDate: "2026-08-01", endDate: "2026-08-03", trend: "daily" },
      { now: () => Date.parse("2026-08-06T15:00:00.000Z"), fetchImpl: dataFetch([Response.json(current), Response.json(previous), Response.json(trendMissingDay)]).fetchImpl },
    );
    assert.equal(filled.trendFilled, true);
    assert.deepEqual(filled.trend, [
      { date: "2026-08-01", sessions: 30 },
      { date: "2026-08-02", sessions: 0 },
      { date: "2026-08-03", sessions: 40 },
    ]);

    const limitedTrend = { ...trendMissingDay, metadata: { subjectToThresholding: true } };
    const limited = await getOrganicOverview(
      admin(),
      ws,
      { startDate: "2026-08-01", endDate: "2026-08-03", trend: "daily" },
      { now: () => Date.parse("2026-08-06T15:00:00.000Z"), fetchImpl: dataFetch([Response.json(current), Response.json(previous), Response.json(limitedTrend)]).fetchImpl },
    );
    assert.equal(limited.trendFilled, false);
    assert.equal(limited.trend.length, 2);
    assert.ok(!limited.trend.some((row: { date?: string }) => row.date === "2026-08-02"));
  });
});
