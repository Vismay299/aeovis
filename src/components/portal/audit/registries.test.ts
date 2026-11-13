// F18 phase 4 — registry shapes (F18-AC-28 unit half).
//
// The types must accept the entries F19 will append, and the shipped registry
// must start with the site-audit panel. The page-action registry ships empty.

import test from "node:test";
import assert from "node:assert/strict";
import type { ComponentType } from "react";

import { AUDIT_TABS, type AuditTab } from "./tabs.ts";
import {
  AUDIT_PAGE_ACTIONS,
  type AuditPageAction,
  type AuditPageRef,
} from "./pageActions.ts";

function sampleEntry(): AuditTab {
  return {
    id: "indexnow",
    label: "IndexNow",
    flag: "indexnow",
    Panel: (() => null) as ComponentType<{
      brandKey: string;
      auditId: string | null;
    }>,
  };
}

test("the shipped tab registry starts with the site audit panel", () => {
  assert.equal(AUDIT_TABS.length, 1);
  assert.equal(AUDIT_TABS[0].id, "audit");
  assert.equal(AUDIT_TABS[0].label, "Site audit");
  assert.ok(AUDIT_TABS[0].Panel);
});

test("an F19-shaped tab satisfies AuditTab and appends without edits", () => {
  const appended: AuditTab[] = [...AUDIT_TABS, sampleEntry()];
  assert.deepEqual(
    appended.map((tab) => tab.id),
    ["audit", "indexnow"],
  );
  assert.equal(appended[1].flag, "indexnow");
});

test("an F19-shaped page action satisfies AuditPageAction", () => {
  const page: AuditPageRef = {
    url: "https://example.com/",
    statusCode: 200,
    indexable: true,
  };
  const action: AuditPageAction = {
    id: "submit-indexnow",
    label: "Submit to IndexNow",
    flag: "indexnow",
    eligible: (candidate) =>
      candidate.statusCode === 200 && candidate.indexable === true,
    Dialog: () => null,
  };
  assert.equal(action.eligible(page), true);
  assert.equal(
    action.eligible({ ...page, statusCode: 404, indexable: false }),
    false,
  );
});

test("the shipped page-action registry is empty", () => {
  assert.deepEqual(AUDIT_PAGE_ACTIONS, []);
});
