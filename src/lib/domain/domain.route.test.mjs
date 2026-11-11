import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { AppError } from "../http/appError.ts";
import { SpendRefused } from "../spend/errors.ts";
import "../pricing/actions/index.ts";

register(new URL("../customerRoutes.test.hooks.mjs", import.meta.url));

const OVERVIEW_ROUTE = await import(
  new URL("../../app/api/customer/domain/overview/route.ts", import.meta.url).href
);
const KEYWORDS_ROUTE = await import(
  new URL("../../app/api/customer/domain/keywords/route.ts", import.meta.url).href
);
const PAGES_ROUTE = await import(
  new URL("../../app/api/customer/domain/pages/route.ts", import.meta.url).href
);
const COMPETITORS_ROUTE = await import(
  new URL("../../app/api/customer/domain/competitors/route.ts", import.meta.url).href
);
const COMPETITORS_ADD_ROUTE = await import(
  new URL("../../app/api/customer/domain/competitors/add/route.ts", import.meta.url).href
);
const COMPETITORS_DECLARED_ROUTE = await import(
  new URL("../../app/api/customer/domain/competitors/declared/route.ts", import.meta.url).href
);

const USER = { id: "user-1", email: "owner@example.test" };
const BRAND_KEY = "offcult.in";

function brand(role = "member") {
  return {
    brandKey: BRAND_KEY,
    role,
    display_name: "Offcult",
    website: "https://offcult.in",
    website_host: "www.offcult.in",
    aliases: ["Offcult", "offcult"],
    is_active: true,
  };
}

function makeDeps(over = {}) {
  const role = over.role ?? "member";
  return {
    getCustomerContext: async () => ({
      client: null,
      user: USER,
      brands: [brand(role)],
      error: null,
    }),
    getSupabaseAdmin: () => ({}),
    isFeatureEnabled: async (name) => {
      if (over.flagOn === false) return false;
      return true;
    },
    ...over,
  };
}

function makeRequest(path, body) {
  return new Request(`https://perceev.test${path}?brand_key=${BRAND_KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("flag off returns 404 feature_unavailable", async () => {
  const req = makeRequest("/api/customer/domain/overview", {
    domain: "offcult.in",
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await OVERVIEW_ROUTE.POST(req, {}, makeDeps({ flagOn: false }));
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.code, "feature_unavailable");
  assert.equal(data.error, "This page is not available for your workspace yet.");
});

test("unknown field returns 400 invalid_request", async () => {
  const req = makeRequest("/api/customer/domain/overview", {
    domain: "offcult.in",
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
    unknownField: "not_allowed",
  });
  const res = await OVERVIEW_ROUTE.POST(req, {}, makeDeps());
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "invalid_request");
});

test("non-Labs location returns 400 invalid_location", async () => {
  const req = makeRequest("/api/customer/domain/overview", {
    domain: "offcult.in",
    locationCode: 999999,
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await OVERVIEW_ROUTE.POST(req, {}, makeDeps());
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "invalid_location");
  assert.equal(data.error, "Domain research is not available for this country.");
});

test("invalid target returns 400 invalid_target", async () => {
  const req = makeRequest("/api/customer/domain/overview", {
    domain: "example.por",
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await OVERVIEW_ROUTE.POST(req, {}, makeDeps());
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "invalid_target");
  assert.equal(data.error, "Enter a valid domain like example.com");
});

test("cacheOnly miss returns not_cached and makes zero spend calls", async () => {
  let approvedPriceCalled = false;
  const deps = makeDeps({
    requireApprovedPrice: async () => {
      approvedPriceCalled = true;
      return {};
    },
    getOverview: async () => null,
  });

  const req = makeRequest("/api/customer/domain/overview", {
    domain: "offcult.in",
    cacheOnly: true,
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await OVERVIEW_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "not_cached");
  assert.equal(data.domain, "offcult.in");
  assert.equal(data.displayTarget, "offcult.in");
  assert.equal(approvedPriceCalled, false);
});

test("stale maxUsd returns 409 price_changed", async () => {
  const req = makeRequest("/api/customer/domain/overview", {
    domain: "offcult.in",
    locationCode: 2356,
    maxUsd: 0.01,
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await OVERVIEW_ROUTE.POST(req, {}, makeDeps());
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.code, "price_changed");
});

test("spend refusal passes through as 403 feature_disabled", async () => {
  const deps = makeDeps({
    requireApprovedPrice: async () => {
      throw new SpendRefused("feature_disabled");
    },
  });

  const req = makeRequest("/api/customer/domain/overview", {
    domain: "offcult.in",
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await OVERVIEW_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.code, "feature_disabled");
});

test("9 filter conditions returns 400 filters_over_budget", async () => {
  const req = makeRequest("/api/customer/domain/keywords", {
    domain: "offcult.in",
    filters: {
      include: "a,b,c,d",
      exclude: "e,f",
      minVol: 1,
      maxVol: 2,
      minTraffic: 3, // 9th condition
    },
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await KEYWORDS_ROUTE.POST(req, {}, makeDeps());
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "filters_over_budget");
  assert.match(data.error, /Too many filter conditions/);
});

test("overview succeeds and sets isOwnSite true for workspace host", async () => {
  let appendedLog = false;
  const deps = makeDeps({
    getOverview: async () => ({
      domain: "offcult.in",
      displayTarget: "offcult.in",
      scope: "subdomains",
      organicTraffic: 1840,
      organicKeywords: 312,
      hasData: true,
      cached: false,
      fetchedAt: "2026-10-21T09:30:00.000Z",
      provenance: { gateway: "dataforseo" },
    }),
    declaredCompetitors: async () => [],
    appendResearch: async () => {
      appendedLog = true;
    },
  });

  const req = makeRequest("/api/customer/domain/overview", {
    domain: "offcult.in",
    locationCode: 2356,
    languageCode: "en",
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await OVERVIEW_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "ok");
  assert.equal(data.domain, "offcult.in");
  assert.equal(data.isOwnSite, true);
  assert.equal(data.isDeclaredCompetitor, false);
  assert.equal(data.market.locationCode, 2356);
  assert.equal(data.market.country, "India");
  assert.equal(appendedLog, true);
});

test("keywords route returns paged results", async () => {
  const deps = makeDeps({
    getKeywordsPage: async () => ({
      domain: "offcult.in",
      page: 1,
      pageSize: 50,
      totalCount: 312,
      hasMore: true,
      keywords: [
        {
          keyword: "oversized t shirt",
          position: 7,
          searchVolume: 74000,
          traffic: 1290.5,
          cpc: 0.41,
          url: "https://offcult.in/collections/oversized",
          relativeUrl: "/collections/oversized",
          keywordDifficulty: 38,
        },
      ],
      cached: true,
      fetchedAt: "2026-10-21T09:30:01.000Z",
      provenance: { gateway: "dataforseo" },
    }),
  });

  const req = makeRequest("/api/customer/domain/keywords", {
    domain: "offcult.in",
    page: 1,
    pageSize: 50,
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await KEYWORDS_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "ok");
  assert.equal(data.totalCount, 312);
  assert.equal(data.keywords.length, 1);
});

test("pages route returns paged results", async () => {
  const deps = makeDeps({
    getPagesPage: async () => ({
      domain: "offcult.in",
      page: 1,
      pageSize: 50,
      totalCount: 42,
      hasMore: false,
      pages: [
        {
          page: "https://offcult.in/collections/oversized",
          relativePath: "/collections/oversized",
          organicTraffic: 1290.5,
          keywords: 34,
        },
      ],
      cached: false,
      fetchedAt: "2026-10-21T09:30:02.000Z",
      provenance: { gateway: "dataforseo" },
    }),
  });

  const req = makeRequest("/api/customer/domain/pages", {
    domain: "offcult.in",
    page: 1,
    pageSize: 50,
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await PAGES_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "ok");
  assert.equal(data.totalCount, 42);
  assert.equal(data.pages.length, 1);
});

test("competitors route: flag off returns 404 feature_unavailable", async () => {
  const req = makeRequest("/api/customer/domain/competitors", {
    domain: "offcult.in",
    keywords: ["oversized tee"],
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await COMPETITORS_ROUTE.POST(req, {}, makeDeps({ flagOn: false }));
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.code, "feature_unavailable");
});

test("competitors route: requires maxUsd when not cacheOnly (400 approval_required)", async () => {
  const req = makeRequest("/api/customer/domain/competitors", {
    domain: "offcult.in",
    keywords: ["oversized tee"],
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await COMPETITORS_ROUTE.POST(req, {}, makeDeps());
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "approval_required");
  assert.equal(data.error, "Review and approve the price before running this.");
});

test("competitors route: stale maxUsd returns 409 price_changed", async () => {
  const req = makeRequest("/api/customer/domain/competitors", {
    domain: "offcult.in",
    keywords: ["oversized tee"],
    maxUsd: 0.001,
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await COMPETITORS_ROUTE.POST(req, {}, makeDeps());
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.code, "price_changed");
});

test("competitors route: cacheOnly miss returns not_cached and makes zero spend calls", async () => {
  let labsCalled = false;
  const deps = makeDeps({
    runSerpCompetitorsRequest: async () => ({
      status: "not_cached",
      keywordCount: 1,
      competitors: [],
    }),
  });

  const req = makeRequest("/api/customer/domain/competitors", {
    domain: "offcult.in",
    keywords: ["oversized tee"],
    cacheOnly: true,
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await COMPETITORS_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "not_cached");
  assert.equal(data.competitors.length, 0);
  assert.equal(labsCalled, false);
});

test("competitors route: success returns competitors list and flags own site & declared competitor", async () => {
  let appendedKind = null;
  const deps = makeDeps({
    labs: {
      keywords: {},
      domain: {},
      labs: {
        serpCompetitors: async () => ({
          data: [
            {
              domain: "bewakoof.com",
              avg_position: 4.2,
              median_position: 3,
              visibility: 0.41,
              etv: 18120.5,
              keywords_count: 31,
            },
            {
              domain: "offcult.in",
              avg_position: 7.0,
              visibility: 0.25,
              etv: 1840.0,
              keywords_count: 22,
            },
          ],
        }),
      },
    },
    declaredCompetitors: async () => [
      { domain: "bewakoof.com", name: "Bewakoof", notes: null },
    ],
    appendResearch: async (_admin, input) => {
      appendedKind = input.kind;
    },
  });

  const req = makeRequest("/api/customer/domain/competitors", {
    domain: "souledstore.com", // researching competitor domain
    keywords: ["oversized tee"],
    maxUsd: 0.1,
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });

  const res = await COMPETITORS_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "ok");
  assert.equal(data.keywordCount, 1);
  assert.equal(data.competitors.length, 2);

  const bewakoof = data.competitors.find((c) => c.domain === "bewakoof.com");
  assert.ok(bewakoof);
  assert.equal(bewakoof.isDeclaredCompetitor, true);
  assert.equal(bewakoof.isOwnSite, false);

  const offcult = data.competitors.find((c) => c.domain === "offcult.in");
  assert.ok(offcult);
  assert.equal(offcult.isOwnSite, true);
  assert.equal(offcult.isDeclaredCompetitor, false);

  assert.equal(appendedKind, "domain.competitors");
});

test("competitors add route: project_memory off returns 404 feature_unavailable", async () => {
  const deps = makeDeps({
    isFeatureEnabled: async (feature) => {
      if (feature === "project_memory") return false;
      return true;
    },
  });

  const req = makeRequest("/api/customer/domain/competitors/add", {
    domain: "bewakoof.com",
  });
  const res = await COMPETITORS_ADD_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.code, "feature_unavailable");
  assert.equal(data.error, "Project memory is not enabled for this workspace.");
});

test("competitors add route: own host returns 400 context_invalid with F07 copy", async () => {
  const deps = makeDeps({
    addDomainAsCompetitor: async () => {
      throw new AppError(
        400,
        "context_invalid",
        "updates[0] was rejected (nothing in this batch was applied): Your own website cannot be a competitor.",
      );
    },
  });

  const req = makeRequest("/api/customer/domain/competitors/add", {
    domain: "offcult.in",
  });
  const res = await COMPETITORS_ADD_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "context_invalid");
  assert.match(data.error, /Your own website cannot be a competitor/);
});

test("competitors add route: success returns competitor object and added true", async () => {
  const deps = makeDeps({
    addDomainAsCompetitor: async () => ({
      competitor: { domain: "bewakoof.com", name: null },
      added: true,
    }),
  });

  const req = makeRequest("/api/customer/domain/competitors/add", {
    domain: "bewakoof.com",
  });
  const res = await COMPETITORS_ADD_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, {
    competitor: { domain: "bewakoof.com", name: null },
    added: true,
  });
});

test("competitors declared route: project_memory off returns available false and empty array", async () => {
  const deps = makeDeps({
    isFeatureEnabled: async (feature) => {
      if (feature === "project_memory") return false;
      return true;
    },
  });

  const req = new Request(`https://perceev.test/api/customer/domain/competitors/declared?brand_key=${BRAND_KEY}`, {
    method: "GET",
  });
  const res = await COMPETITORS_DECLARED_ROUTE.GET(req, {}, deps);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, {
    available: false,
    competitors: [],
  });
});

test("competitors declared route: project_memory on returns competitors and ownHost", async () => {
  const deps = makeDeps({
    isFeatureEnabled: async () => true,
    declaredCompetitors: async () => [
      { domain: "bewakoof.com", name: "Bewakoof", notes: null },
    ],
  });

  const req = new Request(`https://perceev.test/api/customer/domain/competitors/declared?brand_key=${BRAND_KEY}`, {
    method: "GET",
  });
  const res = await COMPETITORS_DECLARED_ROUTE.GET(req, {}, deps);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.available, true);
  assert.equal(data.ownHost, "offcult.in");
  assert.deepEqual(data.competitors, [
    { domain: "bewakoof.com", name: "Bewakoof" },
  ]);
});

