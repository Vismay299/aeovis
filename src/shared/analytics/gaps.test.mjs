import test from "node:test";
import assert from "node:assert/strict";
import { joinCitationsWithResultBrands, computeDomainGaps, computeUrlGaps } from "./gaps.js";

/**
 * P3a coverage. Pure, no DB/LLM — every test builds citations/result_brands
 * fixtures directly (the same row shapes db/analytics.js's getCitationsForBrand
 * / getResultBrandsForBrand return) and exercises the join + gap_score math.
 */

// =============================================================================
// joinCitationsWithResultBrands
// =============================================================================

test("joinCitationsWithResultBrands — attaches self_mentioned/rival_names from the SAME result_id's result_brands rows", () => {
  const citations = [
    { domain: "third-party.com", url: "https://third-party.com/a", domain_type: "editorial", result_id: "r1", is_self: false },
  ];
  const resultBrands = [
    { result_id: "r1", name: "Acme", is_self: true, mentioned: false },
    { result_id: "r1", name: "RivalCo", is_self: false, mentioned: true },
    { result_id: "r1", name: "OtherCo", is_self: false, mentioned: false }, // not mentioned -> excluded from rival_names
  ];

  const joined = joinCitationsWithResultBrands(citations, resultBrands);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].self_mentioned, false);
  assert.deepEqual(joined[0].rival_names, ["RivalCo"]);
  assert.equal(joined[0].domain, "third-party.com");
  assert.equal(joined[0].domain_type, "editorial");
  assert.equal(joined[0].is_self, false);
});

test("joinCitationsWithResultBrands — self mentioned in the same answer sets self_mentioned true", () => {
  const citations = [{ domain: "third-party.com", url: "https://third-party.com/a", result_id: "r1", is_self: false }];
  const resultBrands = [
    { result_id: "r1", name: "Acme", is_self: true, mentioned: true },
    { result_id: "r1", name: "RivalCo", is_self: false, mentioned: true },
  ];
  const joined = joinCitationsWithResultBrands(citations, resultBrands);
  assert.equal(joined[0].self_mentioned, true);
  assert.deepEqual(joined[0].rival_names, ["RivalCo"]);
});

test("joinCitationsWithResultBrands — a citation whose result_id has no result_brands rows at all still passes through, with no rival/self signal", () => {
  const citations = [{ domain: "third-party.com", url: "https://third-party.com/a", result_id: "orphan-result" }];
  const joined = joinCitationsWithResultBrands(citations, []);
  assert.equal(joined.length, 1);
  assert.equal(joined[0].self_mentioned, false);
  assert.deepEqual(joined[0].rival_names, []);
});

test("joinCitationsWithResultBrands — drops citation rows missing domain or result_id; empty-safe", () => {
  const citations = [
    { url: "https://x.com/a", result_id: "r1" }, // no domain
    { domain: "x.com", url: "https://x.com/a" }, // no result_id
    { domain: "x.com", url: "https://x.com/a", result_id: "r1" }, // valid
  ];
  const joined = joinCitationsWithResultBrands(citations, []);
  assert.equal(joined.length, 1);
  assert.deepEqual(joinCitationsWithResultBrands([], []), []);
  assert.deepEqual(joinCitationsWithResultBrands(undefined, undefined), []);
});

test("joinCitationsWithResultBrands — an unmentioned result_brands row (mentioned:false) never contributes to rival_names or self_mentioned, even for is_self rows", () => {
  const citations = [{ domain: "x.com", url: "https://x.com/a", result_id: "r1" }];
  const resultBrands = [
    { result_id: "r1", name: "Acme", is_self: true, mentioned: false },
    { result_id: "r1", name: "RivalCo", is_self: false, mentioned: false },
  ];
  const joined = joinCitationsWithResultBrands(citations, resultBrands);
  assert.equal(joined[0].self_mentioned, false);
  assert.deepEqual(joined[0].rival_names, []);
});

// =============================================================================
// computeDomainGaps / computeUrlGaps — gap_score math
// =============================================================================

function row({ domain, url = `https://${domain}/x`, resultId, isSelf = false, domainType = "editorial", selfMentioned = false, rivalNames = [] }) {
  return { domain, url, domain_type: domainType, result_id: resultId, is_self: isSelf, self_mentioned: selfMentioned, rival_names: rivalNames };
}

test("computeDomainGaps — empty input returns []", () => {
  assert.deepEqual(computeDomainGaps([]), []);
  assert.deepEqual(computeDomainGaps(undefined), []);
});

test("computeDomainGaps — the zero-rival case: no rival ever mentioned anywhere -> no domain can qualify, returns [] without throwing", () => {
  const rows = [
    row({ domain: "a.com", resultId: "r1", selfMentioned: true, rivalNames: [] }),
    row({ domain: "b.com", resultId: "r2", selfMentioned: false, rivalNames: [] }),
  ];
  assert.deepEqual(computeDomainGaps(rows), []);
});

test("computeDomainGaps — a domain cited alongside a rival and never alongside self qualifies, gap_score=100 when it's the only candidate", () => {
  const rows = [row({ domain: "gap.com", resultId: "r1", selfMentioned: false, rivalNames: ["RivalCo"] })];
  const gaps = computeDomainGaps(rows);
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0].domain, "gap.com");
  assert.equal(gaps[0].rival_count, 1);
  assert.deepEqual(gaps[0].rival_names, ["RivalCo"]);
  assert.equal(gaps[0].citation_rate, 100); // 1/1 distinct results
  assert.equal(gaps[0].retrieval_share_pct, 100); // 1/1 citation rows
  assert.equal(gaps[0].gap_score, 100);
});

test("computeDomainGaps — a domain that ALSO co-occurs with self at least once is excluded, even if a rival co-occurs elsewhere", () => {
  const rows = [
    row({ domain: "notagap.com", resultId: "r1", selfMentioned: false, rivalNames: ["RivalCo"] }),
    row({ domain: "notagap.com", resultId: "r2", selfMentioned: true, rivalNames: [] }),
  ];
  assert.deepEqual(computeDomainGaps(rows), []);
});

test("computeDomainGaps — your own domain (is_self or domain_type='owned') is never a gap candidate, even with rival co-occurrence", () => {
  const viaIsSelf = [row({ domain: "acme.com", resultId: "r1", isSelf: true, rivalNames: ["RivalCo"] })];
  const viaDomainType = [row({ domain: "acme.com", resultId: "r1", domainType: "owned", rivalNames: ["RivalCo"] })];
  assert.deepEqual(computeDomainGaps(viaIsSelf), []);
  assert.deepEqual(computeDomainGaps(viaDomainType), []);
});

test("computeDomainGaps — rival_count counts DISTINCT rival names across every citing result, not row count", () => {
  const rows = [
    row({ domain: "gap.com", resultId: "r1", rivalNames: ["RivalA", "RivalB"] }),
    row({ domain: "gap.com", resultId: "r2", rivalNames: ["RivalA"] }), // RivalA repeated -> still counts once
  ];
  const gaps = computeDomainGaps(rows);
  assert.equal(gaps[0].rival_count, 2);
  assert.deepEqual(gaps[0].rival_names, ["RivalA", "RivalB"]); // sorted
});

test("computeDomainGaps — retrieval_share_pct counts citation ROWS (retrieval events), citation_rate counts DISTINCT results", () => {
  const rows = [
    // gap.com cited twice in the SAME result (r1) plus once in r2 -> 3 citation rows, 2 distinct results.
    row({ domain: "gap.com", resultId: "r1", rivalNames: ["RivalCo"] }),
    row({ domain: "gap.com", resultId: "r1", rivalNames: ["RivalCo"] }),
    row({ domain: "gap.com", resultId: "r2", rivalNames: ["RivalCo"] }),
    // a totally unrelated result with no rival mention, contributing to the totals' denominators.
    row({ domain: "other.com", resultId: "r3", rivalNames: [] }),
  ];
  const gaps = computeDomainGaps(rows);
  const gapRow = gaps.find((g) => g.domain === "gap.com");
  assert.equal(gapRow.retrieval_share_pct, 75); // 3 of 4 total citation rows
  assert.equal(gapRow.citation_rate, Math.round((2 / 3) * 1000) / 10); // 2 of 3 distinct results
});

test("computeDomainGaps — ties: identical raw scores tie at the same gap_score and sort alphabetically by domain", () => {
  const rows = [
    row({ domain: "zeta.com", resultId: "r1", rivalNames: ["RivalCo"] }),
    row({ domain: "alpha.com", resultId: "r2", rivalNames: ["RivalCo"] }),
  ];
  const gaps = computeDomainGaps(rows);
  assert.equal(gaps.length, 2);
  assert.equal(gaps[0].gap_score, gaps[1].gap_score);
  assert.equal(gaps[0].gap_score, 100);
  assert.deepEqual(gaps.map((g) => g.domain), ["alpha.com", "zeta.com"]);
});

test("computeDomainGaps — sorted gap_score desc; the domain with more retrieval share AND more rival presence scores higher", () => {
  const rows = [
    // big.com: cited across 3 distinct results, 2 distinct rivals.
    row({ domain: "big.com", resultId: "r1", rivalNames: ["RivalA", "RivalB"] }),
    row({ domain: "big.com", resultId: "r2", rivalNames: ["RivalA"] }),
    row({ domain: "big.com", resultId: "r3", rivalNames: ["RivalB"] }),
    // small.com: cited in exactly 1 result, 1 rival.
    row({ domain: "small.com", resultId: "r4", rivalNames: ["RivalA"] }),
  ];
  const gaps = computeDomainGaps(rows);
  assert.deepEqual(gaps.map((g) => g.domain), ["big.com", "small.com"]);
  assert.equal(gaps[0].gap_score, 100);
  assert.ok(gaps[1].gap_score < gaps[0].gap_score);
});

test("computeDomainGaps — selfBrandKey, when given, is stamped onto every row as `brand`; omitted entirely otherwise", () => {
  const rows = [row({ domain: "gap.com", resultId: "r1", rivalNames: ["RivalCo"] })];
  const withKey = computeDomainGaps(rows, { selfBrandKey: "acme.com" });
  assert.equal(withKey[0].brand, "acme.com");

  const withoutKey = computeDomainGaps(rows);
  assert.equal("brand" in withoutKey[0], false);
});

test("computeDomainGaps — gap rows report the enriched domain_type when present", () => {
  const rows = [row({ domain: "gap.com", resultId: "r1", domainType: "ugc", rivalNames: ["RivalCo"] })];
  assert.equal(computeDomainGaps(rows)[0].domain_type, "ugc");
});

// -----------------------------------------------------------------------
// computeUrlGaps — same math, url granularity (spot-check; full formula
// coverage lives in the computeDomainGaps tests above, since both share the
// same core).
// -----------------------------------------------------------------------

test("computeUrlGaps — groups by url (not domain), still carries domain alongside it", () => {
  const rows = [
    { domain: "gap.com", url: "https://gap.com/page-a", domain_type: "editorial", result_id: "r1", is_self: false, self_mentioned: false, rival_names: ["RivalCo"] },
    { domain: "gap.com", url: "https://gap.com/page-b", domain_type: "editorial", result_id: "r2", is_self: false, self_mentioned: false, rival_names: ["RivalCo"] },
  ];
  const gaps = computeUrlGaps(rows);
  assert.equal(gaps.length, 2, "two distinct URLs on the same domain are two separate gap rows");
  assert.ok(gaps.every((g) => g.domain === "gap.com"));
  assert.deepEqual(gaps.map((g) => g.url).sort(), ["https://gap.com/page-a", "https://gap.com/page-b"]);
});

test("computeUrlGaps — the zero-rival case and self-domain exclusion apply identically to url-level gaps", () => {
  assert.deepEqual(computeUrlGaps([row({ domain: "a.com", resultId: "r1", rivalNames: [] })]), []);
  assert.deepEqual(computeUrlGaps([row({ domain: "acme.com", resultId: "r1", isSelf: true, rivalNames: ["RivalCo"] })]), []);
});
