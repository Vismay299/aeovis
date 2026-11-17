import test from "node:test";
import assert from "node:assert/strict";
import { GET as statusGet } from "../../app/api/customer/audit/[auditId]/route.ts";
import { GET as feedGet } from "../../app/api/customer/audit/[auditId]/feed/route.ts";
import { GET as summaryGet } from "../../app/api/customer/audit/[auditId]/summary/route.ts";
import { GET as issuesGet } from "../../app/api/customer/audit/[auditId]/issues/route.ts";
import { GET as pagesGet } from "../../app/api/customer/audit/[auditId]/pages/route.ts";
import { GET as performanceGet } from "../../app/api/customer/audit/[auditId]/performance/route.ts";
import { GET as lighthouseDetailGet } from "../../app/api/customer/audit/[auditId]/lighthouse/[resultId]/route.ts";
import { GET as lighthouseExportGet } from "../../app/api/customer/audit/[auditId]/lighthouse/[resultId]/export/route.ts";
import { AppError } from "../../shared/http/appError.ts";
import { getAuditFeed, getAuditSummary, listAuditIssues, listAuditPages, getLighthouseDetail } from "./results.ts";

const auditId = "6f1d2c3b-0a4e-4b8f-9c1d-2e3f4a5b6c7d";
const workspace = { user: { id: "user-1", email: "owner@example.com" }, brandKey: "brand-1", role: "owner", brand: {}, admin: {} };
const context = { params: { auditId } };
const baseDeps = { requireWorkspace: async () => workspace, isFeatureEnabled: async () => true };
function request(path = "") { return new Request(`https://app.example/api/customer/audit/${auditId}${path}`); }

function createMemoryAuditAdmin() {
  const audit = {
    id: auditId, brand_key: "brand-1", status: "completed", start_url: "https://example.com/", pages_crawled: 3,
    pages_seen: 3, pages_total: 3, max_pages: 10, crawl_completed: true, run_lighthouse: true, render_javascript: false,
    site_platform: null, created_at: "2026-11-01T00:00:00.000Z", completed_at: "2026-11-01T00:01:00.000Z",
    pages_abandoned: 0, link_graph_complete: true, discovery_truncated: false, ai_access: [], robots_status: "found",
    llms_txt: { status: "missing", httpStatus: 404, contentType: null, firstLine: null },
  };
  const pages = [
    { id: "page-a", audit_id: auditId, brand_key: "brand-1", url: "https://example.com/", status_code: 200, fetch_class: "ok", redirect_url: null, title: "Home", meta_description: "Main", h1_count: 1, word_count: 40, images_total: 2, images_missing_alt: 1, response_time_ms: 500, crawl_depth: 0, in_sitemap: true, is_indexable: true, structured_data_types: ["Organization"], rendered: false, crawled_at: "2026-11-01T00:00:05.000Z" },
    { id: "page-b", audit_id: auditId, brand_key: "brand-1", url: "https://example.com/about", status_code: 200, fetch_class: "ok", redirect_url: null, title: "About", meta_description: "About", h1_count: 1, word_count: 80, images_total: 1, images_missing_alt: 0, response_time_ms: 700, crawl_depth: 1, in_sitemap: false, is_indexable: true, structured_data_types: [], rendered: false, crawled_at: "2026-11-01T00:00:10.000Z" },
    { id: "page-c", audit_id: auditId, brand_key: "brand-1", url: "https://example.com/old", status_code: 404, fetch_class: "error", redirect_url: null, title: null, meta_description: null, h1_count: 0, word_count: 0, images_total: 0, images_missing_alt: 0, response_time_ms: 1000, crawl_depth: 2, in_sitemap: false, is_indexable: false, structured_data_types: [], rendered: false, crawled_at: "2026-11-01T00:00:15.000Z" },
  ];
  const issues = [
    { id: "issue-a", audit_id: auditId, brand_key: "brand-1", page_id: "page-a", page_url: "https://example.com/", issue_type: "missing-title", severity: "warning", details: { why: "a" } },
    { id: "issue-b", audit_id: auditId, brand_key: "brand-1", page_id: "page-b", page_url: "https://example.com/about", issue_type: "missing-title", severity: "warning", details: { why: "b" } },
    { id: "issue-c", audit_id: auditId, brand_key: "brand-1", page_id: "page-c", page_url: "https://example.com/old", issue_type: "broken-page", severity: "critical", details: { status: 404 } },
  ];
  const lighthouse = [{ id: "lh-a", audit_id: auditId, brand_key: "brand-1", page_id: "page-a", strategy: "mobile", performance_score: 80, accessibility_score: 90, best_practices_score: 92, seo_score: 88, lcp_ms: 1100, cls: 0.02, inp_ms: 130, ttfb_ms: 250, error_message: null, payload_path: "brand-1/audit/lh-a.json", created_at: "2026-11-01T00:01:00.000Z" }];
  const tables = { site_audits: [audit], site_audit_pages: pages, site_audit_issues: issues, site_audit_lighthouse: lighthouse };
  const admin = {
    from(table) {
      const query = { table, filters: [], ordering: null, limitValue: null, rangeValue: null };
      const api = {
        select() { return this; },
        eq(field, value) { query.filters.push((row) => row[field] === value); return this; },
        neq(field, value) { query.filters.push((row) => row[field] !== value); return this; },
        in(field, values) { query.filters.push((row) => values.includes(row[field])); return this; },
        not(field, operator, value) { query.filters.push((row) => operator !== "is" || value !== null || row[field] !== null); return this; },
        gte(field, value) { query.filters.push((row) => row[field] !== null && row[field] >= value); return this; },
        lte(field, value) { query.filters.push((row) => row[field] !== null && row[field] <= value); return this; },
        gt(field, value) { query.filters.push((row) => row[field] !== null && row[field] > value); return this; },
        lt(field, value) { query.filters.push((row) => row[field] !== null && row[field] < value); return this; },
        or(expression) {
          if (expression.includes("status_code.is.null")) query.filters.push((row) => row.status_code === null || row.status_code === 0);
          else {
            const match = expression.match(/ilike\.%(.+?)%/);
            const needle = (match?.[1] ?? "").toLowerCase();
            query.filters.push((row) => [row.url, row.title, row.meta_description].some((value) => String(value ?? "").toLowerCase().includes(needle)));
          }
          return this;
        },
        order(field, options = {}) { query.ordering = [field, options]; return this; },
        limit(value) { query.limitValue = value; return this; },
        range(start, end) { query.rangeValue = [start, end]; return this; },
        async maybeSingle() { const result = await this.execute(); return { data: result.data[0] ?? null, error: null }; },
        async execute() {
          let result = (tables[table] ?? []).filter((row) => query.filters.every((filter) => filter(row)));
          const count = result.length;
          if (query.ordering) {
            const [field, options] = query.ordering;
            result = result.slice().sort((a, b) => {
              const av = a[field] ?? ""; const bv = b[field] ?? "";
              const compare = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
              return options.ascending === false ? -compare : compare;
            });
          }
          if (query.rangeValue) result = result.slice(query.rangeValue[0], query.rangeValue[1] + 1);
          if (query.limitValue !== null) result = result.slice(0, query.limitValue);
          return { data: result, error: null, count };
        },
        then(resolve, reject) { return this.execute().then(resolve, reject); },
      };
      return api;
    },
    async rpc(name, args) {
      if (name !== "site_audit_issue_summary" || args.p_audit_id !== auditId) throw new Error(`unexpected RPC ${name}`);
      const grouped = new Map();
      for (const issue of issues) {
        const group = grouped.get(issue.issue_type) ?? { issue_type: issue.issue_type, severity: issue.severity, pages: new Set(), rows_count: 0 };
        group.pages.add(issue.page_url); group.rows_count += 1; grouped.set(issue.issue_type, group);
      }
      return { data: Array.from(grouped.values(), (group) => ({ ...group, pages: group.pages.size })), error: null };
    },
  };
  return { admin, audit, pages, issues, lighthouse };
}

test("status route lazily reconciles and returns no-store status", async () => {
  let reconciled = 0;
  const response = await statusGet(request(), context, { ...baseDeps,
    getOwnedAudit: async () => ({ status: "running" }), reconcileRunningAudit: async () => { reconciled += 1; },
    getAuditStatus: async () => ({ id: auditId, status: "running", currentPhase: "crawling", pagesCrawled: 2, pagesTotal: 10, pollAfterSeconds: 3 }),
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(reconciled, 1);
  assert.equal((await response.json()).pollAfterSeconds, 3);
});

test("feed, summary, issues, pages and performance routes return their service values", async () => {
  const feed = await feedGet(request("/feed?limit=2"), context, { ...baseDeps, getAuditFeed: async (_admin, _brand, _id, limit) => ({ entries: [], pollAfterSeconds: limit === 2 ? 1.5 : null }) });
  assert.equal((await feed.json()).pollAfterSeconds, 1.5);
  const summary = await summaryGet(request("/summary"), context, { ...baseDeps, getAuditSummary: async () => ({ issueGroups: [] }) });
  assert.deepEqual((await summary.json()).issueGroups, []);
  const issues = await issuesGet(request("/issues?type=broken-page&offset=5&limit=20"), context, { ...baseDeps, listAuditIssues: async (_admin, _brand, _id, input) => ({ issueType: input.type, total: 6, rows: [] }) });
  assert.equal((await issues.json()).issueType, "broken-page");
  const pages = await pagesGet(request("/pages?status=ok&sort=words&dir=desc&limit=10"), context, { ...baseDeps, listAuditPages: async (_admin, _brand, _id, filters) => ({ total: filters.limit, rows: [] }) });
  assert.equal((await pages.json()).total, 10);
  const performance = await performanceGet(request("/performance"), context, { ...baseDeps, listAuditPerformance: async () => ({ rows: [] }) });
  assert.deepEqual((await performance.json()).rows, []);
});

test("cross-workspace audit ids are hidden and strict query validation is applied", async () => {
  const hidden = await statusGet(request(), context, { ...baseDeps, getOwnedAudit: async () => { throw new AppError(404, "audit_not_found", "Audit not found."); } });
  assert.equal(hidden.status, 404);
  assert.equal((await hidden.json()).code, "audit_not_found");
  const invalid = await issuesGet(request("/issues?type=bad!"), context, baseDeps);
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "invalid_request");
  const off = await summaryGet(request("/summary"), context, { ...baseDeps, isFeatureEnabled: async () => false });
  assert.equal(off.status, 404);
  assert.equal((await off.json()).code, "feature_unavailable");
});

test("flag-off returns 404 on every results/status route", async () => {
  const off = { ...baseDeps, isFeatureEnabled: async () => false };
  const results = [
    await statusGet(request(), context, off),
    await feedGet(request("/feed"), context, off),
    await summaryGet(request("/summary"), context, off),
    await issuesGet(request("/issues?type=missing-title"), context, off),
    await pagesGet(request("/pages"), context, off),
    await performanceGet(request("/performance"), context, off),
  ];
  for (const response of results) {
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "feature_unavailable");
  }
});

test("in-memory result readers apply filters, order and pagination", async () => {
  const { admin } = createMemoryAuditAdmin();
  const filtered = await listAuditPages(admin, "brand-1", auditId, {
    status: "ok", fetchClass: "ok", minWords: 20, maxWords: 80, minResponseMs: 400, maxResponseMs: 800,
    missingAlt: "yes", issueType: "missing-title", sort: "words", dir: "desc", offset: 0, limit: 1,
  });
  assert.equal(filtered.total, 1);
  assert.deepEqual(filtered.rows.map((row) => row.id), ["page-a"]);

  const firstPage = await listAuditPages(admin, "brand-1", auditId, {
    sort: "words", dir: "asc", offset: 0, limit: 2,
  });
  const secondPage = await listAuditPages(admin, "brand-1", auditId, {
    sort: "words", dir: "asc", offset: 2, limit: 2,
  });
  assert.equal(firstPage.total, 3);
  assert.deepEqual(firstPage.rows.map((row) => row.id), ["page-c", "page-a"]);
  assert.deepEqual(secondPage.rows.map((row) => row.id), ["page-b"]);

  const issuePage = await listAuditIssues(admin, "brand-1", auditId, { type: "missing-title", offset: 1, limit: 1 });
  assert.equal(issuePage.total, 2);
  assert.equal(issuePage.rows[0].pageUrl, "https://example.com/about");
  const feed = await getAuditFeed(admin, "brand-1", auditId, 1);
  assert.equal(feed.entries.length, 1);
  assert.equal(feed.entries[0].url, "https://example.com/old");
  assert.equal(feed.pollAfterSeconds, null);

  const summary = await getAuditSummary(admin, "brand-1", auditId);
  assert.equal(summary.issueGroups.find((group) => group.issueType === "missing-title").pages, 2);
  assert.equal(summary.stats.averageResponseMs, 600);
  assert.equal(summary.flags.linkGraphComplete, true);
});

const resultId = "11111111-2222-4333-8555-666666666666";
const lhContext = { params: { auditId, resultId } };
function lhRequest(path = "") {
  return new Request(`https://app.example/api/customer/audit/${auditId}/lighthouse/${resultId}${path}`);
}
const lhDetail = {
  id: resultId,
  finalUrl: "https://example.com/",
  strategy: "mobile",
  createdAt: "2026-11-01T00:01:00.000Z",
  hasIssueDetails: true,
  scores: { performance: 80, accessibility: 90, "best-practices": 92, seo: 88 },
  metrics: {},
  issues: [{ category: "performance", auditKey: "unused-javascript", title: "Reduce unused JavaScript", severity: "critical" }],
};

test("lighthouse detail returns scores and filters refusal happens before any provider call", async () => {
  let providerCalls = 0;
  const response = await lighthouseDetailGet(lhRequest(), lhContext, {
    ...baseDeps,
    getLighthouseDetail: async () => {
      providerCalls += 1;
      return lhDetail;
    },
  });
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.finalUrl, "https://example.com/");
  assert.equal(body.scores.performance, 80);
  assert.equal(providerCalls, 1);
});

test("lighthouse detail without stored payload is a 404 with details copy", async () => {
  const response = await lighthouseDetailGet(lhRequest(), lhContext, {
    ...baseDeps,
    getLighthouseDetail: async () => {
      throw new AppError(404, "lighthouse_details_unavailable", "This Lighthouse run was saved without details.");
    },
  });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "lighthouse_details_unavailable");
});

test("lighthouse detail is workspace-scoped and flag-gated", async () => {
  const hidden = await lighthouseDetailGet(lhRequest(), lhContext, {
    ...baseDeps,
    getLighthouseDetail: async () => {
      throw new AppError(404, "audit_not_found", "Audit not found.");
    },
  });
  assert.equal(hidden.status, 404);
  const off = await lighthouseDetailGet(lhRequest(), lhContext, { ...baseDeps, isFeatureEnabled: async () => false });
  assert.equal(off.status, 404);
  assert.equal((await off.json()).code, "feature_unavailable");
});

test("getLighthouseDetail reads the stored payload and throws when details are missing", async () => {
  const payload = JSON.stringify({
    version: 2,
    source: "dataforseo-lighthouse",
    hasIssueDetails: true,
    metadata: {
      requestedUrl: "https://example.com/",
      finalUrl: "https://example.com/",
      strategy: "mobile",
      fetchedAt: "2026-11-01T00:01:00.000Z",
      lighthouseVersion: null,
      taskId: null,
      cost: null,
    },
    scores: { performance: 80, accessibility: 90, "best-practices": 92, seo: 88 },
    metrics: {
      firstContentfulPaint: { score: null, displayValue: null, numericValue: null },
      largestContentfulPaint: { score: null, displayValue: "1.1 s", numericValue: 1100 },
      totalBlockingTime: { score: null, displayValue: null, numericValue: null },
      cumulativeLayoutShift: { score: null, displayValue: null, numericValue: 0.02 },
      speedIndex: { score: null, displayValue: null, numericValue: null },
      timeToInteractive: { score: null, displayValue: null, numericValue: null },
      interactionToNextPaint: { score: null, displayValue: null, numericValue: 130 },
      serverResponseTime: { score: null, displayValue: null, numericValue: 250 },
    },
    issues: [],
  });
  const admin = {
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          if (table === "site_audits") return { data: { id: auditId }, error: null };
          return {
            data: {
              id: resultId,
              strategy: "mobile",
              created_at: "2026-11-01T00:01:00.000Z",
              performance_score: 80,
              accessibility_score: 90,
              best_practices_score: 92,
              seo_score: 88,
              payload_path: "brand-1/audit-1/p-a-mobile.json",
            },
            error: null,
          };
        },
      };
    },
    storage: {
      from() {
        return {
          async download() {
            return { data: { text: async () => payload }, error: null };
          },
        };
      },
    },
  };
  const detail = await getLighthouseDetail(admin, "brand-1", auditId, resultId);
  assert.equal(detail.finalUrl, "https://example.com/");
  assert.equal(detail.metrics.largestContentfulPaint.numericValue, 1100);
  const missing = {
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          if (table === "site_audits") return { data: { id: auditId }, error: null };
          return { data: { id: resultId, payload_path: null }, error: null };
        },
      };
    },
    storage: { from() { return { async download() { return { data: null, error: new Error("nope") }; } }; } },
  };
  await assert.rejects(getLighthouseDetail(missing, "brand-1", auditId, resultId), (err) => {
    assert.equal(err.code, "lighthouse_details_unavailable");
    return true;
  });
});

test("lighthouse export validates mode and returns the filtered file", async () => {
  const bad = await lighthouseExportGet(lhRequest("?mode=category"), lhContext, {
    ...baseDeps,
    getLighthouseDetail: async () => lhDetail,
  });
  assert.equal(bad.status, 400);
  const issuesFile = await lighthouseExportGet(lhRequest("?mode=issues"), lhContext, {
    ...baseDeps,
    getLighthouseDetail: async () => lhDetail,
    downloadPayload: async () => JSON.stringify({
      version: 2,
      source: "dataforseo-lighthouse",
      hasIssueDetails: true,
      metadata: {
        requestedUrl: "https://example.com/",
        finalUrl: "https://example.com/",
        strategy: "mobile",
        fetchedAt: "2026-11-01T00:01:00.000Z",
        lighthouseVersion: null,
        taskId: null,
        cost: null,
      },
      scores: { performance: 80, accessibility: 90, "best-practices": 92, seo: 88 },
      metrics: {},
      issues: [],
    }),
  });
  assert.equal(issuesFile.headers.get("content-disposition").includes(".json"), true);
  const off = await lighthouseExportGet(lhRequest(), lhContext, { ...baseDeps, isFeatureEnabled: async () => false });
  assert.equal(off.status, 404);
});
