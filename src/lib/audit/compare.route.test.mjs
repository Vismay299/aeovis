import test from "node:test";
import assert from "node:assert/strict";
import { GET } from "../../app/api/customer/audit/compare/route.ts";

const workspace = { user: { id: "user-a", email: "owner@example.test" }, brandKey: "brand-a", role: "owner", brand: {}, admin: null };
const baseId = "6f1d2c3b-0a4e-4b8f-9c1d-2e3f4a5b6c7d";
const headId = "11111111-2222-4333-8555-666666666666";
const foreignId = "22222222-3333-4444-8555-666666666666";

function audit(id, overrides = {}) {
  return {
    id,
    brand_key: "brand-a",
    start_host: "example.test",
    status: "completed",
    created_at: "2026-11-01T00:00:00.000Z",
    pages_crawled: 10,
    max_pages: 50,
    crawl_completed: true,
    ...overrides,
  };
}

function memoryAdmin(audits, rows = []) {
  const calls = { rpc: [] };
  return {
    calls,
    from(table) {
      assert.equal(table, "site_audits");
      const filters = [];
      const query = {
        select() { return this; },
        eq(field, value) { filters.push((row) => row[field] === value); return this; },
        async maybeSingle() {
          const matches = audits.filter((row) => filters.every((filter) => filter(row)));
          assert.ok(matches.length <= 1, "audit lookup should be unique");
          return { data: matches[0] ?? null, error: null };
        },
      };
      return query;
    },
    async rpc(name, args) {
      calls.rpc.push({ name, args });
      assert.equal(name, "site_audit_compare");
      return { data: rows, error: null };
    },
  };
}

function request(query = `base=${baseId}&head=${headId}`) {
  return new Request(`https://app.example/api/customer/audit/compare?${query}`);
}

function deps(admin, overrides = {}) {
  return {
    requireWorkspace: async () => ({ ...workspace, admin }),
    isFeatureEnabled: async () => true,
    ...overrides,
  };
}

test("compare route returns per-type counts and coverage metadata without caching", async () => {
  const rows = [
    { issue_type: "missing-title", severity: "warning", base_pages: "2", head_pages: "2", new_pages: ["https://example.test/new"], fixed_pages: ["https://example.test/old"] },
  ];
  const admin = memoryAdmin([
    audit(baseId, { pages_crawled: 10 }),
    audit(headId, { created_at: "2026-11-02T00:00:00.000Z", pages_crawled: 10 }),
  ], rows);
  const response = await GET(request(), undefined, deps(admin));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    host: "example.test",
    base: { id: baseId, createdAt: "2026-11-01T00:00:00.000Z", pagesCrawled: 10, maxPages: 50, crawlCompleted: true },
    head: { id: headId, createdAt: "2026-11-02T00:00:00.000Z", pagesCrawled: 10, maxPages: 50, crawlCompleted: true },
    comparable: true,
    warnings: [],
    rows: [{ issueType: "missing-title", severity: "critical", basePages: 2, headPages: 2, newPages: ["https://example.test/new"], fixedPages: ["https://example.test/old"] }],
  });
  assert.deepEqual(admin.calls.rpc, [{ name: "site_audit_compare", args: { p_brand_key: "brand-a", p_base: baseId, p_head: headId, p_sample: 100 } }]);
});

test("comparison refuses another workspace's audit id as 404 before the compare RPC", async () => {
  for (const query of [`base=${baseId}&head=${foreignId}`, `base=${foreignId}&head=${headId}`]) {
    const admin = memoryAdmin([
      audit(baseId),
      audit(headId),
      audit(foreignId, { brand_key: "brand-b", start_host: "secret.example" }),
    ]);
    const response = await GET(request(query), undefined, deps(admin));
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Audit not found.", code: "audit_not_found" });
    assert.deepEqual(admin.calls.rpc, []);
  }
});

test("mismatched hosts return the specified 422 before comparing", async () => {
  const admin = memoryAdmin([
    audit(baseId),
    audit(headId, { start_host: "other.example" }),
  ]);
  const response = await GET(request(), undefined, deps(admin));
  assert.equal(response.status, 422);
  assert.deepEqual(await response.json(), {
    error: "Choose two finished audits of the same site.",
    code: "audits_not_comparable",
  });
  assert.deepEqual(admin.calls.rpc, []);
});

test("queued or running audits return 422 before comparing", async () => {
  const admin = memoryAdmin([audit(baseId), audit(headId, { status: "running" })]);
  const response = await GET(request(), undefined, deps(admin));
  assert.equal(response.status, 422);
  assert.equal((await response.json()).code, "audits_not_comparable");
  assert.deepEqual(admin.calls.rpc, []);
});

test("coverage warning follows the specified 10 percent and incomplete-crawl rules", async () => {
  const admin = memoryAdmin([
    audit(baseId, { pages_crawled: 8, max_pages: 50 }),
    audit(headId, { pages_crawled: 10, max_pages: 50 }),
  ]);
  const response = await GET(request(), undefined, deps(admin));
  const body = await response.json();
  assert.equal(body.comparable, false);
  assert.deepEqual(body.warnings, [{
    code: "coverage_differs",
    message: "These audits crawled different numbers of pages (8 and 10), so some changes may come from coverage, not fixes.",
  }]);
});

test("an exact 10 percent page-count difference does not warn", async () => {
  const admin = memoryAdmin([
    audit(baseId, { pages_crawled: 9 }),
    audit(headId, { pages_crawled: 10 }),
  ]);
  const response = await GET(request(), undefined, deps(admin));
  const body = await response.json();
  assert.equal(body.host, "example.test");
  assert.equal(body.comparable, true);
  assert.deepEqual(body.warnings, []);
});

test("a max_pages mismatch alone does not warn when crawled counts and completeness match", async () => {
  const admin = memoryAdmin([
    audit(baseId, { pages_crawled: 10, max_pages: 50 }),
    audit(headId, { pages_crawled: 10, max_pages: 100 }),
  ]);
  const response = await GET(request(), undefined, deps(admin));
  const body = await response.json();
  assert.equal(body.comparable, true);
  assert.deepEqual(body.warnings, []);
});

test("invalid query and disabled feature refuse before loading the comparison", async () => {
  let compareCalls = 0;
  const invalid = await GET(request(`base=${baseId}&head=not-a-uuid`), undefined, deps({}, { getAuditCompare: async () => { compareCalls += 1; return {}; } }));
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "invalid_request");

  const disabled = await GET(request(), undefined, deps({}, {
    isFeatureEnabled: async () => false,
    getAuditCompare: async () => { compareCalls += 1; return {}; },
  }));
  assert.equal(disabled.status, 404);
  assert.equal((await disabled.json()).code, "feature_unavailable");
  assert.equal(compareCalls, 0);
});
