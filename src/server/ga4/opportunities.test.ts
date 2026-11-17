// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ga4/services/SearchOpportunityService.test.ts:68-202
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encryptToken } from "../gsc/oauthCrypto.js";
import {
  getOpportunities,
  normalizePageKey,
  percentileRanks,
  type OpportunitiesInput,
} from "./opportunities.ts";
import { Ga4ReportError } from "./errors.ts";
import { AppError } from "../../shared/http/appError.ts";
import { fakeGa4Admin } from "./fakeAdmin.testkit.ts";

process.env.GSC_TOKEN_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../tests/fixtures/f20/${name}`, import.meta.url), "utf8"));

const OWNER = "11111111-1111-4111-8111-111111111111";
const GRANT = "33333333-3333-4333-8333-333333333333";

function grantRow(nowMs: number) {
  return {
    id: GRANT,
    user_id: OWNER,
    google_sub: "google-sub-a",
    google_email: "owner@example.com",
    status: "active",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    access_token_expires_at: new Date(nowMs + 3_600_000).toISOString(),
    encrypted_access_token: JSON.stringify(encryptToken("ga4_tok", `ga4:${OWNER}:google-sub-a:access`)),
    encrypted_refresh_token: null,
  };
}

function connectionRow(propertyTimeZone: string) {
  return {
    id: "conn-1",
    brand_key: "acme",
    grant_id: GRANT,
    connected_by: OWNER,
    google_sub: "google-sub-a",
    connected_account_email: "owner@example.com",
    property_id: "properties/22",
    property_display_name: "Site B",
    property_time_zone: propertyTimeZone,
    property_currency_code: "INR",
    account_display_name: "Client",
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
  };
}

const GSC_CONN = {
  brand_key: "acme",
  enabled: true,
  auth_mode: "oauth",
  site_url: "https://example.com/",
  connection_generation: 7,
};

function adminWithGsc(seed: Record<string, unknown[]>, gscConn: unknown) {
  const base: any = fakeGa4Admin(seed as never);
  return {
    ...base,
    from: (table: string) => {
      if (table === "gsc_connections") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: gscConn, error: null }),
            }),
          }),
        };
      }
      return base.from(table);
    },
    rpc: base.rpc.bind(base),
  };
}

function seeded(nowMs: number, over: { propertyTimeZone?: string; gsc?: unknown } = {}) {
  return adminWithGsc(
    {
      ga4_grants: [grantRow(nowMs)],
      ga4_connections: [connectionRow(over.propertyTimeZone ?? "America/New_York")],
      customer_brand_memberships: [{ brand_key: "acme", user_id: OWNER, role: "owner" }],
    },
    over.gsc === undefined ? GSC_CONN : over.gsc,
  );
}

const ws = { brandKey: "acme", user: { id: OWNER, email: "owner@example.com" }, role: "owner" as const };

const METRIC_NAMES = [
  "sessions",
  "activeUsers",
  "engagedSessions",
  "engagementRate",
  "keyEvents",
  "sessionKeyEventRate",
  "transactions",
  "purchaseRevenue",
];

function ga4LandingPayload(
  rows: Array<{ host: string; landing: string; metrics: Array<string | number> }>,
  extra: Record<string, unknown> = {},
) {
  return {
    dimensionHeaders: [{ name: "hostName" }, { name: "landingPage" }],
    metricHeaders: METRIC_NAMES.map((name) => ({ name })),
    rows: rows.map((row) => ({
      dimensionValues: [{ value: row.host }, { value: row.landing }],
      metricValues: row.metrics.map((value) => ({ value: String(value) })),
    })),
    rowCount: rows.length,
    ...extra,
  };
}

function ga4Fetch(payloads: unknown[], calls: Array<{ url: string; body: unknown }>) {
  const queue = [...payloads];
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = null;
    }
    calls.push({ url, body });
    const next = queue.shift();
    if (next === undefined) throw new Error(`unexpected GA4 fetch to ${url}`);
    if (next instanceof Error) throw next;
    return Response.json(next);
  }) as typeof fetch;
}

function gscFetchStub(rows: unknown, calls: Array<{ siteUrl: string; opts: unknown; deps: unknown }>, error?: Error) {
  return (async (siteUrl: string, opts: unknown, deps: unknown) => {
    calls.push({ siteUrl, opts, deps });
    if (error) throw error;
    return rows;
  }) as never;
}

const HIGH_VALUE = { host: "example.com", landing: "/High-Value/?utm_source=x", metrics: [100, 90, 80, 0.8, 10, 0.1, 2, 500] };
const OTHER = { host: "example.com", landing: "/other/", metrics: [10, 9, 5, 0.5, 1, 0.02, 0, 0] };

const UPSTREAM_GSC_ROWS = [
  { keys: ["https://EXAMPLE.com/High-Value/?ref=gsc"], clicks: 10, impressions: 1000, ctr: 0.01, position: 6 },
  { keys: ["https://example.com/other"], clicks: 5, impressions: 500, ctr: 0.01, position: 12 },
  { keys: ["https://example.com/no-analytics"], clicks: 1, impressions: 2000, ctr: 0.0005, position: 8 },
  { keys: ["https://example.com/top-result"], clicks: 100, impressions: 3000, ctr: 0.03, position: 2 },
];

describe("SearchOpportunityService port", () => {
  it("normalizes URLs, scores joined candidates, and leaves unmatched pages unscored", async () => {
    const NOW = Date.parse("2026-08-06T12:00:00.000Z");
    const ga4Calls: Array<{ url: string; body: unknown }> = [];
    const gscCalls: Array<{ siteUrl: string; opts: unknown; deps: unknown }> = [];
    const result = await getOpportunities(
      seeded(NOW),
      ws,
      {},
      {
        now: () => NOW,
        fetchImpl: ga4Fetch([ga4LandingPayload([HIGH_VALUE, OTHER])], ga4Calls),
        gscFetch: gscFetchStub({ rows: UPSTREAM_GSC_ROWS }, gscCalls),
      },
    );

    // One live GSC call with the exact §6.2 body.
    assert.equal(gscCalls.length, 1);
    assert.equal(gscCalls[0]?.siteUrl, "https://example.com/");
    assert.deepEqual((gscCalls[0]?.opts as { method: string }).method, "POST");
    assert.deepEqual(
      JSON.parse((gscCalls[0]?.opts as { body: string }).body),
      {
        startDate: "2026-07-07",
        endDate: "2026-08-03",
        dimensions: ["page"],
        rowLimit: 1000,
        startRow: 0,
        type: "web",
        dataState: "final",
      },
    );
    assert.deepEqual(
      { brandKey: (gscCalls[0]?.deps as { brandKey: string }).brandKey, authMode: (gscCalls[0]?.deps as { authMode: string }).authMode },
      { brandKey: "acme", authMode: "oauth" },
    );

    // The GA4 landing-pages read shares the same range.
    assert.equal(ga4Calls.length, 1);
    assert.deepEqual((ga4Calls[0]?.body as { dateRanges: unknown }).dateRanges, [
      { startDate: "2026-07-07", endDate: "2026-08-03" },
    ]);

    assert.equal(result.totalCandidateRows, 3);
    assert.deepEqual(result.coverage, {
      gscRowsConsidered: 4,
      ga4RowsConsidered: 2,
      matchedRows: 2,
      unmatchedGscRows: 1,
      unmatchedGa4Rows: 0,
    });
    assert.equal(result.rows[0]?.page, "https://EXAMPLE.com/High-Value/?ref=gsc");
    assert.equal(result.rows[0]?.normalizedPage, "example.com/High-Value");
    assert.equal(result.rows[0]?.joinStatus, "joined");
    assert.equal(result.rows[0]?.score, 100);
    const unmatched = result.rows.find((row: { joinStatus: string }) => row.joinStatus === "gsc_only");
    assert.deepEqual(
      { ga4: unmatched?.ga4, score: unmatched?.score, scoreComponents: unmatched?.scoreComponents },
      { ga4: null, score: null, scoreComponents: null },
    );
    assert.equal(result.scoring.businessValueMetric, "sessionKeyEventRate");
    assert.ok(result.warnings.includes("source_time_zones_differ"));
    assert.equal(result.cached, false);
    assert.equal(typeof result.dataAsOf, "string");
  });

  it("uses engagement rate when all joined rows have zero key events", async () => {
    const NOW = Date.parse("2026-08-06T12:00:00.000Z");
    const ga4Calls: Array<{ url: string; body: unknown }> = [];
    const gscCalls: Array<{ siteUrl: string; opts: unknown; deps: unknown }> = [];
    const zeroKey = (landing: string, engagementRate: number) => ({
      host: "example.com",
      landing,
      metrics: [10, 9, 5, engagementRate, 0, 0, 0, 0],
    });
    const result = await getOpportunities(
      seeded(NOW),
      ws,
      {},
      {
        now: () => NOW,
        fetchImpl: ga4Fetch(
          [ga4LandingPayload([zeroKey("/a/", 0.8), zeroKey("/b/", 0.2)])],
          ga4Calls,
        ),
        gscFetch: gscFetchStub(
          {
            rows: [
              { keys: ["https://example.com/a"], clicks: 2, impressions: 300, ctr: 0.01, position: 9 },
              { keys: ["https://example.com/b"], clicks: 1, impressions: 100, ctr: 0.01, position: 10 },
            ],
          },
          gscCalls,
        ),
      },
    );
    assert.deepEqual(result.scoring, {
      formula: "round(100 * (0.5 * demand + 0.3 * businessValue + 0.2 * reachability))",
      businessValueMetric: "engagementRate",
      engagementFallback: true,
      scoreDataLimited: false,
    });
    assert.equal(result.rows[0]?.scoreComponents?.businessValue, 1);
    assert.equal(result.rows[1]?.scoreComponents?.businessValue, 0);
  });

  it("anchors the shared default range to the GA4 property date", async () => {
    const cases = [
      {
        propertyTimeZone: "America/New_York",
        nowMs: Date.parse("2026-08-06T12:00:00.000Z"),
        expected: { startDate: "2026-07-07", endDate: "2026-08-03" },
      },
      {
        propertyTimeZone: "America/Los_Angeles",
        nowMs: Date.parse("2026-08-06T01:00:00.000Z"),
        expected: { startDate: "2026-07-06", endDate: "2026-08-02" },
      },
    ];
    for (const { propertyTimeZone, nowMs, expected } of cases) {
      const ga4Calls: Array<{ url: string; body: unknown }> = [];
      const gscCalls: Array<{ siteUrl: string; opts: unknown; deps: unknown }> = [];
      await getOpportunities(
        seeded(nowMs, { propertyTimeZone }),
        ws,
        {},
        {
          now: () => nowMs,
          fetchImpl: ga4Fetch([ga4LandingPayload([])], ga4Calls),
          gscFetch: gscFetchStub({ rows: [] }, gscCalls),
        },
      );
      assert.deepEqual(
        JSON.parse((gscCalls[0]?.opts as { body: string }).body),
        {
          ...expected,
          dimensions: ["page"],
          rowLimit: 1000,
          startRow: 0,
          type: "web",
          dataState: "final",
        },
      );
      assert.deepEqual((ga4Calls[0]?.body as { dateRanges: unknown }).dateRanges, [expected]);
    }
  });

  it("reads the synthetic gsc-pages.json fixture", async () => {
    const NOW = Date.parse("2026-08-06T12:00:00.000Z");
    const ga4Calls: Array<{ url: string; body: unknown }> = [];
    const gscCalls: Array<{ siteUrl: string; opts: unknown; deps: unknown }> = [];
    const result = await getOpportunities(
      seeded(NOW, { propertyTimeZone: "Asia/Kolkata" }),
      ws,
      {},
      {
        now: () => NOW,
        fetchImpl: ga4Fetch([fixture("run-report-landing-pages.json")], ga4Calls),
        gscFetch: gscFetchStub(fixture("gsc-pages.json"), gscCalls),
      },
    );
    assert.equal(result.coverage.gscRowsConsidered, 6);
    assert.equal(result.totalCandidateRows, 4);
    assert.equal(result.coverage.matchedRows, 1);
    assert.equal(result.rows[0]?.normalizedPage, "example.com/guides/seo");
    assert.equal(result.rows[0]?.joinStatus, "joined");
    assert.equal(result.rows[0]?.score, 100);
    assert.ok(result.rows.slice(1).every((row: { joinStatus: string }) => row.joinStatus === "gsc_only"));
  });

  it("refuses a service-account or disabled Search Console connection before any Google call", async () => {
    for (const gsc of [
      { ...GSC_CONN, auth_mode: "service_account" },
      { ...GSC_CONN, enabled: false },
      null,
    ]) {
      const NOW = Date.parse("2026-08-06T12:00:00.000Z");
      const ga4Calls: Array<{ url: string; body: unknown }> = [];
      const gscCalls: Array<{ siteUrl: string; opts: unknown; deps: unknown }> = [];
      const failure = getOpportunities(
        seeded(NOW, { gsc }),
        ws,
        {},
        {
          now: () => NOW,
          fetchImpl: ga4Fetch([ga4LandingPayload([])], ga4Calls),
          gscFetch: gscFetchStub({ rows: [] }, gscCalls),
        },
      );
      await assert.rejects(
        failure,
        (err: unknown) =>
          err instanceof AppError && err.code === "gsc_not_connected" &&
          err.message === "Connect Search Console to see search opportunities.",
      );
      assert.equal(ga4Calls.length, 0);
      assert.equal(gscCalls.length, 0);
    }
  });

  it("maps Search Console failures to reconnect, quota or unavailable", async () => {
    const cases: Array<{ error: Error; code: string; status: number }> = [
      { error: new Error("GSC access denied for acme: ..."), code: "gsc_reconnect_required", status: 409 },
      { error: new Error("Google authorization was revoked. Please reconnect."), code: "gsc_reconnect_required", status: 409 },
      { error: new Error("No active Google authorization for this workspace."), code: "gsc_reconnect_required", status: 409 },
      { error: new Error("GSC HTTP 429: quota exceeded"), code: "gsc_quota_exhausted", status: 429 },
      { error: new Error("GSC HTTP 500: boom"), code: "gsc_unavailable", status: 503 },
    ];
    for (const { error, code, status } of cases) {
      const NOW = Date.parse("2026-08-06T12:00:00.000Z");
      const failure = getOpportunities(
        seeded(NOW),
        ws,
        {},
        {
          now: () => NOW,
          fetchImpl: ga4Fetch([ga4LandingPayload([])], []),
          gscFetch: gscFetchStub({ rows: [] }, [], error),
        },
      );
      await assert.rejects(
        failure,
        (err: unknown) => err instanceof AppError && err.code === code && err.status === status,
      );
    }
  });

  it("reports truncation on both sources and on the limit", async () => {
    const NOW = Date.parse("2026-08-06T12:00:00.000Z");
    const gscRows = Array.from({ length: 1000 }, (_, i) => ({
      keys: [`https://example.com/p${i}`],
      clicks: 1,
      impressions: i + 1,
      ctr: 0.01,
      position: 4 + (i % 17),
    }));
    const result = await getOpportunities(
      seeded(NOW),
      ws,
      { limit: 1 },
      {
        now: () => NOW,
        fetchImpl: ga4Fetch(
          [
            ga4LandingPayload(
              [
                { host: "example.com", landing: "/p0", metrics: [5, 5, 4, 0.8, 1, 0.2, 0, 0] },
                { host: "example.com", landing: "/p1", metrics: [5, 5, 4, 0.8, 1, 0.2, 0, 0] },
              ],
              { rowCount: 5 },
            ),
          ],
          [],
        ),
        gscFetch: gscFetchStub({ rows: gscRows }, []),
      },
    );
    assert.deepEqual(result.truncated, { gsc: true, ga4: true, candidates: true });
    assert.equal(result.rowCount, 1);
  });

  it("warns only when the property time zone differs from Search Console's", async () => {
    const NOW = Date.parse("2026-08-06T12:00:00.000Z");
    for (const [propertyTimeZone, warned] of [
      ["America/Los_Angeles", false],
      ["Asia/Kolkata", true],
    ] as const) {
      const result = await getOpportunities(
        seeded(NOW, { propertyTimeZone }),
        ws,
        {},
        {
          now: () => NOW,
          fetchImpl: ga4Fetch([ga4LandingPayload([])], []),
          gscFetch: gscFetchStub({ rows: [] }, []),
        },
      );
      assert.equal(result.warnings.includes("source_time_zones_differ"), warned);
    }
  });

  it("refuses invalid limits, half-ranges and reversed dates before any provider call", async () => {
    const NOW = Date.parse("2026-08-06T12:00:00.000Z");
    const badInputs: OpportunitiesInput[] = [
      { limit: 0 },
      { limit: 101 },
      { limit: 1.5 },
      { startDate: "2026-07-01" },
      { startDate: "2026-07-20", endDate: "2026-07-01" },
    ];
    for (const input of badInputs) {
      const ga4Calls: Array<{ url: string; body: unknown }> = [];
      const gscCalls: Array<{ siteUrl: string; opts: unknown; deps: unknown }> = [];
      const failure = getOpportunities(
        seeded(NOW),
        ws,
        input,
        {
          now: () => NOW,
          fetchImpl: ga4Fetch([ga4LandingPayload([])], ga4Calls),
          gscFetch: gscFetchStub({ rows: [] }, gscCalls),
        },
      );
      await assert.rejects(
        failure,
        (err: unknown) => err instanceof Ga4ReportError && err.code === "validation_error",
      );
      assert.equal(ga4Calls.length, 0);
      assert.equal(gscCalls.length, 0);
    }
  });

  it("refuses a missing GA4 connection before any provider call", async () => {
    const NOW = Date.parse("2026-08-06T12:00:00.000Z");
    const ga4Calls: Array<{ url: string; body: unknown }> = [];
    const gscCalls: Array<{ siteUrl: string; opts: unknown; deps: unknown }> = [];
    const admin = adminWithGsc(
      {
        ga4_grants: [grantRow(NOW)],
        ga4_connections: [],
        customer_brand_memberships: [{ brand_key: "acme", user_id: OWNER, role: "owner" }],
      },
      GSC_CONN,
    );
    await assert.rejects(
      getOpportunities(admin, ws, {}, {
        now: () => NOW,
        fetchImpl: ga4Fetch([ga4LandingPayload([])], ga4Calls),
        gscFetch: gscFetchStub({ rows: [] }, gscCalls),
      }),
      (err: unknown) => err instanceof AppError && err.code === "ga4_not_connected",
    );
    assert.equal(ga4Calls.length, 0);
    assert.equal(gscCalls.length, 0);
  });

  it("drops (not set) GA4 landing rows and counts them as unmatched", async () => {
    const NOW = Date.parse("2026-08-06T12:00:00.000Z");
    const result = await getOpportunities(
      seeded(NOW),
      ws,
      {},
      {
        now: () => NOW,
        fetchImpl: ga4Fetch(
          [
            ga4LandingPayload([
              HIGH_VALUE,
              { host: "(not set)", landing: "(not set)", metrics: [7, 7, 6, 0.8, 2, 0.2, 0, 0] },
            ]),
          ],
          [],
        ),
        gscFetch: gscFetchStub({ rows: UPSTREAM_GSC_ROWS }, []),
      },
    );
    assert.equal(result.coverage.matchedRows, 1);
    assert.equal(result.coverage.unmatchedGa4Rows, 1);
  });
});

describe("normalizePageKey", () => {
  it("lowercases the host, keeps non-default ports, strips trailing slashes and drops (not set)", () => {
    assert.equal(normalizePageKey("https://EXAMPLE.com/High-Value/?ref=gsc"), "example.com/High-Value");
    assert.equal(normalizePageKey("https://example.com:443/a"), "example.com/a");
    assert.equal(normalizePageKey("http://example.com:80/a"), "example.com/a");
    assert.equal(normalizePageKey("https://example.com:8443/a"), "example.com:8443/a");
    assert.equal(normalizePageKey("example.com/other/"), "example.com/other");
    assert.equal(normalizePageKey("(not set)"), null);
    assert.equal(normalizePageKey("not a url at all !!!!"), null);
  });
});

describe("percentileRanks", () => {
  it("ranks strictly lower values, with edge cases", () => {
    assert.deepEqual(percentileRanks([]), []);
    assert.deepEqual(percentileRanks([42]), [1]);
    assert.deepEqual(percentileRanks([1, 2, 3]), [0, 0.5, 1]);
    assert.deepEqual(percentileRanks([5, 5, 10]), [0, 0, 1]);
  });
});
