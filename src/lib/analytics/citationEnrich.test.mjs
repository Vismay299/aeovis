import test from "node:test";
import assert from "node:assert/strict";
import {
  CONTENT_TYPES,
  DOMAIN_TYPES,
  CITATION_CLASSES,
  classifyContentType,
  classifyDomainType,
  classifyCitationClass,
  enrichCitations,
} from "./citationEnrich.js";

/**
 * P3a coverage. classifyContentType/classifyDomainType/classifyCitationClass
 * are pure and synchronous — no LLM, no DB. enrichCitations is the only
 * async export; every test that exercises it either proves heuristics alone
 * settle the batch (a llmJson stub that must not be called) or injects a
 * fully-controlled llmJson stub — never the real network client.
 *
 * Cache isolation: enrichCitations defaults to citationEnrich.js's shared
 * MODULE-LEVEL cache (deliberately shared across brands/calls in production —
 * see that module's comment). Any test whose llmJson stub can actually be
 * reached (content_type doesn't resolve via heuristics) passes its own fresh
 * `cache: new Map()` in deps, so it can never read a value some OTHER test
 * left behind in the shared cache, and never leaves one behind for a test
 * that runs after it. Tests that resolve purely via heuristics never touch
 * the cache at all and need no override.
 */

// =============================================================================
// classifyContentType — representative real-URL table
// =============================================================================

test("classifyContentType — representative URL table", () => {
  const cases = [
    // [url, title, expected]
    ["https://example.com/blog/best-crm-software-2026", null, "listicle"],
    ["https://example.com/top-10-project-management-tools", null, "listicle"],
    ["https://example.com/reviews/tools", "The 10 Best Project Management Tools", "listicle"],
    ["https://example.com/hubspot-vs-salesforce", null, "comparison"],
    ["https://example.com/pricing-comparison", null, "comparison"],
    ["https://example.com/versus/zoho", null, "comparison"],
    ["https://example.com/salesforce-alternatives", null, "alternative"],
    ["https://example.com/best-alternative-to-hubspot", null, "listicle"], // "best" wins — listicle is checked first
    ["https://www.reddit.com/r/saas/comments/abc123/thoughts_on_hubspot", null, "forum"],
    ["https://quora.com/What-is-the-best-CRM", "What is the best CRM?", "listicle"], // "best" in title still wins over the forum host
    ["https://xyzforum.io/topic/42", null, "forum"], // generic "forum" HOST substring (not path — content_type forum is host-based)
    ["https://stackoverflow.com/questions/123/how-to", null, "forum"],
    ["https://www.youtube.com/watch?v=xyz", "Product demo", "social"],
    ["https://twitter.com/someuser/status/123456", null, "social"],
    ["https://x.com/someuser/status/123456", null, "social"],
    ["https://acme.com/", "Acme — Home", "homepage"],
    ["https://acme.com", null, "homepage"],
    ["https://shop.example.com/category/shoes", null, "category"],
    ["https://shop.example.com/collections/summer", null, "category"],
    ["https://shop.example.com/c/electronics", null, "category"],
    ["https://shop.example.com/products/acme-widget", null, "product"],
    ["https://shop.example.com/p/123", null, "product"],
    ["https://shop.example.com/item/456", null, "product"],
    ["https://example.com/blog/how-we-built-this", null, "article"],
    ["https://example.com/articles/2026/07/24/launch", null, "article"],
    ["https://example.com/guides/getting-started", null, "article"],
    ["https://example.com/how-to-choose-a-crm", null, "article"],
    ["https://en.wikipedia.org/wiki/Customer_relationship_management", null, null], // no pattern matches -> defer to LLM
    ["https://example.com/some-random-slug-xyz", null, null], // path depth 1, no keyword -> defer to LLM
  ];

  for (const [url, title, expected] of cases) {
    assert.equal(classifyContentType(url, title), expected, `${url} (title=${title}) -> expected ${expected}`);
  }
});

test("classifyContentType — malformed/empty input never throws", () => {
  assert.equal(classifyContentType("", ""), "homepage");
  assert.equal(classifyContentType(null, null), "homepage");
  assert.equal(classifyContentType("not a url", null), "homepage");
});

// =============================================================================
// classifyDomainType — representative real-domain table
// =============================================================================

test("classifyDomainType — representative domain table", () => {
  const brandCtx = { brandDomain: "acme.com", competitorDomains: ["rivalco.com"] };

  const cases = [
    // [domain, expected]
    ["acme.com", "owned"],
    ["shop.acme.com", "owned"], // subdomain of the brand
    ["www.acme.com", "owned"],
    ["rivalco.com", "competitor"],
    ["www.rivalco.com", "competitor"],
    ["pricing.rivalco.com", "competitor"],
    ["reddit.com", "ugc"],
    ["www.quora.com", "ugc"],
    ["stackoverflow.com", "ugc"],
    ["trustpilot.com", "ugc"],
    ["youtube.com", "social"],
    ["twitter.com", "social"],
    ["x.com", "social"],
    ["linkedin.com", "social"],
    ["wikipedia.org", "reference"],
    ["en.wikipedia.org", "reference"],
    ["g2.com", "reference"],
    ["capterra.com", "reference"],
    ["gartner.com", "reference"],
    ["mit.edu", "institutional"],
    ["iitb.ac.in", "institutional"],
    ["india.gov.in", "institutional"],
    ["irs.gov", "institutional"],
    ["mozilla.org", "institutional"], // curated major-org allowlist
    ["techcrunch.com", "editorial"],
    ["forbes.com", "editorial"],
    ["livemint.com", "editorial"], // India-first editorial coverage
    ["indianexpress.com", "editorial"],
    ["some-random-saas-company.io", "corporate"], // exhaustive fallback
    ["", "corporate"],
  ];

  for (const [domain, expected] of cases) {
    assert.equal(classifyDomainType(domain, brandCtx), expected, `${domain} -> expected ${expected}`);
  }
});

test("classifyDomainType — owned takes priority over every registry (a brand that happens to BE a reference/social domain still resolves owned)", () => {
  assert.equal(classifyDomainType("wikipedia.org", { brandDomain: "wikipedia.org" }), "owned");
});

test("classifyDomainType — no brandDomain/competitorDomains given: still resolves via the static registries", () => {
  assert.equal(classifyDomainType("reddit.com", {}), "ugc");
  assert.equal(classifyDomainType("reddit.com"), "ugc");
});

test("classifyDomainType — a generic domain that merely contains a competitor's name as a substring of an unrelated word does not false-positive without domain-boundary matching", () => {
  // "rivalco.com" is tracked; "notrivalco.com" is a DIFFERENT domain and
  // domainMatches requires exact-or-subdomain, not substring.
  assert.equal(classifyDomainType("notrivalco.com", { competitorDomains: ["rivalco.com"] }), "corporate");
});

// =============================================================================
// classifyCitationClass
// =============================================================================

test("classifyCitationClass — the full DOMAIN_TYPES -> CITATION_CLASSES mapping", () => {
  const expected = {
    owned: "owned",
    social: "social",
    ugc: "social",
    editorial: "earned",
    corporate: "earned",
    reference: "earned",
    competitor: "earned",
    institutional: "earned",
  };
  for (const domainType of DOMAIN_TYPES) {
    assert.equal(classifyCitationClass(domainType), expected[domainType], domainType);
  }
});

test("CONTENT_TYPES / DOMAIN_TYPES / CITATION_CLASSES — match migration 005's documented vocabularies exactly", () => {
  assert.deepEqual(CONTENT_TYPES, [
    "listicle", "comparison", "product", "social", "forum", "article",
    "homepage", "category", "alternative", "other",
  ]);
  assert.deepEqual(DOMAIN_TYPES, [
    "editorial", "corporate", "reference", "competitor", "ugc", "social",
    "institutional", "owned",
  ]);
  assert.deepEqual(CITATION_CLASSES, ["earned", "owned", "social"]);
});

// =============================================================================
// enrichCitations — orchestration: heuristics, LLM fallback + batching,
// caching, competitor-domain resolution, fail-loud-soft.
// =============================================================================

test("enrichCitations — empty input is a no-op, never calls the LLM", async () => {
  let called = false;
  const result = await enrichCitations([], {}, { llmJson: async () => { called = true; return []; } });
  assert.deepEqual(result, []);
  assert.equal(called, false);
});

test("enrichCitations — fully heuristic-resolvable batch never calls the LLM", async () => {
  let llmCalls = 0;
  const rows = [
    { url: "https://acme.com/", domain: "acme.com" },
    { url: "https://blog.example.com/how-to-pick-a-crm", domain: "blog.example.com" },
    { url: "https://reddit.com/r/saas/comments/1", domain: "reddit.com" },
  ];
  const out = await enrichCitations(rows, { brandDomain: "acme.com" }, {
    llmJson: async () => { llmCalls++; return []; },
  });

  assert.equal(llmCalls, 0);
  assert.equal(out.length, 3);
  assert.equal(out[0].content_type, "homepage");
  assert.equal(out[0].domain_type, "owned");
  assert.equal(out[0].citation_class, "owned");
  assert.equal(out[1].content_type, "article");
  assert.equal(out[1].domain_type, "corporate");
  assert.equal(out[1].citation_class, "earned");
  assert.equal(out[2].content_type, "forum");
  assert.equal(out[2].domain_type, "ugc");
  assert.equal(out[2].citation_class, "social");
});

test("enrichCitations — does not mutate its input rows", async () => {
  const rows = [{ url: "https://acme.com/", domain: "acme.com" }];
  const snapshot = JSON.stringify(rows);
  await enrichCitations(rows, {}, { llmJson: async () => [] });
  assert.equal(JSON.stringify(rows), snapshot);
});

test("enrichCitations — batches exactly ONE llmJson call for multiple unresolved rows, applies the response by index", async () => {
  let llmCalls = 0;
  const rows = [
    { url: "https://a.example.com/some-page", domain: "a.example.com", title: "" },
    { url: "https://b.example.com/other-page", domain: "b.example.com", title: "" },
  ];
  const out = await enrichCitations(rows, {}, {
    llmJson: async () => {
      llmCalls++;
      return ["product", "article"];
    },
    cache: new Map(), // isolated — see the file header
  });

  assert.equal(llmCalls, 1, "must be exactly one batched call, not one per row");
  assert.equal(out[0].content_type, "product");
  assert.equal(out[1].content_type, "article");
});

// REGRESSION (found by a live dry-run over 3667 real citations): llmJson sends
// jsonMode:true, and JSON-mode implementations generally require a top-level
// OBJECT, so the model wrapped the array and the old bare `Array.isArray`
// check rejected EVERY batch — silently degrading ~20% of real URLs to "other".
// The response shape must be coerced, not trusted.
test("enrichCitations — accepts a {types:[...]} JSON-mode wrapper (not just a bare array)", async () => {
  const rows = [
    { url: "https://a.example.com/some-page", domain: "a.example.com", title: "" },
    { url: "https://b.example.com/other-page", domain: "b.example.com", title: "" },
  ];
  const out = await enrichCitations(rows, {}, {
    llmJson: async () => ({ types: ["product", "article"] }),
    cache: new Map(),
  });
  assert.equal(out[0].content_type, "product");
  assert.equal(out[1].content_type, "article");
});

test("enrichCitations — accepts any single-array wrapper key, not just `types`", async () => {
  const rows = [{ url: "https://a.example.com/some-page", domain: "a.example.com", title: "" }];
  const out = await enrichCitations(rows, {}, {
    llmJson: async () => ({ results: ["comparison"] }),
    cache: new Map(),
  });
  assert.equal(out[0].content_type, "comparison");
});

test("enrichCitations — a genuinely unusable LLM shape still falls back to \"other\", never null", async () => {
  const rows = [{ url: "https://a.example.com/some-page", domain: "a.example.com", title: "" }];
  const out = await enrichCitations(rows, {}, {
    llmJson: async () => ({ nope: "not an array" }),
    cache: new Map(),
  });
  assert.equal(out[0].content_type, "other");
});

test("enrichCitations — the batch prompt asks for the JSON-mode-safe object shape", async () => {
  let seen = "";
  await enrichCitations(
    [{ url: "https://a.example.com/some-page", domain: "a.example.com", title: "" }],
    {},
    { llmJson: async (p) => { seen = p; return { types: ["article"] }; }, cache: new Map() }
  );
  assert.match(seen, /\{"types"/, "prompt must request an object wrapper, not a bare array");
});

test("enrichCitations — dedupes the LLM batch by (domain, path-shape): two numerically-shaped URLs on the same domain share one resolution", async () => {
  let llmCalls = 0;
  let lastPromptItemCount = null;
  const rows = [
    { url: "https://shop.example.com/listing/1001", domain: "shop.example.com", title: "" },
    { url: "https://shop.example.com/listing/2002", domain: "shop.example.com", title: "" },
  ];
  const out = await enrichCitations(rows, {}, {
    llmJson: async (prompt) => {
      llmCalls++;
      lastPromptItemCount = (prompt.match(/^\d+\. domain=/gm) || []).length;
      return ["product"];
    },
    cache: new Map(), // isolated — see the file header
  });

  assert.equal(llmCalls, 1);
  assert.equal(lastPromptItemCount, 1, "both rows share one (domain, path-shape) cache key -> one prompt line");
  assert.equal(out[0].content_type, "product");
  assert.equal(out[1].content_type, "product");
});

test("enrichCitations — in-process cache: a second call with the SAME cache reuses the first call's LLM resolution, no second call", async () => {
  let llmCalls = 0;
  const cache = new Map();
  const llmJsonStub = async () => {
    llmCalls++;
    return ["article"];
  };

  const first = await enrichCitations(
    [{ url: "https://example.com/mystery-page", domain: "example.com", title: "" }],
    {},
    { llmJson: llmJsonStub, cache }
  );
  const second = await enrichCitations(
    [{ url: "https://example.com/mystery-page", domain: "example.com", title: "" }],
    {},
    { llmJson: llmJsonStub, cache }
  );

  assert.equal(llmCalls, 1, "the second call must reuse the cache, not call the LLM again");
  assert.equal(first[0].content_type, "article");
  assert.equal(second[0].content_type, "article");
});

test("enrichCitations — fail-loud-soft: an LLM throw never propagates, unresolved rows fall back to \"other\"", async () => {
  const rows = [{ url: "https://example.com/mystery-page", domain: "example.com", title: "" }];
  const out = await enrichCitations(rows, {}, {
    llmJson: async () => { throw new Error("network down"); },
    cache: new Map(), // isolated — see the file header
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].content_type, "other");
  // domain_type/citation_class are heuristic-only and must still resolve normally.
  assert.equal(out[0].domain_type, "corporate");
  assert.equal(out[0].citation_class, "earned");
});

test("enrichCitations — a non-array LLM response falls back to \"other\" without throwing", async () => {
  const rows = [{ url: "https://example.com/mystery-page", domain: "example.com", title: "" }];
  const out = await enrichCitations(rows, {}, {
    llmJson: async () => ({ not: "an array" }),
    cache: new Map(), // isolated — see the file header
  });
  assert.equal(out[0].content_type, "other");
});

test("enrichCitations — an out-of-vocabulary LLM value for one item falls back to \"other\" for just that item", async () => {
  const rows = [
    { url: "https://a.example.com/x", domain: "a.example.com", title: "" },
    { url: "https://b.example.com/y", domain: "b.example.com", title: "" },
  ];
  const out = await enrichCitations(rows, {}, {
    llmJson: async () => ["product", "not-a-real-content-type"],
    cache: new Map(), // isolated — see the file header
  });
  assert.equal(out[0].content_type, "product");
  assert.equal(out[1].content_type, "other");
});

test("enrichCitations — resolves competitor domain_type from competitorNames (fuzzy name match) when no exact competitorDomains are given", async () => {
  const rows = [{ url: "https://rivalco.com/blog/pricing-guide", domain: "rivalco.com", title: "" }];
  const out = await enrichCitations(
    rows,
    { brandDomain: "acme.com", competitorNames: ["RivalCo"] },
    { llmJson: async () => { throw new Error("must not be needed — content_type resolves via heuristics"); } }
  );
  assert.equal(out[0].domain_type, "competitor");
  assert.equal(out[0].citation_class, "earned");
  assert.equal(out[0].content_type, "article");
});

test("enrichCitations — exact competitorDomains, when given, take priority over fuzzy competitorNames matching", async () => {
  const rows = [{ url: "https://totallyunrelated.com/blog/x", domain: "totallyunrelated.com", title: "" }];
  const out = await enrichCitations(
    rows,
    { brandDomain: "acme.com", competitorNames: ["RivalCo"], competitorDomains: ["totallyunrelated.com"] },
    { llmJson: async () => { throw new Error("not needed"); } }
  );
  assert.equal(out[0].domain_type, "competitor");
});

test("enrichCitations — llmTimeoutMs/stats are forwarded to llmJson's options", async () => {
  let receivedOptions = null;
  const rows = [{ url: "https://example.com/mystery-page", domain: "example.com", title: "" }];
  const stats = { cost: 0, tokens: 0 };
  await enrichCitations(rows, { llmTimeoutMs: 5000, stats }, {
    llmJson: async (_prompt, options) => {
      receivedOptions = options;
      return ["other"];
    },
    cache: new Map(), // isolated — see the file header
  });
  assert.equal(receivedOptions.timeout, 5000);
  assert.equal(receivedOptions.stats, stats);
});
