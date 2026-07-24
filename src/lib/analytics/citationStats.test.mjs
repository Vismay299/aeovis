import test from "node:test";
import assert from "node:assert/strict";
import { VALID_CITATION_GROUPS, parseGroupParam, aggregateCitations } from "./citationStats.js";

/**
 * P3a coverage for GET /api/brands/[brand]/citations's pure aggregation
 * layer. No DB/route/Next.js involved — operates on plain citation row
 * objects (the same shape db/analytics.js's getCitationsForBrand returns).
 */

// =============================================================================
// parseGroupParam
// =============================================================================

test("parseGroupParam — defaults to 'domain' when absent/empty", () => {
  assert.deepEqual(parseGroupParam(undefined), { group: "domain", error: null });
  assert.deepEqual(parseGroupParam(null), { group: "domain", error: null });
  assert.deepEqual(parseGroupParam(""), { group: "domain", error: null });
});

test("parseGroupParam — accepts every VALID_CITATION_GROUPS value, case-insensitively", () => {
  for (const g of VALID_CITATION_GROUPS) {
    assert.deepEqual(parseGroupParam(g), { group: g, error: null });
    assert.deepEqual(parseGroupParam(g.toUpperCase()), { group: g, error: null });
  }
});

test("parseGroupParam — rejects an invalid value with a named error", () => {
  const { group, error } = parseGroupParam("bogus");
  assert.equal(group, null);
  assert.match(error, /group must be one of/);
});

// =============================================================================
// aggregateCitations
// =============================================================================

test("aggregateCitations — empty input: zeroed totals, empty arrays", () => {
  const result = aggregateCitations([]);
  assert.deepEqual(result.totals, { citations: 0, distinct_domains: 0, distinct_urls: 0 });
  assert.deepEqual(result.domains, []);
  assert.deepEqual(result.urls, []);
  assert.deepEqual(result.content_types, []);
});

test("aggregateCitations — accepts a non-array gracefully", () => {
  assert.deepEqual(aggregateCitations(undefined).totals, { citations: 0, distinct_domains: 0, distinct_urls: 0 });
});

function citation({ domain, url, domain_type = null, citation_class = null, content_type = null, is_self = false }) {
  return { domain, url, domain_type, citation_class, content_type, is_self };
}

test("aggregateCitations — domain counts + share_pct, sorted by count desc then domain asc", () => {
  const rows = [
    citation({ domain: "a.com", url: "https://a.com/1" }),
    citation({ domain: "a.com", url: "https://a.com/2" }),
    citation({ domain: "b.com", url: "https://b.com/1" }),
    citation({ domain: "c.com", url: "https://c.com/1" }),
  ];
  const { domains, totals } = aggregateCitations(rows);
  assert.equal(totals.citations, 4);
  assert.equal(totals.distinct_domains, 3);
  assert.deepEqual(domains.map((d) => [d.domain, d.count, d.share_pct]), [
    ["a.com", 2, 50],
    ["b.com", 1, 25],
    ["c.com", 1, 25],
  ]);
});

test("aggregateCitations — url counts + share_pct, sorted by count desc then url asc", () => {
  const rows = [
    citation({ domain: "a.com", url: "https://a.com/popular" }),
    citation({ domain: "a.com", url: "https://a.com/popular" }),
    citation({ domain: "a.com", url: "https://a.com/rare" }),
  ];
  const { urls, totals } = aggregateCitations(rows);
  assert.equal(totals.distinct_urls, 2);
  assert.deepEqual(urls.map((u) => [u.url, u.count]), [
    ["https://a.com/popular", 2],
    ["https://a.com/rare", 1],
  ]);
});

test("aggregateCitations — is_self / domain_type / citation_class / content_type propagate onto the aggregated bucket (first non-null value wins when rows disagree)", () => {
  const rows = [
    citation({ domain: "a.com", url: "https://a.com/1", domain_type: null, citation_class: null, content_type: null, is_self: true }),
    citation({ domain: "a.com", url: "https://a.com/1", domain_type: "owned", citation_class: "owned", content_type: "homepage" }),
  ];
  const { domains, urls } = aggregateCitations(rows);
  assert.equal(domains[0].domain_type, "owned");
  assert.equal(domains[0].citation_class, "owned");
  assert.equal(domains[0].is_self, true);
  assert.equal(urls[0].content_type, "homepage");
  assert.equal(urls[0].domain_type, "owned");
});

test("aggregateCitations — content_type distribution: one row per OBSERVED type, count + share_pct, sorted count desc", () => {
  const rows = [
    citation({ domain: "a.com", url: "https://a.com/1", content_type: "article" }),
    citation({ domain: "a.com", url: "https://a.com/2", content_type: "article" }),
    citation({ domain: "b.com", url: "https://b.com/1", content_type: "product" }),
  ];
  const { content_types } = aggregateCitations(rows);
  assert.deepEqual(content_types.map((t) => [t.content_type, t.count, t.share_pct]), [
    ["article", 2, Math.round((2 / 3) * 1000) / 10],
    ["product", 1, Math.round((1 / 3) * 1000) / 10],
  ]);
});

test("aggregateCitations — a null content_type buckets as 'unclassified', not dropped and not crashing", () => {
  const rows = [citation({ domain: "a.com", url: "https://a.com/1", content_type: null })];
  const { content_types } = aggregateCitations(rows);
  assert.equal(content_types.length, 1);
  assert.equal(content_types[0].content_type, "unclassified");
  assert.equal(content_types[0].count, 1);
});

test("aggregateCitations — content_type leader is the single most-cited url of that type", () => {
  const rows = [
    citation({ domain: "a.com", url: "https://a.com/popular-article", content_type: "article" }),
    citation({ domain: "a.com", url: "https://a.com/popular-article", content_type: "article" }),
    citation({ domain: "b.com", url: "https://b.com/rare-article", content_type: "article" }),
  ];
  const { content_types } = aggregateCitations(rows);
  const articleType = content_types.find((t) => t.content_type === "article");
  assert.equal(articleType.leader_url, "https://a.com/popular-article");
  assert.equal(articleType.leader_domain, "a.com");
  assert.equal(articleType.leader_count, 2);
  assert.equal(articleType.count, 3, "the type's own count is every row of that type, not just the leader's");
});

test("aggregateCitations — a content_type leader tie keeps whichever url was encountered FIRST in the input (deterministic, documented)", () => {
  const rows = [
    citation({ domain: "a.com", url: "https://a.com/first", content_type: "article" }),
    citation({ domain: "b.com", url: "https://b.com/second", content_type: "article" }),
  ];
  const { content_types } = aggregateCitations(rows);
  assert.equal(content_types[0].leader_url, "https://a.com/first");
  assert.equal(content_types[0].leader_count, 1);
});
