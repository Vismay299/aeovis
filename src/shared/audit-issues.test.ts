import test from "node:test";
import assert from "node:assert/strict";
import {
  AUDIT_ISSUE_TYPES,
  ISSUE_SEVERITY_ORDER,
  ISSUE_CATEGORY_LABELS,
  getIssueDescriptor,
  type AuditIssueType,
  type IssueSeverity,
  type IssueCategory,
  type IssueScope,
} from "./audit-issues.ts";

test("AUDIT_ISSUE_TYPES has exactly 48 issue types with valid schema and copy", () => {
  const keys = Object.keys(AUDIT_ISSUE_TYPES);
  assert.equal(keys.length, 48, "Registry must contain exactly 48 issue types");

  const validSeverities = new Set<IssueSeverity>(["critical", "warning", "info"]);
  const validCategories = new Set<IssueCategory>([
    "crawl",
    "links",
    "content",
    "indexability",
    "performance",
    "ai_access",
    "structured_data",
    "social",
    "international",
  ]);
  const validScopes = new Set<IssueScope>(["page", "site"]);

  for (const [key, desc] of Object.entries(AUDIT_ISSUE_TYPES)) {
    assert.ok(validSeverities.has(desc.severity), `${key}: invalid severity ${desc.severity}`);
    assert.ok(validCategories.has(desc.category), `${key}: invalid category ${desc.category}`);
    assert.ok(validScopes.has(desc.scope), `${key}: invalid scope ${desc.scope}`);

    assert.ok(desc.title && desc.title.trim().length > 0, `${key}: title must be non-empty`);
    assert.ok(desc.explanation && desc.explanation.trim().length > 0, `${key}: explanation must be non-empty`);
    assert.ok(desc.howToFix && desc.howToFix.trim().length > 0, `${key}: howToFix must be non-empty`);

    // No copy contains "OpenSEO"
    assert.ok(!desc.title.includes("OpenSEO"), `${key}: title contains OpenSEO`);
    assert.ok(!desc.explanation.includes("OpenSEO"), `${key}: explanation contains OpenSEO`);
    assert.ok(!desc.howToFix.includes("OpenSEO"), `${key}: howToFix contains OpenSEO`);
  }
});

test("ISSUE_SEVERITY_ORDER maps critical < warning < info", () => {
  assert.equal(ISSUE_SEVERITY_ORDER.critical, 0);
  assert.equal(ISSUE_SEVERITY_ORDER.warning, 1);
  assert.equal(ISSUE_SEVERITY_ORDER.info, 2);
});

test("ISSUE_CATEGORY_LABELS covers all 9 categories", () => {
  const categories: IssueCategory[] = [
    "crawl",
    "links",
    "content",
    "indexability",
    "performance",
    "ai_access",
    "structured_data",
    "social",
    "international",
  ];
  for (const cat of categories) {
    assert.ok(ISSUE_CATEGORY_LABELS[cat], `Missing label for category ${cat}`);
  }
});

test("getIssueDescriptor returns descriptor or null", () => {
  const desc = getIssueDescriptor("missing-title");
  assert.ok(desc);
  assert.equal(desc.severity, "critical");
  assert.equal(desc.title, "Missing title tag");

  assert.equal(getIssueDescriptor("non-existent-issue"), null);
});
