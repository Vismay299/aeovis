/**
 * F19 Phase 2 — customer routes for IndexNow:
 *   GET  /api/customer/indexnow
 *   POST /api/customer/indexnow/setup
 *   POST /api/customer/indexnow/check
 *   POST /api/customer/indexnow/submit
 *   GET  /api/customer/indexnow/submissions
 *
 * Exercises the real route handlers via dependency injection and customer-route hooks.
 */

import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { register } from "node:module";

register(new URL("../customerRoutes.test.hooks.mjs", import.meta.url));

const INDEXNOW_ROUTE = await import(
  new URL("../../app/api/customer/indexnow/route.ts", import.meta.url).href
);
const SETUP_ROUTE = await import(
  new URL("../../app/api/customer/indexnow/setup/route.ts", import.meta.url).href
);
const CHECK_ROUTE = await import(
  new URL("../../app/api/customer/indexnow/check/route.ts", import.meta.url).href
);
const SUBMIT_ROUTE = await import(
  new URL("../../app/api/customer/indexnow/submit/route.ts", import.meta.url).href
);
const SUBMISSIONS_ROUTE = await import(
  new URL("../../app/api/customer/indexnow/submissions/route.ts", import.meta.url).href
);

const USER = { id: "user-1", email: "owner@example.test" };
const BRAND_KEY = "offcult.in";

function brand(role = "member") {
  return {
    brandKey: BRAND_KEY,
    role,
    display_name: "Offcult",
    website: "https://offcult.in",
    website_host: "offcult.in",
    aliases: ["Offcult", "offcult"],
    is_active: true,
  };
}

function baseDeps(over = {}) {
  const role = over.role ?? "member";
  return {
    getCustomerContext: async () => ({
      client: null,
      user: USER,
      brands: [brand(role)],
      error: null,
    }),
    getSupabaseAdmin: () => ({}),
    isFeatureEnabled: async (_name, _brandKey) => true,
    ...over,
  };
}

async function read(response) {
  return {
    status: response.status,
    cacheControl: response.headers.get("cache-control"),
    contentType: response.headers.get("content-type"),
    body: await response.json(),
  };
}

test("flag off -> 404 feature_unavailable across all customer IndexNow routes (F19-AC-14 route half)", async () => {
  const deps = baseDeps({
    isFeatureEnabled: async () => false,
  });

  const getRes = await read(
    await INDEXNOW_ROUTE.GET(
      new Request(`https://app.test/api/customer/indexnow?brand_key=${BRAND_KEY}`),
      {},
      deps
    )
  );
  assert.equal(getRes.status, 404);
  assert.equal(getRes.body.code, "feature_unavailable");

  const setupRes = await read(
    await SETUP_ROUTE.POST(
      new Request("https://app.test/api/customer/indexnow/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brand_key: BRAND_KEY }),
      }),
      {},
      deps
    )
  );
  assert.equal(setupRes.status, 404);
  assert.equal(setupRes.body.code, "feature_unavailable");

  const checkRes = await read(
    await CHECK_ROUTE.POST(
      new Request("https://app.test/api/customer/indexnow/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brand_key: BRAND_KEY }),
      }),
      {},
      deps
    )
  );
  assert.equal(checkRes.status, 404);
  assert.equal(checkRes.body.code, "feature_unavailable");

  const submitRes = await read(
    await SUBMIT_ROUTE.POST(
      new Request("https://app.test/api/customer/indexnow/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brand_key: BRAND_KEY,
          urls: ["https://offcult.in/p1"],
          source: "settings",
          requestId: crypto.randomUUID(),
        }),
      }),
      {},
      deps
    )
  );
  assert.equal(submitRes.status, 404);
  assert.equal(submitRes.body.code, "feature_unavailable");

  const submissionsRes = await read(
    await SUBMISSIONS_ROUTE.GET(
      new Request(`https://app.test/api/customer/indexnow/submissions?brand_key=${BRAND_KEY}`),
      {},
      deps
    )
  );
  assert.equal(submissionsRes.status, 404);
  assert.equal(submissionsRes.body.code, "feature_unavailable");
});

test("POST /api/customer/indexnow/check before setup -> 409 indexnow_not_set_up", async () => {
  const deps = baseDeps({
    checkKeyFiles: async () => {
      const { AppError } = await import("../http/errors.ts");
      throw new AppError(409, "indexnow_not_set_up", "Set up IndexNow first.");
    },
  });

  const res = await read(
    await CHECK_ROUTE.POST(
      new Request("https://app.test/api/customer/indexnow/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ brand_key: BRAND_KEY }),
      }),
      {},
      deps
    )
  );

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "indexnow_not_set_up");
  assert.equal(res.body.error, "Set up IndexNow first.");
});

test("POST /api/customer/indexnow/submit creates the key on first use (keyCreated: true)", async () => {
  let submitCalled = false;
  const deps = baseDeps({
    submitUrls: async (_admin, ws, i) => {
      submitCalled = true;
      assert.equal(ws.brandKey, BRAND_KEY);
      assert.deepEqual(i.urls, ["https://offcult.in/new-page"]);
      assert.equal(i.source, "settings");
      return {
        key: "3f2a9c1e5b7d4f60a8c2e1b3d5f7a9c1",
        keyCreated: true,
        hosts: [
          {
            host: "offcult.in",
            urlCount: 1,
            status: "submitted",
            engine: "bing",
            httpStatus: 202,
            reason: null,
            message:
              "Submitted 1 URL. Search engines will verify the key file on https://offcult.in first.",
          },
        ],
        skipped: [],
      };
    },
  });

  const res = await read(
    await SUBMIT_ROUTE.POST(
      new Request("https://app.test/api/customer/indexnow/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brand_key: BRAND_KEY,
          urls: ["https://offcult.in/new-page"],
          source: "settings",
          requestId: crypto.randomUUID(),
        }),
      }),
      {},
      deps
    )
  );

  assert.equal(res.status, 200);
  assert.equal(submitCalled, true);
  assert.equal(res.body.keyCreated, true);
  assert.equal(res.body.hosts[0].status, "submitted");
});

test("429 rate limit with details.retryAfterSeconds", async () => {
  const deps = baseDeps({
    submitUrls: async () => {
      const { AppError } = await import("../http/errors.ts");
      throw new AppError(
        429,
        "indexnow_rate_limited",
        "You've submitted to IndexNow 30 times in the last hour. Try again in 12 minutes.",
        {
          recovery: "Submit only pages you added or changed.",
          details: { retryAfterSeconds: 720 },
        }
      );
    },
  });

  const res = await read(
    await SUBMIT_ROUTE.POST(
      new Request("https://app.test/api/customer/indexnow/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brand_key: BRAND_KEY,
          urls: ["https://offcult.in/page"],
          source: "settings",
          requestId: crypto.randomUUID(),
        }),
      }),
      {},
      deps
    )
  );

  assert.equal(res.status, 429);
  assert.equal(res.body.code, "indexnow_rate_limited");
  assert.equal(res.body.details?.retryAfterSeconds, 720);
});

test("source: 'tool' from the route -> 400 invalid_request", async () => {
  const deps = baseDeps();

  const res = await read(
    await SUBMIT_ROUTE.POST(
      new Request("https://app.test/api/customer/indexnow/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brand_key: BRAND_KEY,
          urls: ["https://offcult.in/page"],
          source: "tool",
          requestId: crypto.randomUUID(),
        }),
      }),
      {},
      deps
    )
  );

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "invalid_request");
});

test("unknown field -> 400 invalid_request", async () => {
  const deps = baseDeps();

  // POST setup with extra field
  const setupRes = await read(
    await SETUP_ROUTE.POST(
      new Request("https://app.test/api/customer/indexnow/setup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brand_key: BRAND_KEY,
          unexpected_field: "bad",
        }),
      }),
      {},
      deps
    )
  );
  assert.equal(setupRes.status, 400);
  assert.equal(setupRes.body.code, "invalid_request");

  // POST submit with extra field
  const submitRes = await read(
    await SUBMIT_ROUTE.POST(
      new Request("https://app.test/api/customer/indexnow/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brand_key: BRAND_KEY,
          urls: ["https://offcult.in/page"],
          source: "settings",
          requestId: crypto.randomUUID(),
          unknown: true,
        }),
      }),
      {},
      deps
    )
  );
  assert.equal(submitRes.status, 400);
  assert.equal(submitRes.body.code, "invalid_request");

  // GET with extra query param
  const getRes = await read(
    await INDEXNOW_ROUTE.GET(
      new Request(`https://app.test/api/customer/indexnow?brand_key=${BRAND_KEY}&unexpected=1`),
      {},
      deps
    )
  );
  assert.equal(getRes.status, 400);
  assert.equal(getRes.body.code, "invalid_request");
});

test("cross-site POST -> 403 cross_site", async () => {
  const deps = baseDeps();

  const res = await read(
    await SETUP_ROUTE.POST(
      new Request("https://app.test/api/customer/indexnow/setup", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "origin": "https://evil.test",
        },
        body: JSON.stringify({ brand_key: BRAND_KEY }),
      }),
      {},
      deps
    )
  );

  assert.equal(res.status, 403);
  assert.equal(res.body.code, "cross_site");
});

test("GET /api/customer/indexnow success returns setup and usage limits", async () => {
  const deps = baseDeps({
    getSetup: async () => ({
      domain: "offcult.in",
      key: "3f2a9c1e5b7d4f60a8c2e1b3d5f7a9c1",
      hosts: [
        { host: "offcult.in", status: "found" },
        { host: "www.offcult.in", status: "moved" },
      ],
      checkedAt: "2026-10-22T09:00:00.000Z",
      ready: true,
    }),
    fetchIndexNowUsage: async () => ({
      requestsLastHour: 2,
      oldestRequestInHour: "2026-10-22T08:15:00.000Z",
      urlsToday: 14,
      checksLastHour: 4,
      oldestCheckInHour: "2026-10-22T08:10:00.000Z",
    }),
    readIndexNowLimits: () => ({
      maxRequestsPerHour: 30,
      maxUrlsPerDay: 10000,
      maxChecksPerHour: 60,
      resubmitCooldownSeconds: 600,
    }),
  });

  const res = await read(
    await INDEXNOW_ROUTE.GET(
      new Request(`https://app.test/api/customer/indexnow?brand_key=${BRAND_KEY}`),
      {},
      deps
    )
  );

  assert.equal(res.status, 200);
  assert.equal(res.cacheControl, "no-store");
  assert.equal(res.body.domain, "offcult.in");
  assert.equal(res.body.key, "3f2a9c1e5b7d4f60a8c2e1b3d5f7a9c1");
  assert.equal(res.body.ready, true);
  assert.equal(res.body.limits.requestsLastHour, 2);
  assert.equal(res.body.limits.maxRequestsPerHour, 30);
  assert.equal(res.body.limits.urlsToday, 14);
  assert.equal(res.body.limits.maxUrlsPerDay, 10000);
});

test("GET /api/customer/indexnow/submissions returns list", async () => {
  const deps = baseDeps({
    listSubmissions: async () => ({
      submissions: [
        {
          id: "sub-1",
          createdAt: "2026-10-22T09:00:00.000Z",
          source: "settings",
          sourceRef: null,
          host: "offcult.in",
          urlCount: 1,
          urls: ["https://offcult.in/new-page"],
          status: "submitted",
          engine: "bing",
          httpStatus: 202,
          message:
            "Submitted 1 URL. Search engines will verify the key file on https://offcult.in first.",
        },
      ],
    }),
  });

  const res = await read(
    await SUBMISSIONS_ROUTE.GET(
      new Request(`https://app.test/api/customer/indexnow/submissions?brand_key=${BRAND_KEY}`),
      {},
      deps
    )
  );

  assert.equal(res.status, 200);
  assert.equal(res.cacheControl, "no-store");
  assert.equal(res.body.submissions.length, 1);
  assert.equal(res.body.submissions[0].engine, "bing");
});
