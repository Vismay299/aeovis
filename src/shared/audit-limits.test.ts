import test from "node:test";
import assert from "node:assert/strict";
import {
  clampAuditMaxPages,
  maxPagesFor,
  estimatedCrawlMinutes,
  MIN_AUDIT_PAGES,
  DEFAULT_AUDIT_PAGES,
  MAX_AUDIT_PAGES,
  RENDERED_MAX_AUDIT_PAGES,
  LARGE_AUDIT_CONFIRM_PAGES,
  LIGHTHOUSE_SAMPLE_MAX,
  AUDIT_MONTHLY_PAGES_DEFAULT,
  AUDIT_HOST_CAP,
} from "./audit-limits.ts";

test("audit-limits constants match spec values", () => {
  assert.equal(MIN_AUDIT_PAGES, 10);
  assert.equal(DEFAULT_AUDIT_PAGES, 50);
  assert.equal(MAX_AUDIT_PAGES, 10_000);
  assert.equal(RENDERED_MAX_AUDIT_PAGES, 1_000);
  assert.equal(LARGE_AUDIT_CONFIRM_PAGES, 500);
  assert.equal(LIGHTHOUSE_SAMPLE_MAX, 10);
  assert.equal(AUDIT_MONTHLY_PAGES_DEFAULT, 50_000);
  assert.equal(AUDIT_HOST_CAP, 2);
});

test("clampAuditMaxPages handles undefined, low, high, and valid inputs", () => {
  assert.equal(clampAuditMaxPages(undefined), 50);
  assert.equal(clampAuditMaxPages(null), 50);
  assert.equal(clampAuditMaxPages(NaN), 50);
  assert.equal(clampAuditMaxPages(5), 10);
  assert.equal(clampAuditMaxPages(0), 10);
  assert.equal(clampAuditMaxPages(-10), 10);
  assert.equal(clampAuditMaxPages(20_000), 10_000);
  assert.equal(clampAuditMaxPages(500), 500);
  assert.equal(clampAuditMaxPages(50.8), 50);
});

test("maxPagesFor accounts for rendering cap and environment overrides", () => {
  assert.equal(maxPagesFor(false), 10_000);
  assert.equal(maxPagesFor(true), 1_000);
  assert.equal(maxPagesFor(false, 5_000), 5_000);
  assert.equal(maxPagesFor(true, 5_000), 1_000);
  assert.equal(maxPagesFor(true, 200), 200);
});

test("estimatedCrawlMinutes calculates minutes accurately", () => {
  assert.equal(estimatedCrawlMinutes(500), 9);
  assert.equal(estimatedCrawlMinutes(10), 1);
  assert.equal(estimatedCrawlMinutes(60), 1);
  assert.equal(estimatedCrawlMinutes(61), 2);
  assert.equal(estimatedCrawlMinutes(10_000), 167);
});
