// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ga4/services/Ga4ReportEnhancements.test.ts:26-182
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildReportComparison,
  buildReportSpecificEnhancements,
  supportsComparison,
} from "./enhancements.ts";
import type { NormalizedGa4Report } from "./normalization.ts";

const metadata = {
  dataLossFromOtherRow: false,
  subjectToThresholding: false,
  sampling: [],
  restrictedMetrics: [],
  emptyReason: null,
  hasLimitedData: false,
};

function report(rows: NormalizedGa4Report["rows"], totalRowCount = rows.length): NormalizedGa4Report {
  return { rows, totalRowCount, reportMetadata: metadata, quota: null };
}

describe("GA4 report enhancements", () => {
  it("compares an equal prior period using the union of row keys", () => {
    const comparison = buildReportComparison({
      current: report([{ eventName: "form_submit", keyEvents: 3 }]),
      previous: report([
        { eventName: "form_submit", keyEvents: 0 },
        { eventName: "book_demo", keyEvents: 2 },
      ]),
      previousDateRange: { startDate: "2026-06-11", endDate: "2026-07-08" },
      dimensions: ["eventName"],
      metrics: ["keyEvents"],
    });
    assert.equal(comparison.coverage.complete, true);
    assert.deepEqual(comparison.rows, [
      {
        dimensions: { eventName: "form_submit" },
        metrics: { keyEvents: { current: 3, previous: 0, absoluteChange: 3, percentChange: null } },
      },
      {
        dimensions: { eventName: "book_demo" },
        metrics: { keyEvents: { current: null, previous: 2, absoluteChange: null, percentChange: null } },
      },
    ]);
  });

  it("limits comparisons to unambiguous low-cardinality breakdowns", () => {
    assert.equal(supportsComparison({ kind: "traffic_acquisition", acquisitionBreakdown: "channel_group" }), true);
    assert.equal(supportsComparison({ kind: "traffic_acquisition", acquisitionBreakdown: "source_medium" }), false);
    assert.equal(supportsComparison({ kind: "audience_breakdown", audienceBreakdown: "country" }), false);
    assert.equal(supportsComparison({ kind: "key_events" }), true);
    assert.equal(supportsComparison({ kind: "audience_breakdown", audienceBreakdown: "new_vs_returning" }), true);
  });

  it("returns evidence-backed source attribution diagnostics", () => {
    const result = buildReportSpecificEnhancements(
      report([
        { sessionSourceMedium: "google / organic", sessions: 80 },
        { sessionSourceMedium: "(not set)", sessions: 10 },
        { sessionSourceMedium: "localhost:6443 / referral", sessions: 5 },
        { sessionSourceMedium: "::1 / referral", sessions: 1 },
        { sessionSourceMedium: "LinkedIn / Social", sessions: 3 },
        { sessionSourceMedium: "linkedin / social", sessions: 2 },
      ]),
      { kind: "traffic_acquisition", acquisitionBreakdown: "source_medium" },
      { startDate: "2026-07-09", endDate: "2026-08-05" },
    );
    assert.equal("diagnosticCoverage" in result, true);
    assert.deepEqual((result as { diagnosticCoverage: { complete: boolean } }).diagnosticCoverage, {
      complete: true,
      limitedData: false,
      fetchedRowCount: 6,
      totalRowCount: 6,
    });
    assert.deepEqual(result.diagnostics.map((d) => d.code), [
      "attribution_not_set_share_high",
      "internal_referral_traffic_detected",
      "source_medium_case_variants_detected",
    ]);
  });

  it("suppresses diagnostics and marks activity unknown when coverage is incomplete", () => {
    const incomplete = report([{ sessionSourceMedium: "localhost / referral", sessions: 5 }], 2);
    const diagnostics = buildReportSpecificEnhancements(
      incomplete,
      { kind: "traffic_acquisition", acquisitionBreakdown: "source_medium" },
      { startDate: "2026-07-09", endDate: "2026-08-05" },
    );
    const ecommerce = buildReportSpecificEnhancements(
      report([{ itemName: "Example", itemsViewed: 1 }], 2),
      { kind: "ecommerce_performance", ecommerceBreakdown: "item" },
      { startDate: "2026-07-09", endDate: "2026-08-05" },
    );
    assert.deepEqual(diagnostics.diagnostics, []);
    assert.deepEqual((ecommerce as { ecommerceActivity: { status: string } }).ecommerceActivity.status, "unknown");
  });

  it("reports scoped ecommerce and site-search activity states", () => {
    const ecommerce = buildReportSpecificEnhancements(
      report([]),
      { kind: "ecommerce_performance", ecommerceBreakdown: "landing_page", channel: "organic_search" },
      { startDate: "2026-07-09", endDate: "2026-08-05" },
    );
    const search = buildReportSpecificEnhancements(
      report([{ searchTerm: "seo", eventCount: 4 }]),
      { kind: "site_search" },
      { startDate: "2026-07-09", endDate: "2026-08-05" },
    );
    assert.deepEqual((ecommerce as { diagnostics: Array<{ code: string }> }).diagnostics.map((d) => d.code), ["no_ecommerce_activity"]);
    assert.deepEqual((ecommerce as { ecommerceActivity: Record<string, unknown> }).ecommerceActivity, {
      status: "none",
      dateRange: { startDate: "2026-07-09", endDate: "2026-08-05" },
      channel: "organic_search",
      breakdown: "landing_page",
      evidence: { transactions: 0, purchaseRevenue: 0 },
      reason: "No matching ecommerce activity was reported for this period and channel.",
    });
    assert.deepEqual((search as { siteSearchActivity: Record<string, unknown> }).siteSearchActivity, {
      status: "detected",
      dateRange: { startDate: "2026-07-09", endDate: "2026-08-05" },
      searchTermCount: 1,
      searchEventCount: 4,
      reason: null,
    });
  });
});
