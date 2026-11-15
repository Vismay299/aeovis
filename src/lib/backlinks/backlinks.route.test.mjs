import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";
import { SpendRefused } from "../spend/errors.ts";
import { AppError } from "../http/appError.ts";
import "../pricing/actions/index.ts";

register(new URL("../customerRoutes.test.hooks.mjs", import.meta.url));

const OVERVIEW_ROUTE = await import(
  new URL("../../app/api/customer/backlinks/overview/route.ts", import.meta.url).href
);
const ROWS_ROUTE = await import(
  new URL("../../app/api/customer/backlinks/rows/route.ts", import.meta.url).href
);
const REFERRING_DOMAINS_ROUTE = await import(
  new URL(
    "../../app/api/customer/backlinks/referring-domains/route.ts",
    import.meta.url,
  ).href
);
const TOP_PAGES_ROUTE = await import(
  new URL("../../app/api/customer/backlinks/top-pages/route.ts", import.meta.url).href
);
const SNAPSHOT_TARGETS_ROUTE = await import(
  new URL("../../app/api/customer/backlinks/snapshot-targets/route.ts", import.meta.url).href
);
const SNAPSHOT_TARGET_DELETE_ROUTE = await import(
  new URL("../../app/api/customer/backlinks/snapshot-targets/[targetId]/route.ts", import.meta.url).href
);
const SNAPSHOTS_ROUTE = await import(
  new URL("../../app/api/customer/backlinks/snapshots/route.ts", import.meta.url).href
);

const USER = { id: "user-1", email: "owner@example.test" };
const BRAND_KEY = "offcult.in";

function brand(key = BRAND_KEY, role = "member") {
  return {
    brandKey: key,
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
  const brandKey = over.brandKey ?? BRAND_KEY;
  return {
    getCustomerContext: async () => ({
      client: null,
      user: USER,
      brands: [brand(brandKey, role)],
      error: null,
    }),
    getSupabaseAdmin: () => ({}),
    isFeatureEnabled: async (name, bk) => {
      if (over.flagOn === false) return false;
      return true;
    },
    ...over,
  };
}

function makeRequest(path, body, brandKey = BRAND_KEY) {
  return new Request(`https://perceev.test${path}?brand_key=${brandKey}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("flag off returns 404 feature_unavailable", async () => {
  const req = makeRequest("/api/customer/backlinks/overview", {
    target: "offcult.in",
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await OVERVIEW_ROUTE.POST(req, {}, makeDeps({ flagOn: false }));
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.code, "feature_unavailable");
  assert.equal(data.error, "This page is not available for your workspace yet.");
});

test("unknown field returns 400 invalid_request", async () => {
  const req = makeRequest("/api/customer/backlinks/overview", {
    target: "offcult.in",
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
    unknownField: "not_allowed",
  });
  const res = await OVERVIEW_ROUTE.POST(req, {}, makeDeps());
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "invalid_request");
});

test("cacheOnly miss returns not_cached and makes zero spend calls", async () => {
  let approvedPriceCalled = false;
  const deps = makeDeps({
    requireApprovedPrice: async () => {
      approvedPriceCalled = true;
      return {};
    },
    profileOverview: async () => null,
  });

  const req = makeRequest("/api/customer/backlinks/overview", {
    target: "offcult.in",
    cacheOnly: true,
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await OVERVIEW_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "not_cached");
  assert.equal(data.target, "offcult.in");
  assert.equal(data.displayTarget, "offcult.in");
  assert.equal(approvedPriceCalled, false);
});

test("stale maxUsd returns 409 price_changed", async () => {
  const req = makeRequest("/api/customer/backlinks/overview", {
    target: "offcult.in",
    maxUsd: 0.01,
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await OVERVIEW_ROUTE.POST(req, {}, makeDeps());
  assert.equal(res.status, 409);
  const data = await res.json();
  assert.equal(data.code, "price_changed");
});

test("invalid target returns 400 invalid_target", async () => {
  const req = makeRequest("/api/customer/backlinks/overview", {
    target: "https://example.com?query=1",
    scope: "exact_url",
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await OVERVIEW_ROUTE.POST(req, {}, makeDeps());
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "invalid_target");
});

test("referring domains + subfolder returns 400 subfolder_not_supported", async () => {
  const req = makeRequest("/api/customer/backlinks/referring-domains", {
    target: "example.com/blog",
    scope: "subfolder",
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await REFERRING_DOMAINS_ROUTE.POST(req, {}, makeDeps());
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "subfolder_not_supported");
  assert.equal(
    data.error,
    "Referring domains can't be broken down for a subfolder — use the Backlinks tab, or switch to Domain or Subdomains scope.",
  );
});

test("spend refusal passes through as 403 feature_disabled", async () => {
  const deps = makeDeps({
    requireApprovedPrice: async () => {
      throw new SpendRefused("feature_disabled");
    },
  });

  const req = makeRequest("/api/customer/backlinks/overview", {
    target: "offcult.in",
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await OVERVIEW_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 403);
  const data = await res.json();
  assert.equal(data.code, "feature_disabled");
});

import { createMemoryCacheStore } from "../cache/memoryStore.ts";

test("tenant isolation of cache (workspace B gets cached: false)", async () => {
  const store = createMemoryCacheStore();
  const cacheDeps = { store };

  let summaryCalls = 0;
  const fakeClient = {
    summary: async () => {
      summaryCalls++;
      return {
        data: {
          target: "example.com",
          total_count: 50,
          rank: 20,
          backlinks: 100,
          broken_backlinks: 0,
          broken_pages: 0,
          referring_domains: 10,
          referring_main_domains: 8,
          referring_pages: 20,
        },
      };
    },
    history: async () => ({ data: [] }),
    rows: async () => ({ data: { items: [], totalCount: 0 } }),
    referringDomains: async () => ({ data: { items: [], totalCount: 0 } }),
    domainPages: async () => ({ data: { items: [], totalCount: 0 } }),
  };

  const serviceDeps = {
    cacheDeps,
    cacheOnly: false,
  };

  const depsA = makeDeps({
    brandKey: "brand-a",
    createBacklinksClient: () => fakeClient,
    serviceDeps,
    requireApprovedPrice: async () => ({}),
    declaredCompetitors: async () => [],
    appendResearch: async () => {},
  });

  const depsB = makeDeps({
    brandKey: "brand-b",
    createBacklinksClient: () => fakeClient,
    serviceDeps,
    requireApprovedPrice: async () => ({}),
    declaredCompetitors: async () => [],
    appendResearch: async () => {},
  });

  // Call 1 from workspace A: cache miss, cached: false
  const reqA1 = makeRequest(
    "/api/customer/backlinks/overview",
    {
      target: "example.com",
      requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
    },
    "brand-a",
  );
  const resA1 = await OVERVIEW_ROUTE.POST(reqA1, {}, depsA);
  assert.equal(resA1.status, 200);
  const dataA1 = await resA1.json();
  assert.equal(dataA1.status, "ok");
  assert.equal(dataA1.cached, false);
  assert.equal(summaryCalls, 1);

  // Call 2 from workspace A: cache hit, cached: true
  const reqA2 = makeRequest(
    "/api/customer/backlinks/overview",
    {
      target: "example.com",
      requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf502",
    },
    "brand-a",
  );
  const resA2 = await OVERVIEW_ROUTE.POST(reqA2, {}, depsA);
  assert.equal(resA2.status, 200);
  const dataA2 = await resA2.json();
  assert.equal(dataA2.status, "ok");
  assert.equal(dataA2.cached, true);
  assert.equal(summaryCalls, 1);

  // Call 3 from workspace B: cache miss for workspace B, cached: false
  const reqB1 = makeRequest(
    "/api/customer/backlinks/overview",
    {
      target: "example.com",
      requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf503",
    },
    "brand-b",
  );
  const resB1 = await OVERVIEW_ROUTE.POST(reqB1, {}, depsB);
  assert.equal(resB1.status, 200);
  const dataB1 = await resB1.json();
  assert.equal(dataB1.status, "ok");
  assert.equal(dataB1.cached, false);
  assert.equal(summaryCalls, 2);
});

test("rows route returns paged backlink rows", async () => {
  const deps = makeDeps({
    requireApprovedPrice: async () => ({}),
    profileBacklinksPage: async () => ({
      rows: [
        {
          domainFrom: "source.example",
          urlFrom: "https://source.example/page",
          urlTo: "https://example.com/target",
          anchor: "anchor text",
          itemType: "anchor",
          isDofollow: true,
          relAttributes: null,
          rank: 45,
          domainFromRank: 50,
          pageFromRank: 40,
          spamScore: 15,
          firstSeen: "2026-01-01T00:00:00Z",
          lastSeen: "2026-02-01T00:00:00Z",
          isLost: false,
          isBroken: false,
          linksCount: 1,
        },
      ],
      totalCount: 1,
      hasMore: false,
      page: 1,
      pageSize: 50,
      cached: false,
      fetchedAt: "2026-10-21T09:30:00.000Z",
      provenance: { gateway: "dataforseo" },
    }),
  });

  const req = makeRequest("/api/customer/backlinks/rows", {
    target: "offcult.in",
    page: 1,
    pageSize: 50,
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await ROWS_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "ok");
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].domainFrom, "source.example");
});

test("referring-domains route returns domain breakdown", async () => {
  const deps = makeDeps({
    requireApprovedPrice: async () => ({}),
    profileReferringDomainsPage: async () => ({
      rows: [
        {
          domain: "source.example",
          backlinks: 10,
          referringPages: 5,
          rank: 45,
          spamScore: 12,
          firstSeen: "2026-01-01T00:00:00Z",
          brokenBacklinks: 0,
          brokenPages: 0,
        },
      ],
      totalCount: 1,
      hasMore: false,
      page: 1,
      pageSize: 50,
      cached: false,
      fetchedAt: "2026-10-21T09:30:00.000Z",
      provenance: { gateway: "dataforseo" },
    }),
  });

  const req = makeRequest("/api/customer/backlinks/referring-domains", {
    target: "offcult.in",
    page: 1,
    pageSize: 50,
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await REFERRING_DOMAINS_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "ok");
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].domain, "source.example");
});

test("top-pages route returns pages breakdown", async () => {
  const deps = makeDeps({
    requireApprovedPrice: async () => ({}),
    profileTopPagesPage: async () => ({
      rows: [
        {
          page: "https://example.com/about",
          backlinks: 50,
          referringDomains: 12,
          rank: 35,
          brokenBacklinks: 0,
        },
      ],
      totalCount: 1,
      hasMore: false,
      page: 1,
      pageSize: 50,
      cached: false,
      fetchedAt: "2026-10-21T09:30:00.000Z",
      provenance: { gateway: "dataforseo" },
    }),
  });

  const req = makeRequest("/api/customer/backlinks/top-pages", {
    target: "offcult.in",
    page: 1,
    pageSize: 50,
    requestId: "b7e4f9b8-3f51-40be-a237-7729f64bf501",
  });
  const res = await TOP_PAGES_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, "ok");
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].page, "https://example.com/about");
});

const AHREFS_DR_ROUTE = await import(
  new URL("../../app/api/customer/backlinks/ahrefs-dr/route.ts", import.meta.url).href
);

function ahrefsFetch(dr) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({ domain_rating: { domain_rating: dr } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { calls, fetchImpl };
}

test("ahrefs-dr flag off returns 404 feature_unavailable with zero provider calls", async () => {
  const store = createMemoryCacheStore();
  const { calls, fetchImpl } = ahrefsFetch(61);
  const deps = makeDeps({
    flagOn: false,
    serviceDeps: { fetch: fetchImpl, cacheDeps: { store } },
  });

  const req = makeRequest("/api/customer/backlinks/ahrefs-dr", {
    domains: ["bewakoof.com"],
  });
  const res = await AHREFS_DR_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 404);
  const data = await res.json();
  assert.equal(data.code, "feature_unavailable");
  assert.equal(data.error, "This page is not available for your workspace yet.");
  assert.equal(calls.length, 0);
});

test("ahrefs-dr 101 domains returns 400 with zero provider calls", async () => {
  const store = createMemoryCacheStore();
  const { calls, fetchImpl } = ahrefsFetch(61);
  const deps = makeDeps({
    serviceDeps: { fetch: fetchImpl, cacheDeps: { store } },
  });

  const domains = Array.from({ length: 101 }, (_, i) => `site-${i + 1}.com`);
  const req = makeRequest("/api/customer/backlinks/ahrefs-dr", { domains });
  const res = await AHREFS_DR_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "invalid_request");
  assert.equal(calls.length, 0);
});

test("ahrefs-dr unknown field returns 400 invalid_request", async () => {
  const req = makeRequest("/api/customer/backlinks/ahrefs-dr", {
    domains: ["bewakoof.com"],
    unknownField: "not_allowed",
  });
  const res = await AHREFS_DR_ROUTE.POST(req, {}, makeDeps());
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.code, "invalid_request");
});

test("ahrefs-dr success returns ratings keyed by raw inputs", async () => {
  const store = createMemoryCacheStore();
  const { calls, fetchImpl } = ahrefsFetch(61);
  const deps = makeDeps({
    serviceDeps: { fetch: fetchImpl, cacheDeps: { store } },
  });

  const req = makeRequest("/api/customer/backlinks/ahrefs-dr", {
    domains: ["www.bewakoof.com", "https://bewakoof.com"],
  });
  const res = await AHREFS_DR_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const data = await res.json();
  assert.deepEqual(data, {
    ratings: { "www.bewakoof.com": 61, "https://bewakoof.com": 61 },
  });
  assert.equal(calls.length, 1);
  assert.ok(
    calls[0].startsWith(
      "https://api.ahrefs.com/v3/public/domain-rating-free?target=",
    ),
  );
});

test("ahrefs-dr single-domain failure returns a null entry with 200", async () => {
  const store = createMemoryCacheStore();
  const failingFetch = async () => new Response("boom", { status: 500 });
  const deps = makeDeps({
    serviceDeps: { fetch: failingFetch, cacheDeps: { store } },
  });

  const req = makeRequest("/api/customer/backlinks/ahrefs-dr", {
    domains: ["bewakoof.com"],
  });
  const res = await AHREFS_DR_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.deepEqual(data, { ratings: { "bewakoof.com": null } });
});

test("ahrefs-dr cache is global: workspace B shares workspace A's entry", async () => {
  const store = createMemoryCacheStore();
  const { calls, fetchImpl } = ahrefsFetch(61);
  const sharedServiceDeps = { fetch: fetchImpl, cacheDeps: { store } };

  const depsA = makeDeps({
    brandKey: "brand-a",
    serviceDeps: sharedServiceDeps,
  });
  const reqA = makeRequest(
    "/api/customer/backlinks/ahrefs-dr",
    { domains: ["bewakoof.com"] },
    "brand-a",
  );
  const resA = await AHREFS_DR_ROUTE.POST(reqA, {}, depsA);
  assert.equal(resA.status, 200);
  assert.deepEqual(await resA.json(), { ratings: { "bewakoof.com": 61 } });
  assert.equal(calls.length, 1);

  const depsB = makeDeps({
    brandKey: "brand-b",
    serviceDeps: sharedServiceDeps,
  });
  const reqB = makeRequest(
    "/api/customer/backlinks/ahrefs-dr",
    { domains: ["bewakoof.com"] },
    "brand-b",
  );
  const resB = await AHREFS_DR_ROUTE.POST(reqB, {}, depsB);
  assert.equal(resB.status, 200);
  assert.deepEqual(await resB.json(), { ratings: { "bewakoof.com": 61 } });
  assert.equal(calls.length, 1);

  const reqB2 = makeRequest(
    "/api/customer/backlinks/ahrefs-dr",
    { domains: ["other-example.com"] },
    "brand-b",
  );
  const resB2 = await AHREFS_DR_ROUTE.POST(reqB2, {}, depsB);
  assert.equal(resB2.status, 200);
  assert.deepEqual(await resB2.json(), { ratings: { "other-example.com": 61 } });
  assert.equal(calls.length, 2);
});

test("snapshot target create requires owner before price approval", async () => {
  let approvalChecked = false;
  const deps = makeDeps({
    role: "member",
    requireApprovedPrice: async () => { approvalChecked = true; throw new Error("unexpected"); },
  });
  const req = makeRequest("/api/customer/backlinks/snapshot-targets", {
    target: "offcult.in", scope: "subdomains", interval: "weekly", maxUsd: 1,
  });
  const res = await SNAPSHOT_TARGETS_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, "owner_required");
  assert.equal(approvalChecked, false);
});

test("snapshot target create without maxUsd returns approval_required before any paid work", async () => {
  let approvalRecorded = false;
  let targetCreated = false;
  const deps = makeDeps({
    role: "owner",
    recordApproval: async () => { approvalRecorded = true; return "approval-id"; },
    createSnapshotTarget: async () => { targetCreated = true; throw new Error("unexpected"); },
  });
  const req = makeRequest("/api/customer/backlinks/snapshot-targets", {
    target: "offcult.in", scope: "subdomains", interval: "weekly",
  });
  const res = await SNAPSHOT_TARGETS_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 400);
  assert.equal((await res.json()).code, "approval_required");
  assert.equal(approvalRecorded, false);
  assert.equal(targetCreated, false);
});

test("snapshot target create requires approval before creating a target", async () => {
  let order = [];
  const deps = makeDeps({
    role: "owner",
    requireApprovedPrice: async (_action, _ctx, input, maxUsd) => {
      assert.equal(input.interval, "weekly");
      assert.equal(maxUsd, 0.5);
      order.push("price");
      return { quote: { totalUsd: 0.024036 }, approvedMaxUsd: 0.5 };
    },
    recordApproval: async (_admin, input) => {
      assert.equal(input.source, "schedule");
      assert.equal(input.subject.kind, "backlink_snapshot_target");
      order.push("approval");
      return "approval-id";
    },
    randomUUID: () => "target-id",
    computeNextRunAt: () => "2026-11-22T00:00:00.000Z",
    createSnapshotTarget: async (_admin, input) => {
      order.push("insert");
      assert.equal(input.id, "target-id");
      assert.equal(input.approvalId, "approval-id");
      return {
        id: input.id, target: input.target, scope: input.scope, label: input.label ?? null,
        schedule_interval: input.interval, enabled: true, next_run_at: input.nextRunAt,
        last_run_at: null, last_skip_reason: null,
      };
    },
  });
  const req = makeRequest("/api/customer/backlinks/snapshot-targets", {
    target: "offcult.in", scope: "subdomains", interval: "weekly", maxUsd: 0.5,
  });
  const res = await SNAPSHOT_TARGETS_ROUTE.POST(req, {}, deps);
  assert.equal(res.status, 201);
  assert.deepEqual(order, ["price", "approval", "insert"]);
  assert.equal((await res.json()).target.interval, "weekly");
});

test("duplicate tracked target returns 409 already_tracked", async () => {
  let targetCreateReached = false;
  const deps = makeDeps({
    role: "owner",
    requireApprovedPrice: async () => ({ quote: { totalUsd: 0.024036 }, approvedMaxUsd: 0.5 }),
    recordApproval: async () => "approval-id",
    createSnapshotTarget: async () => {
      targetCreateReached = true;
      throw new AppError(409, "already_tracked", "This site's history is already tracked.");
    },
  });
  const req = makeRequest("/api/customer/backlinks/snapshot-targets", {
    target: "offcult.in", scope: "subdomains", interval: "weekly", maxUsd: 0.5,
  });
  const res = await SNAPSHOT_TARGETS_ROUTE.POST(req, {}, deps);
  assert.equal(targetCreateReached, true);
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "already_tracked");
});

test("snapshot feature off returns 404 before target-list storage is read", async () => {
  let listCalled = false;
  const deps = makeDeps({ flagOn: false, listSnapshotTargets: async () => { listCalled = true; return []; } });
  const res = await SNAPSHOT_TARGETS_ROUTE.GET(
    new Request("https://perceev.test/api/customer/backlinks/snapshot-targets?brand_key=offcult.in"),
    {}, deps,
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "feature_unavailable");
  assert.equal(listCalled, false);
});

test("snapshot history query cannot select another workspace", async () => {
  let listCalled = false;
  const deps = makeDeps({ listSnapshots: async () => { listCalled = true; return []; } });
  const res = await SNAPSHOTS_ROUTE.GET(
    new Request("https://perceev.test/api/customer/backlinks/snapshots?brand_key=workspace-b&target=same.example&scope=domain"),
    {}, deps,
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).code, "workspace_not_found");
  assert.equal(listCalled, false);
});

test("snapshot target deletion binds the target id to the authenticated workspace", async () => {
  let deletedFor = null;
  const deps = makeDeps({
    role: "owner",
    deleteSnapshotTarget: async (_admin, brandKey, targetId) => { deletedFor = { brandKey, targetId }; },
  });
  const res = await SNAPSHOT_TARGET_DELETE_ROUTE.DELETE(
    new Request("https://perceev.test/api/customer/backlinks/snapshot-targets/target-b?brand_key=offcult.in", { method: "DELETE" }),
    { params: Promise.resolve({ targetId: "target-b" }) }, deps,
  );
  assert.equal(res.status, 200);
  assert.deepEqual(deletedFor, { brandKey: BRAND_KEY, targetId: "target-b" });
});
