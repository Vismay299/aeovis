// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ga4/services/Ga4MeasurementHealthService.test.ts:56-67
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encryptToken } from "../gsc/oauthCrypto.js";
import { getMeasurementHealth } from "./measurementHealth.ts";
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

function adminFetch(map: Record<string, unknown>) {
  const calls: string[] = [];
  // Match the most specific Admin path first: the enhanced-measurement URL
  // contains "/dataStreams/", so a naive insertion-order scan would return
  // the streams fixture for it.
  const ordered = Object.entries(map).sort((a, b) => b[0].length - a[0].length);
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    for (const [prefix, body] of ordered) {
      if (url.includes(prefix)) return Response.json(body);
    }
    throw new Error(`unexpected admin fetch ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("GA4 measurement health", () => {
  it("returns a read-only measurement inventory and actionable issues", async () => {
    const { fetchImpl } = adminFetch({
      "dataStreams": fixture("data-streams.json"),
      "enhancedMeasurementSettings": fixture("enhanced-measurement.json"),
      "keyEvents": fixture("key-events.json"),
      "customDimensions": fixture("custom-dimensions.json"),
      "customMetrics": fixture("custom-metrics.json"),
    });
    const result = await getMeasurementHealth(admin(), ws, { now: () => NOW, fetchImpl });
    assert.deepEqual(result.issues, ["site_search_measurement_disabled"]);
    assert.deepEqual(result.summary, {
      dataStreamCount: 1,
      webStreamCount: 1,
      keyEventCount: 1,
      customDimensionCount: 0,
      customMetricCount: 0,
      issueCount: 1,
    });
    assert.equal(result.webStreams[0]?.streamId, "456");
    assert.equal(result.webStreams[0]?.measurementId, "G-ABC123");
    assert.equal(result.webStreams[0]?.enhancedMeasurement.siteSearchEnabled, false);
    assert.equal(result.cached, false);
    assert.equal(typeof result.dataAsOf, "string");
  });

  it("reports missing streams and missing key events", async () => {
    const { fetchImpl } = adminFetch({
      "dataStreams": { dataStreams: [] },
      "keyEvents": { keyEvents: [] },
      "customDimensions": fixture("custom-dimensions.json"),
      "customMetrics": fixture("custom-metrics.json"),
    });
    const result = await getMeasurementHealth(admin(), ws, { now: () => NOW, fetchImpl });
    assert.ok(result.issues.includes("no_web_stream"));
    assert.ok(result.issues.includes("no_key_events_configured"));
  });

  it("flags fully disabled enhanced measurement", async () => {
    const { fetchImpl } = adminFetch({
      "dataStreams": fixture("data-streams.json"),
      "enhancedMeasurementSettings": { streamEnabled: false, siteSearchEnabled: false },
      "keyEvents": fixture("key-events.json"),
      "customDimensions": fixture("custom-dimensions.json"),
      "customMetrics": fixture("custom-metrics.json"),
    });
    const result = await getMeasurementHealth(admin(), ws, { now: () => NOW, fetchImpl });
    assert.ok(result.issues.includes("enhanced_measurement_disabled"));
  });
});
