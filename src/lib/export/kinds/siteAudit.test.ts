import test from "node:test";
import assert from "node:assert/strict";
import { serverCsv } from "../serverCsv.ts";
import {
  siteAuditIssuesKind,
  siteAuditIssuesParams,
  siteAuditPagesKind,
  siteAuditPerformanceKind,
} from "./siteAudit.ts";

test("site_audit kinds are registered with the expected keys", () => {
  assert.equal(siteAuditIssuesKind.kind, "site_audit_issues");
  assert.equal(siteAuditPagesKind.kind, "site_audit_pages");
  assert.equal(siteAuditPerformanceKind.kind, "site_audit_performance");
  assert.equal(siteAuditIssuesKind.maxRows, 50_000);
  assert.equal(siteAuditPagesKind.maxRows, 10_000);
  assert.equal(siteAuditPerformanceKind.maxRows, 20);
});

test("site_audit_issues params accept a uuid audit id", () => {
  assert.equal(
    siteAuditIssuesParams.safeParse({ auditId: "123e4567-e89b-12d3-a456-426614174000" }).success,
    true,
  );
  assert.equal(siteAuditIssuesParams.safeParse({ auditId: "not-a-uuid" }).success, false);
});

test("site_audit_issues toCsvRow keeps issue details", () => {
  const cells = siteAuditIssuesKind.toCsvRow({
    severity: "warning",
    issue_type: "missing-title",
    page_url: "https://example.test/page",
    details: { missing: ["title"] },
  });
  assert.deepEqual(cells, [
    "warning",
    "Missing title tag",
    "https://example.test/page",
    '{"missing":["title"]}',
    "Add a unique, descriptive <title> of roughly 50–60 characters that includes the page's primary topic.",
  ]);
});

test("CSV formula safety: a =HYPERLINK title is prefixed with '", () => {
  const cells = siteAuditIssuesKind.toCsvRow({
    severity: "info",
    issue_type: "missing-title",
    page_url: "https://example.test/page",
    details: null,
  });
  // Simulate an issue title that starts with a formula character by overriding
  // the descriptor lookup is not possible, so exercise serverCsv directly.
  const csv = serverCsv(["Issue"], [["=HYPERLINK(\"https://evil.example\")"]]);
  assert.match(csv, /"'=HYPERLINK/);
  assert.equal(cells[1], "Missing title tag");
});