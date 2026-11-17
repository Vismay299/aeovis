// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ga4/services/Ga4ReportNormalization.ts (cases)
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeGa4Response } from "./normalization.ts";
import { Ga4MalformedResponseError } from "./errors.ts";
import { buildGa4ReportRequest } from "./reportDefinitions.ts";

const baseInput = {
  kind: "landing_pages" as const,
  startDate: "2026-07-09",
  endDate: "2026-08-05",
  channel: "organic_search" as const,
  limit: 100,
  offset: 0,
};

describe("GA4 report normalization", () => {
  it("normalizes rows and surfaces quota and limited-data flags", () => {
    const request = buildGa4ReportRequest(baseInput);
    const normalized = normalizeGa4Response(
      {
        dimensionHeaders: [{ name: "hostName" }, { name: "landingPage" }],
        metricHeaders: [
          { name: "sessions" },
          { name: "activeUsers" },
          { name: "engagedSessions" },
          { name: "engagementRate" },
          { name: "keyEvents" },
          { name: "sessionKeyEventRate" },
          { name: "transactions" },
          { name: "purchaseRevenue" },
        ],
        rows: [
          {
            dimensionValues: [{ value: "example.com" }, { value: "/guides/seo" }],
            metricValues: ["20", "18", "14", "0.7", "3", "0.15", "1", "99.5"].map((value) => ({ value })),
          },
        ],
        rowCount: 3,
        metadata: {
          subjectToThresholding: true,
          samplingMetadatas: [{ samplesReadCount: "1000", samplingSpaceSize: "10000" }],
        },
        propertyQuota: { tokensPerDay: { consumed: 10, remaining: 90 } },
      },
      request,
    );
    assert.deepEqual(normalized.rows[0], {
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
    assert.equal(normalized.totalRowCount, 3);
    assert.equal(normalized.reportMetadata.hasLimitedData, true);
    assert.deepEqual(normalized.quota?.tokensPerDay, { consumed: 10, remaining: 90 });
  });

  it("refuses a header mismatch before reading rows", () => {
    const request = buildGa4ReportRequest(baseInput);
    assert.throws(
      () =>
        normalizeGa4Response(
          {
            dimensionHeaders: [{ name: "hostName" }],
            metricHeaders: [{ name: "sessions" }],
            rows: [],
            rowCount: 0,
          },
          request,
        ),
      (err: unknown) => err instanceof Ga4MalformedResponseError,
    );
  });

  it("nulls restricted metrics instead of reading them as numbers", () => {
    const request = buildGa4ReportRequest(baseInput);
    const normalized = normalizeGa4Response(
      {
        dimensionHeaders: [{ name: "hostName" }, { name: "landingPage" }],
        metricHeaders: [
          { name: "sessions" },
          { name: "activeUsers" },
          { name: "engagedSessions" },
          { name: "engagementRate" },
          { name: "keyEvents" },
          { name: "sessionKeyEventRate" },
          { name: "transactions" },
          { name: "purchaseRevenue" },
        ],
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
      },
      request,
    );
    assert.equal(normalized.rows[0]?.purchaseRevenue, null);
    assert.equal(normalized.reportMetadata.hasLimitedData, true);
  });

  it("treats a headerless empty response as an empty report, not malformed", () => {
    const request = buildGa4ReportRequest(baseInput);
    const normalized = normalizeGa4Response({}, request);
    assert.deepEqual(normalized.rows, []);
    assert.equal(normalized.totalRowCount, 0);
    assert.equal(normalized.reportMetadata.hasLimitedData, false);
  });

  it("refuses ragged rows and non-finite metrics", () => {
    const request = buildGa4ReportRequest(baseInput);
    const headers = {
      dimensionHeaders: [{ name: "hostName" }, { name: "landingPage" }],
      metricHeaders: [
        { name: "sessions" },
        { name: "activeUsers" },
        { name: "engagedSessions" },
        { name: "engagementRate" },
        { name: "keyEvents" },
        { name: "sessionKeyEventRate" },
        { name: "transactions" },
        { name: "purchaseRevenue" },
      ],
    };
    assert.throws(
      () =>
        normalizeGa4Response(
          { ...headers, rows: [{ dimensionValues: [{ value: "example.com" }], metricValues: [] }], rowCount: 1 },
          request,
        ),
      (err: unknown) => err instanceof Ga4MalformedResponseError,
    );
    assert.throws(
      () =>
        normalizeGa4Response(
          {
            ...headers,
            rows: [
              {
                dimensionValues: [{ value: "example.com" }, { value: "/" }],
                metricValues: ["NaN", "1", "1", "1", "1", "1", "1", "1"].map((value) => ({ value })),
              },
            ],
            rowCount: 1,
          },
          request,
        ),
      (err: unknown) => err instanceof Ga4MalformedResponseError,
    );
  });
});
