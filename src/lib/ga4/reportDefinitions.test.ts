// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ga4/services/Ga4ReportDefinitions.ts (cases)
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildGa4OverviewRequest,
  buildGa4ReportRequest,
  getGa4ReportConfiguration,
  OVERVIEW_METRICS,
} from "./reportDefinitions.ts";

const base = {
  startDate: "2026-07-09",
  endDate: "2026-08-05",
  channel: "organic_search" as const,
  limit: 100,
  offset: 0,
};

describe("GA4 report definitions", () => {
  it("builds the organic landing-pages request", () => {
    const req = buildGa4ReportRequest({ ...base, kind: "landing_pages" });
    assert.deepEqual(req.dimensions, [{ name: "hostName" }, { name: "landingPage" }]);
    assert.deepEqual(
      req.metrics.map((m) => m.name),
      ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents", "sessionKeyEventRate", "transactions", "purchaseRevenue"],
    );
    assert.deepEqual(req.orderBys, [{ metric: { metricName: "sessions" }, desc: true }]);
    assert.equal(req.keepEmptyRows, false);
    assert.equal(req.returnPropertyQuota, true);
    assert.equal(req.offset, "0");
    assert.equal(req.limit, "100");
    assert.deepEqual(req.dimensionFilter, {
      filter: {
        fieldName: "sessionDefaultChannelGroup",
        stringFilter: { matchType: "EXACT", value: "Organic Search" },
      },
    });
    assert.equal(req.metricFilter, undefined);
  });

  it("adds the date dimension for page performance over all channels", () => {
    const req = buildGa4ReportRequest({ ...base, kind: "page_performance", channel: "all", includeDate: true });
    assert.deepEqual(req.dimensions, [{ name: "hostName" }, { name: "pagePath" }, { name: "date" }]);
    assert.equal(req.dimensionFilter, undefined);
  });

  it("drops events that never fired for key events", () => {
    const req = buildGa4ReportRequest({ ...base, kind: "key_events" });
    assert.deepEqual(req.dimensions, [{ name: "eventName" }]);
    assert.deepEqual(req.metricFilter, {
      filter: {
        fieldName: "keyEvents",
        numericFilter: { operation: "GREATER_THAN", value: { doubleValue: 0 } },
      },
    });
  });

  it("switches acquisition and audience breakdown dimensions", () => {
    const channel = buildGa4ReportRequest({ ...base, kind: "traffic_acquisition", acquisitionBreakdown: "channel_group" });
    assert.deepEqual(channel.dimensions, [{ name: "sessionDefaultChannelGroup" }]);
    const source = buildGa4ReportRequest({ ...base, kind: "traffic_acquisition", channel: "all", acquisitionBreakdown: "source_medium" });
    assert.deepEqual(source.dimensions, [{ name: "sessionSourceMedium" }]);
    const campaign = buildGa4ReportRequest({ ...base, kind: "traffic_acquisition", channel: "all", acquisitionBreakdown: "campaign" });
    assert.deepEqual(campaign.dimensions, [{ name: "sessionCampaignName" }]);

    const device = buildGa4ReportRequest({ ...base, kind: "audience_breakdown", audienceBreakdown: "device" });
    assert.deepEqual(device.dimensions, [{ name: "deviceCategory" }]);
    const country = buildGa4ReportRequest({ ...base, kind: "audience_breakdown", audienceBreakdown: "country" });
    assert.deepEqual(country.dimensions, [{ name: "country" }]);
    const returning = buildGa4ReportRequest({ ...base, kind: "audience_breakdown", audienceBreakdown: "new_vs_returning" });
    assert.deepEqual(returning.dimensions, [{ name: "newVsReturning" }]);
  });

  it("keeps only real search terms for site search", () => {
    const req = buildGa4ReportRequest({ ...base, kind: "site_search", channel: "all" });
    assert.deepEqual(req.dimensions, [{ name: "searchTerm" }]);
    assert.deepEqual(req.dimensionFilter, {
      andGroup: {
        expressions: [
          { filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: "view_search_results" } } },
          { notExpression: { filter: { fieldName: "searchTerm", stringFilter: { matchType: "EXACT", value: "(not set)" } } } },
        ],
      },
    });
  });

  it("limits ecommerce landing pages to those with transactions", () => {
    const req = buildGa4ReportRequest({
      ...base,
      kind: "ecommerce_performance",
      ecommerceBreakdown: "landing_page",
      ecommerceOnlyWithTransactions: true,
    });
    assert.deepEqual(req.dimensions, [{ name: "hostName" }, { name: "landingPage" }]);
    assert.deepEqual(
      req.metrics.map((m) => m.name),
      ["sessions", "transactions", "purchaseRevenue"],
    );
    assert.deepEqual(req.metricFilter, {
      filter: {
        fieldName: "transactions",
        numericFilter: { operation: "GREATER_THAN", value: { doubleValue: 0 } },
      },
    });
  });

  it("reports configuration breakdowns and flags", () => {
    assert.equal(getGa4ReportConfiguration({ ...base, kind: "landing_pages" }).breakdown, "landing_page");
    assert.equal(getGa4ReportConfiguration({ ...base, kind: "page_performance", includeDate: true }).breakdown, "page_and_date");
    assert.equal(getGa4ReportConfiguration({ ...base, kind: "key_events" }).breakdown, "event");
    assert.deepEqual(getGa4ReportConfiguration({ ...base, kind: "ecommerce_performance", ecommerceBreakdown: "landing_page" }).flags, {
      includeDate: false,
      onlyWithTransactions: false,
    });
  });

  it("builds the overview request with the shared metric set", () => {
    assert.deepEqual([...OVERVIEW_METRICS], ["sessions", "activeUsers", "engagedSessions", "engagementRate", "keyEvents", "transactions", "purchaseRevenue"]);
    const plain = buildGa4OverviewRequest({ startDate: "2026-07-09", endDate: "2026-08-05" });
    assert.deepEqual(plain.dimensions, []);
    assert.equal(plain.limit, "1");
    const daily = buildGa4OverviewRequest({ startDate: "2026-07-09", endDate: "2026-08-05", trend: "daily" });
    assert.deepEqual(daily.dimensions, [{ name: "date" }]);
    assert.equal(daily.limit, "1000");
    const weekly = buildGa4OverviewRequest({ startDate: "2026-07-09", endDate: "2026-08-05", trend: "weekly" });
    assert.deepEqual(weekly.dimensions, [{ name: "yearWeek" }]);
  });
});
