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

const get = (route, path, d, params) => route.GET(new Request(`https://app.test${path}`), params ? { params } : {}, d);

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
