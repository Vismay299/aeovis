/**
 * R5.2.2 — tests for publish URL verification (content/publishVerification.js).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { extractTitle, titleMatches, verifyPublishUrl } from "./publishVerification.js";

// ---------------------------------------------------------------------------
// extractTitle
// ---------------------------------------------------------------------------

test("extractTitle returns null for non-string input", () => {
  assert.equal(extractTitle(null), null);
  assert.equal(extractTitle(undefined), null);
  assert.equal(extractTitle(42), null);
});

test("extractTitle returns null for empty HTML", () => {
  assert.equal(extractTitle(""), null);
});

test("extractTitle returns null when no title tag exists", () => {
  assert.equal(extractTitle("<html><body>No title here</body></html>"), null);
});

test("extractTitle extracts a simple title", () => {
  assert.equal(extractTitle("<html><head><title>My Page</title></head></html>"), "My Page");
});

test("extractTitle is case-insensitive for the tag", () => {
  assert.equal(extractTitle("<html><head><TITLE>UPPER</TITLE></head></html>"), "UPPER");
  assert.equal(extractTitle("<html><head><Title>Mixed</Title></head></html>"), "Mixed");
});

test("extractTitle normalizes whitespace inside the title", () => {
  assert.equal(
    extractTitle("<title>  Hello   World  </title>"),
    "Hello World"
  );
});

test("extractTitle handles multiline titles", () => {
  assert.equal(
    extractTitle("<title>\n  Multi\n  Line\n</title>"),
    "Multi Line"
  );
});

test("extractTitle handles title with attributes", () => {
  assert.equal(
    extractTitle("<title lang=\"en\">Attributed</title>"),
    "Attributed"
  );
});

// ---------------------------------------------------------------------------
// titleMatches
// ---------------------------------------------------------------------------

test("titleMatches returns false for missing inputs", () => {
  assert.equal(titleMatches(null, "page"), false);
  assert.equal(titleMatches("item", null), false);
  assert.equal(titleMatches("", "page"), false);
});

test("titleMatches returns true when page title contains item title", () => {
  assert.equal(titleMatches("My Article", "My Article - Example Blog"), true);
});

test("titleMatches is case-insensitive", () => {
  assert.equal(titleMatches("my article", "MY ARTICLE - Blog"), true);
});

test("titleMatches normalizes whitespace", () => {
  assert.equal(titleMatches("My Article", "  My   Article  - Blog"), true);
});

test("titleMatches returns false when titles don't match", () => {
  assert.equal(titleMatches("My Article", "Completely Different Title"), false);
});

// ---------------------------------------------------------------------------
// verifyPublishUrl
// ---------------------------------------------------------------------------

test("verifyPublishUrl returns error for missing URL", async () => {
  const result = await verifyPublishUrl({});
  assert.equal(result.ok, false);
  assert.equal(result.error, "missing_url");
});

test("verifyPublishUrl returns error for non-string URL", async () => {
  const result = await verifyPublishUrl({ url: 42 });
  assert.equal(result.ok, false);
  assert.equal(result.error, "missing_url");
});

test("verifyPublishUrl rejects non-HTTP schemes", async () => {
  // ftp:// is rejected by normalizeTargetUrl before we check protocol
  const result = await verifyPublishUrl({ url: "ftp://example.com/file" });
  assert.equal(result.ok, false);
  assert.ok(["invalid_scheme", "invalid_url"].includes(result.error));
});

test("verifyPublishUrl returns error when fetch fails", async () => {
  const fetchImpl = async () => { throw new Error("connection refused"); };
  const result = await verifyPublishUrl({ url: "https://example.com/page", fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error, "fetch_failed");
  assert.ok(result.detail.includes("connection refused"));
});

test("verifyPublishUrl returns error when URL returns non-200", async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 });
  const result = await verifyPublishUrl({ url: "https://example.com/missing", fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(result.error, "not_ok");
  assert.ok(result.detail.includes("404"));
});

test("verifyPublishUrl succeeds when URL returns 200 with no title check", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => "<html><body>Content</body></html>",
  });
  const result = await verifyPublishUrl({ url: "https://example.com/page", fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
});

test("verifyPublishUrl passes content match when title matches", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => "<html><head><title>My Article - Blog</title></head></html>",
  });
  const result = await verifyPublishUrl({
    url: "https://example.com/page",
    itemTitle: "My Article",
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.title_found, "My Article - Blog");
});

test("verifyPublishUrl fails when title doesn't match", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => "<html><head><title>Wrong Page</title></head></html>",
  });
  const result = await verifyPublishUrl({
    url: "https://example.com/page",
    itemTitle: "My Article",
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "title_mismatch");
  assert.equal(result.title_found, "Wrong Page");
});

test("verifyPublishUrl fails when page has no title tag", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => "<html><body>No title here</body></html>",
  });
  const result = await verifyPublishUrl({
    url: "https://example.com/page",
    itemTitle: "My Article",
    fetchImpl,
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "no_title");
});
