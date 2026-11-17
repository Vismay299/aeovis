// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/table/url.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import test from "node:test";
import assert from "node:assert/strict";
import { formatUrlForDisplay, resolveUrlHref } from "./url.ts";

test("table URL helpers: strips scroll-to-text fragments but keeps normal hashes and queries", () => {
  assert.equal(
    formatUrlForDisplay("https://example.com/a%20b?q=one#:~:text=needle"),
    "https://example.com/a b?q=one",
  );
  assert.equal(
    formatUrlForDisplay("https://example.com/path?q=1#section"),
    "https://example.com/path?q=1#section",
  );
});

test("table URL helpers: returns null for invalid or empty display URLs", () => {
  assert.equal(formatUrlForDisplay(""), null);
  assert.equal(formatUrlForDisplay(null), null);
  assert.equal(formatUrlForDisplay(undefined), null);
});

test("table URL helpers: rejects unsafe absolute URL schemes", () => {
  assert.equal(resolveUrlHref("javascript:alert(1)", "example.com"), null);
  assert.equal(resolveUrlHref("data:text/html,evil", "example.com"), null);
});

test("table URL helpers: resolves relative paths against base domain", () => {
  assert.equal(
    resolveUrlHref("/pricing", "acme.example"),
    "https://acme.example/pricing",
  );
  assert.equal(
    resolveUrlHref("pricing", "acme.example"),
    "https://acme.example/pricing",
  );
  assert.equal(resolveUrlHref("/pricing", null), null);
  assert.equal(resolveUrlHref("/pricing", undefined), null);
  assert.equal(resolveUrlHref("/pricing", ""), null);
});
