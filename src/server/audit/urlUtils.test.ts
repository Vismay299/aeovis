import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeUrl,
  canonicalUrlKey,
  isSameOrigin,
  detectUrlTemplate,
  getOrigin,
} from "./urlUtils.ts";

test("normalizeUrl normalizes host/query/hash, preserves trailing slash", () => {
  const value = normalizeUrl(
    "https://Example.COM/path/?b=2&a=1#section",
    "https://fallback.com",
  );
  assert.equal(value, "https://example.com/path/?a=1&b=2");
});

test("normalizeUrl preserves a trailing slash on path-only URLs", () => {
  assert.equal(
    normalizeUrl("https://example.com/services/"),
    "https://example.com/services/",
  );
});

test("normalizeUrl returns null for unsupported protocol", () => {
  assert.equal(normalizeUrl("mailto:test@example.com"), null);
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("ftp://example.com"), null);
});

test("canonicalUrlKey treats www and http as equal to https apex", () => {
  const base = canonicalUrlKey("https://example.com/");
  assert.equal(canonicalUrlKey("https://www.example.com/"), base);
  assert.equal(canonicalUrlKey("http://example.com/"), base);
  assert.equal(canonicalUrlKey("http://www.example.com/"), base);
});

test("isSameOrigin matches same origin and allowed upgrades", () => {
  assert.equal(
    isSameOrigin("https://www.example.com/products", "https://example.com"),
    true,
  );
  assert.equal(
    isSameOrigin("https://example.com/page", "http://example.com"),
    true,
  );
  assert.equal(
    isSameOrigin("https://example.org", "https://example.com"),
    false,
  );
  assert.equal(
    isSameOrigin("https://example.com:8080", "https://example.com"),
    false,
  );
});

test("detectUrlTemplate maps dynamic path segments", () => {
  assert.equal(
    detectUrlTemplate("/blog/2026-03-01/my-great-post"),
    "/blog/:date/:slug",
  );
  assert.equal(
    detectUrlTemplate("/products/12345"),
    "/products/:id",
  );
  assert.equal(
    detectUrlTemplate("/items/123e4567-e89b-12d3-a456-426614174000"),
    "/items/:uuid",
  );
  assert.equal(
    detectUrlTemplate("/static/about"),
    "/static/about",
  );
});

test("getOrigin returns the origin protocol + host + port", () => {
  assert.equal(getOrigin("https://example.com:8443/test"), "https://example.com:8443");
  assert.equal(getOrigin("http://example.com/"), "http://example.com");
});
