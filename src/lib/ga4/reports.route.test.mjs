import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../http/appError.ts";

const overviewRoute = await import(new URL("../../app/api/customer/ga4/overview/route.ts", import.meta.url).href);
const reportsRoute = await import(new URL("../../app/api/customer/ga4/reports/[kind]/route.ts", import.meta.url).href);
const healthRoute = await import(new URL("../../app/api/customer/ga4/health/route.ts", import.meta.url).href);

const OWNER = { id: "11111111-1111-4111-8111-111111111111", email: "owner@example.com" };
const MEMBER = { id: "22222222-2222-4222-8222-222222222222", email: "member@example.com" };

function deps({ user = OWNER, role = "owner", flag = true, ...over } = {}) {
  return {
    getCustomerContext: async () => ({
      user,
      client: null,
      brands: [{ brandKey: "acme", role, display_name: "Acme", website: "https://acme.example", website_host: "acme.example", aliases: [], is_active: true }],
      error: null,
    }),
    getSupabaseAdmin: () => ({}),
    isFeatureEnabled: async () => flag,
    ...over,
  };
}

// Next 15 hands dynamic routes their params as a Promise.
const get = (route, path, d, params) => route.GET(new Request(`https://app.test${path}`), params ? { params: Promise.resolve(params) } : {}, d);

test("flag off answers 404 before any provider call", async () => {
  let calls = 0;
  const d = deps({ flag: false, getOrganicOverview: async () => { calls += 1; return {}; } });
  const res = await get(overviewRoute, "/api/customer/ga4/overview?brand_key=acme", d);
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "feature_unavailable");
  assert.equal(calls, 0);
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("member reads the overview; unknown fields are refused before the provider", async () => {
  let calls = 0;
  const payload = { status: "ok", current: { sessions: 1 } };
  const d = deps({
    user: MEMBER,
    role: "member",
    getOrganicOverview: async () => { calls += 1; return payload; },
  });
  const ok = await get(overviewRoute, "/api/customer/ga4/overview?brand_key=acme", d);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), payload);
  assert.equal(calls, 1);
  assert.equal(ok.headers.get("cache-control"), "no-store");

  const bad = await get(overviewRoute, "/api/customer/ga4/overview?brand_key=acme&bogus=1", d);
  assert.equal(bad.status, 400);
  assert.equal(calls, 1);
});

test("unknown report kind is 404 without a provider call", async () => {
  let calls = 0;
  const d = deps({ runReport: async () => { calls += 1; return {}; } });
  const res = await get(reportsRoute, "/api/customer/ga4/reports/bogus?brand_key=acme", d, { kind: "bogus" });
  assert.equal(res.status, 404);
  assert.equal(calls, 0);
});

test("quota errors carry Retry-After when Google gave one", async () => {
  const quota = new AppError(429, "ga4_quota_exhausted", "Google Analytics' reporting quota for this property is used up.", {
    recovery: "Try again later.",
    details: { retryAfterSeconds: 60 },
  });
  const d = deps({ runReport: async () => { throw quota; } });
  const res = await get(reportsRoute, "/api/customer/ga4/reports/landing_pages?brand_key=acme", d, { kind: "landing_pages" });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.code, "ga4_quota_exhausted");
  assert.deepEqual(body.details, { retryAfterSeconds: 60 });

  const noHint = new AppError(429, "ga4_quota_exhausted", "Google Analytics' reporting quota for this property is used up.", {
    recovery: "Try again later.",
  });
  const res2 = await get(reportsRoute, "/api/customer/ga4/reports/landing_pages?brand_key=acme", deps({ runReport: async () => { throw noHint; } }), { kind: "landing_pages" });
  assert.equal(res2.status, 429);
  assert.equal(res2.headers.get("retry-after"), null);
});

test("not-connected uses the exact §6.5.2 copy and recovery", async () => {
  const notConnected = new AppError(409, "ga4_not_connected", "Google Analytics isn't connected for this workspace.", {
    recovery: "Connect it in Workspace settings.",
  });
  const res = await get(
    overviewRoute,
    "/api/customer/ga4/overview?brand_key=acme",
    deps({ getOrganicOverview: async () => { throw notConnected; } }),
  );
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), {
    error: "Google Analytics isn't connected for this workspace.",
    code: "ga4_not_connected",
    recovery: "Connect it in Workspace settings.",
  });
});

test("health route is flag-gated and no-store", async () => {
  const off = await get(healthRoute, "/api/customer/ga4/health?brand_key=acme", deps({ flag: false, getMeasurementHealth: async () => ({}) }));
  assert.equal(off.status, 404);
  const ok = await get(healthRoute, "/api/customer/ga4/health?brand_key=acme", deps({ getMeasurementHealth: async () => ({ status: "ok" }) }));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
});

test("boolean query flags parse \"false\" as false", async () => {
  let seen = null;
  const d = deps({ runReport: async (_admin, _ws, input) => { seen = input; return { rows: [] }; } });
  const res = await get(reportsRoute, "/api/customer/ga4/reports/landing_pages?brand_key=acme&includeDate=false&comparePreviousPeriod=true", d, { kind: "landing_pages" });
  assert.equal(res.status, 200);
  assert.equal(seen.includeDate, false);
  assert.equal(seen.comparePreviousPeriod, true);
  const bad = await get(reportsRoute, "/api/customer/ga4/reports/landing_pages?brand_key=acme&includeDate=yes", d, { kind: "landing_pages" });
  assert.equal(bad.status, 400);
});

// F20 phase 4 — opportunities route (appended; earlier cases untouched).
const opportunitiesRoute = await import(new URL("../../app/api/customer/ga4/opportunities/route.ts", import.meta.url).href);
const { getOpportunities } = await import(new URL("./opportunities.ts", import.meta.url).href);
const { fakeGa4Admin } = await import(new URL("./fakeAdmin.testkit.ts", import.meta.url).href);
const { encryptToken } = await import(new URL("../gsc/oauthCrypto.js", import.meta.url).href);
const { readFileSync: readF20Fixture } = await import("node:fs");

process.env.GSC_TOKEN_ENCRYPTION_KEY ??= "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const f20Fixture = (name) =>
  JSON.parse(readF20Fixture(new URL(`../../../tests/fixtures/f20/${name}`, import.meta.url), "utf8"));

const OPP_NOW = Date.parse("2026-08-06T12:00:00.000Z");

function oppAdmin() {
  const base = fakeGa4Admin({
    ga4_grants: [
      {
        id: "33333333-3333-4333-8333-333333333333",
        user_id: OWNER.id,
        google_sub: "google-sub-a",
        google_email: "owner@example.com",
        status: "active",
        created_at: "2026-08-01T00:00:00.000Z",
        updated_at: "2026-08-01T00:00:00.000Z",
        access_token_expires_at: new Date(OPP_NOW + 3_600_000).toISOString(),
        encrypted_access_token: JSON.stringify(encryptToken("ga4_tok", `ga4:${OWNER.id}:google-sub-a:access`)),
        encrypted_refresh_token: null,
      },
    ],
    ga4_connections: [
      {
        id: "conn-1",
        brand_key: "acme",
        grant_id: "33333333-3333-4333-8333-333333333333",
        connected_by: OWNER.id,
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
    customer_brand_memberships: [
      { brand_key: "acme", user_id: OWNER.id, role: "owner" },
      { brand_key: "acme", user_id: MEMBER.id, role: "member" },
    ],
  });
  const gscConn = {
    brand_key: "acme",
    enabled: true,
    auth_mode: "oauth",
    site_url: "https://example.com/",
    connection_generation: 7,
  };
  return {
    ...base,
    from: (table) => {
      if (table === "gsc_connections") {
        return { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: gscConn, error: null }) }) }) };
      }
      return base.from(table);
    },
    rpc: base.rpc.bind(base),
  };
}

const getOpp = (path, d) => opportunitiesRoute.GET(new Request(`https://app.test${path}`), {}, d);

test("opportunities happy path is fixture-driven: scored join first, gsc_only last", async () => {
  let ga4Calls = 0;
  let gscCalls = 0;
  const fetchImpl = (async () => {
    ga4Calls += 1;
    return Response.json(f20Fixture("run-report-landing-pages.json"));
  });
  const d = deps({
    getSupabaseAdmin: () => oppAdmin(),
    getOpportunities: (admin, ws, input) =>
      getOpportunities(admin, ws, input, {
        now: () => OPP_NOW,
        fetchImpl,
        gscFetch: (async () => {
          gscCalls += 1;
          return f20Fixture("gsc-pages.json");
        }),
      }),
  });
  const res = await getOpp("/api/customer/ga4/opportunities?brand_key=acme", d);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.cached, false);
  assert.equal(typeof body.dataAsOf, "string");
  assert.equal(body.totalCandidateRows, 4);
  assert.equal(body.coverage.matchedRows, 1);
  assert.equal(body.coverage.unmatchedGscRows, 3);
  assert.equal(body.rows[0].normalizedPage, "example.com/guides/seo");
  assert.equal(body.rows[0].joinStatus, "joined");
  assert.equal(body.rows[0].score, 100);
  assert.ok(body.rows.slice(1).every((row) => row.joinStatus === "gsc_only" && row.score === null));
  assert.deepEqual(body.rows.slice(1).map((row) => row.normalizedPage), [
    "example.com/no-analytics",
    "example.com/High-Value",
    "example.com/other",
  ]);
  assert.deepEqual(body.truncated, { gsc: false, ga4: true, candidates: false });
  assert.deepEqual(body.warnings, ["source_time_zones_differ"]);
  assert.equal(body.request.limit, 50);
  assert.equal(ga4Calls, 1);
  assert.equal(gscCalls, 1);
});

test("opportunities flag-off is 404 and members may read (owner-only not required)", async () => {
  let calls = 0;
  const counting = async () => { calls += 1; return { status: "ok" }; };
  const off = await getOpp("/api/customer/ga4/opportunities?brand_key=acme", deps({ flag: false, getOpportunities: counting }));
  assert.equal(off.status, 404);
  assert.equal((await off.json()).code, "feature_unavailable");
  const asMember = await getOpp(
    "/api/customer/ga4/opportunities?brand_key=acme",
    deps({ user: MEMBER, role: "member", getOpportunities: counting }),
  );
  assert.equal(asMember.status, 200);
  assert.equal(calls, 1);
});

test("opportunities refuses invalid limits, half-ranges, reversed dates and unknown fields before the provider", async () => {
  let calls = 0;
  const counting = async () => { calls += 1; return { status: "ok" }; };
  const badPaths = [
    "/api/customer/ga4/opportunities?brand_key=acme&limit=0",
    "/api/customer/ga4/opportunities?brand_key=acme&limit=101",
    "/api/customer/ga4/opportunities?brand_key=acme&limit=abc",
    "/api/customer/ga4/opportunities?brand_key=acme&startDate=2026-07-01",
    "/api/customer/ga4/opportunities?brand_key=acme&endDate=2026-08-01",
    "/api/customer/ga4/opportunities?brand_key=acme&startDate=2026-08-01&endDate=2026-07-01",
    "/api/customer/ga4/opportunities?brand_key=acme&bogus=1",
  ];
  for (const path of badPaths) {
    const res = await getOpp(path, deps({ getOpportunities: counting }));
    assert.equal(res.status, 400, path);
    assert.equal((await res.json()).code, "invalid_request", path);
  }
  assert.equal(calls, 0);
});

test("opportunities maps ga4/gsc connection errors to the §6.5.2 copy", async () => {
  const ga4Gone = new AppError(409, "ga4_not_connected", "Google Analytics isn't connected for this workspace.", {
    recovery: "Connect it in Workspace settings.",
  });
  const ga4Res = await getOpp(
    "/api/customer/ga4/opportunities?brand_key=acme",
    deps({ getOpportunities: async () => { throw ga4Gone; } }),
  );
  assert.equal(ga4Res.status, 409);
  assert.deepEqual(await ga4Res.json(), {
    error: "Google Analytics isn't connected for this workspace.",
    code: "ga4_not_connected",
    recovery: "Connect it in Workspace settings.",
  });

  const gscGone = new AppError(409, "gsc_not_connected", "Connect Search Console to see search opportunities.");
  const gscRes = await getOpp(
    "/api/customer/ga4/opportunities?brand_key=acme",
    deps({ getOpportunities: async () => { throw gscGone; } }),
  );
  assert.equal(gscRes.status, 409);
  assert.deepEqual(await gscRes.json(), {
    error: "Connect Search Console to see search opportunities.",
    code: "gsc_not_connected",
  });

  const gscLost = new AppError(409, "gsc_reconnect_required", "Search Console access was lost. Reconnect it on the Search Console page.");
  const lostRes = await getOpp(
    "/api/customer/ga4/opportunities?brand_key=acme",
    deps({ getOpportunities: async () => { throw gscLost; } }),
  );
  assert.equal(lostRes.status, 409);
  assert.equal((await lostRes.json()).code, "gsc_reconnect_required");
});

test("opportunities quota errors carry Retry-After when Google gave one", async () => {
  const quota = new AppError(429, "ga4_quota_exhausted", "Google Analytics' reporting quota for this property is used up.", {
    recovery: "Try again later.",
    details: { retryAfterSeconds: 120 },
  });
  const res = await getOpp(
    "/api/customer/ga4/opportunities?brand_key=acme",
    deps({ getOpportunities: async () => { throw quota; } }),
  );
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "120");
  assert.equal(res.headers.get("cache-control"), "no-store");

  const gscQuota = new AppError(429, "gsc_quota_exhausted", "Search Console's quota is used up for now.", {
    recovery: "Try again later.",
  });
  const res2 = await getOpp(
    "/api/customer/ga4/opportunities?brand_key=acme",
    deps({ getOpportunities: async () => { throw gscQuota; } }),
  );
  assert.equal(res2.status, 429);
  assert.equal(res2.headers.get("retry-after"), null);
});

test("opportunities requires a signed-in workspace member before any provider call", async () => {
  let calls = 0;
  const d = deps({
    getCustomerContext: async () => ({ user: null, client: null, brands: [], error: null }),
    getOpportunities: async () => { calls += 1; return { status: "ok" }; },
  });
  const res = await getOpp("/api/customer/ga4/opportunities?brand_key=acme", d);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).code, "unauthenticated");
  assert.equal(calls, 0);
});
