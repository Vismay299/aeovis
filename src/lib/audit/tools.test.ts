import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  siteAuditTools,
  runSiteAuditTool,
  getSiteAuditStatusTool,
  getSiteAuditIssuesTool,
  getSiteAuditPagesTool,
  listSiteAuditsTool,
  type SiteAuditToolContext,
} from "./tools.ts";

const brand = { brandKey: "brand-1", role: "owner" as const, display_name: "Example", website: "https://example.com/", website_host: "example.com", aliases: [], is_active: true };
function context(over: Partial<SiteAuditToolContext> = {}): SiteAuditToolContext {
  return { admin: {} as SiteAuditToolContext["admin"], brand, userId: "user-1", ...over };
}

test("site audit tools expose the five F22 names", () => {
  assert.deepEqual(siteAuditTools.map((tool) => tool.name), [
    "run_site_audit", "get_site_audit_status", "get_site_audit_issues", "get_site_audit_pages", "list_site_audits",
  ]);
});

test("site audit tool inputs are closed and outputs remain open", () => {
  for (const tool of siteAuditTools) {
    const input = z.toJSONSchema(tool.input, { io: "input" }) as { additionalProperties?: unknown };
    assert.equal(input.additionalProperties, false, `${tool.name} input`);
    const output = z.toJSONSchema(tool.output, { io: "output" }) as { additionalProperties?: unknown };
    assert.notEqual(output.additionalProperties, false, `${tool.name} output`);
  }
});

test("closed tool inputs reject unexpected fields", () => {
  assert.equal(runSiteAuditTool.input.safeParse({ extra: true }).success, false);
  assert.equal(getSiteAuditStatusTool.input.safeParse({ surprise: true }).success, false);
  assert.equal(getSiteAuditIssuesTool.input.safeParse({ surprise: true }).success, false);
  assert.equal(getSiteAuditPagesTool.input.safeParse({ surprise: true }).success, false);
  assert.equal(listSiteAuditsTool.input.safeParse({ surprise: true }).success, false);
});

test("run_site_audit passes tool trigger and the workspace to the start service", async () => {
  let call: any;
  const ctx = context({ deps: { startSiteAudit: async (ws, input) => {
    call = { ws, input };
    return { auditId: "6f1d2c3b-0a4e-4b8f-9c1d-2e3f4a5b6c7d", jobId: "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90", status: "queued", pollAfterSeconds: 3, approvedMaxUsd: null };
  } } });
  const result = await runSiteAuditTool.handler(ctx, { maxPages: 100 });
  assert.equal(result.status, "queued");
  assert.equal(call.ws.brandKey, "brand-1");
  assert.equal(call.input.trigger, "tool");
  assert.equal(call.input.maxPages, 100);
});

test("status tool reads a specific audit and parses the result", async () => {
  let calledId = "";
  const ctx = context({ deps: { getAuditStatus: async (_admin, _brandKey, id) => {
    calledId = id;
    return { id, status: "running", currentPhase: "crawling", pagesCrawled: 4, pagesTotal: 10, lighthouseTotal: 0, lighthouseCompleted: 0, lighthouseFailed: 0, errorCode: null };
  } } });
  const result = await getSiteAuditStatusTool.handler(ctx, { auditId: "6f1d2c3b-0a4e-4b8f-9c1d-2e3f4a5b6c7d" });
  assert.equal(calledId, "6f1d2c3b-0a4e-4b8f-9c1d-2e3f4a5b6c7d");
  assert.equal(result.phase, "crawling");
  assert.equal(result.pagesCrawled, 4);
});

test("issue and page tools parse service results from memory-backed seams", async () => {
  const ctx = context({ deps: {
    getAuditSummary: async () => ({ issueGroups: [{ issueType: "missing-title", severity: "warning", pages: 1 }] }),
    listAuditIssues: async () => ({ rows: [{ pageUrl: "https://example.com/" }] }),
    listAuditPages: async () => ({ total: 1, rows: [{ id: "page-1", url: "https://example.com/" }] }),
  } });
  const auditId = "6f1d2c3b-0a4e-4b8f-9c1d-2e3f4a5b6c7d";
  const issues = await getSiteAuditIssuesTool.handler(ctx, { auditId });
  assert.equal(issues.groups[0]?.title, "Missing title tag");
  assert.deepEqual(issues.groups[0]?.urls, ["https://example.com/"]);
  const pages = await getSiteAuditPagesTool.handler(ctx, { auditId, issueType: "missing-title" });
  assert.equal(pages.total, 1);
  assert.equal(pages.rows[0]?.id, "page-1");
});

test("history tool returns only parsed audit rows", async () => {
  const ctx = context({ deps: { listAudits: async () => ({ audits: [{ id: "audit-1", startUrl: "https://example.com/", status: "completed" }], capabilities: {} }) } });
  const result = await listSiteAuditsTool.handler(ctx, { limit: 5 });
  assert.equal(result.audits[0]?.status, "completed");
});
