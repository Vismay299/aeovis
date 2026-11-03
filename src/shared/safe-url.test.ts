import test from "node:test";
import assert from "node:assert/strict";
import { safeHttpUrl, safeHostname } from "./safe-url.ts";

test("safeHttpUrl - returns null for dangerous or non-http schemes", () => {
  assert.equal(safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpUrl("data:text/html,test"), null);
  assert.equal(safeHttpUrl("file:///etc/passwd"), null);
  assert.equal(safeHttpUrl("ftp://ftp.example.com"), null);
});

test("safeHttpUrl - returns null for credentials in URL (user:pass@host)", () => {
  assert.equal(safeHttpUrl("https://u:p@x"), null);
  assert.equal(safeHttpUrl("https://user:password@example.com/path"), null);
});

test("safeHttpUrl - returns unchanged safe http/https URLs", () => {
  assert.equal(safeHttpUrl("https://example.com/a"), "https://example.com/a");
  assert.equal(safeHttpUrl("http://example.com/search?q=test"), "http://example.com/search?q=test");
});

test("safeHttpUrl - returns null for null, undefined, empty, or invalid input", () => {
  assert.equal(safeHttpUrl(null), null);
  assert.equal(safeHttpUrl(undefined), null);
  assert.equal(safeHttpUrl(""), null);
  assert.equal(safeHttpUrl("not-a-valid-url"), null);
});

test("safeHostname - extracts bare hostname without leading www.", () => {
  assert.equal(safeHostname("https://www.a.com/x"), "a.com");
  assert.equal(safeHostname("https://example.com/page"), "example.com");
  assert.equal(safeHostname("https://www.subdomain.example.org/path?k=v"), "subdomain.example.org");
});

test("safeHostname - returns null for invalid or non-http URLs", () => {
  assert.equal(safeHostname("javascript:alert(1)"), null);
  assert.equal(safeHostname("https://u:p@x"), null);
  assert.equal(safeHostname(null), null);
  assert.equal(safeHostname(undefined), null);
  assert.equal(safeHostname(""), null);
});
