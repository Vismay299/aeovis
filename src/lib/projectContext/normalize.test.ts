// Test cases ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/domainUtils.ts
//   src/server/features/project-context/services/contextUpdateOps.ts
// Adapted for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../http/appError.ts";
import {
  normalizeCompetitorDomain,
  normalizeKeyPageUrl,
  normalizeResearchKey,
} from "./normalize.ts";

test("competitor domains are lowercased, normalized and stripped to their host", () => {
  assert.equal(normalizeCompetitorDomain("https://www.Acme.com/pricing"), "acme.com");
  assert.equal(normalizeCompetitorDomain("ACME.co.in"), "acme.co.in");
});

test("localhost and IP literals are rejected as competitor domains", () => {
  for (const value of ["localhost", "192.168.1.1", "https://[::1]"]) {
    assert.throws(
      () => normalizeCompetitorDomain(value),
      (error: unknown) =>
        error instanceof AppError && error.status === 400 && error.code === "context_invalid",
    );
  }
});

test("key pages are https, omit www and fragments, and retain paths and queries", () => {
  assert.equal(normalizeKeyPageUrl("example.com"), "https://example.com");
  assert.equal(normalizeKeyPageUrl("http://www.x.com/a?b=1#c"), "https://x.com/a?b=1");
});

test("research keys use NFKC, whitespace folding and lowercase", () => {
  assert.equal(normalizeResearchKey("  ＯＦＦＣＵＬＴ\t  IN  "), "offcult in");
  assert.throws(() => normalizeResearchKey("x".repeat(301)), AppError);
});
