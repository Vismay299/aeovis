import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BACKLINKS_SUBFOLDER_FILTER_CONDITIONS,
  parseResearchTarget,
  RESEARCH_SCOPES,
  RESEARCH_SCOPE_FILTER_SLOTS,
} from "../../researchScope.ts";
import {
  buildBacklinksScopeFilter,
  buildRankedKeywordsScopeFilter,
  buildRelevantPagesScopeFilter,
} from "./researchScopeFilters.ts";

function target(
  input: string,
  scope: Parameters<typeof parseResearchTarget>[1],
) {
  const parsed = parseResearchTarget(input, scope);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.target;
}

describe("buildRankedKeywordsScopeFilter", () => {
  it("pins the exact hostname (plus www) for domain scope", () => {
    const filter = buildRankedKeywordsScopeFilter(
      target("example.com", "domain"),
    );
    assert.deepEqual(filter.clauses, [
      [
        "ranked_serp_element.serp_item.domain",
        "in",
        ["example.com", "www.example.com"],
      ],
    ]);
    assert.equal(filter.conditionCount, 1);
  });

  it("matches the subfolder, its children, and query variants — not siblings", () => {
    const filter = buildRankedKeywordsScopeFilter(
      target("example.com/blog", "subfolder"),
    );
    assert.deepEqual(filter.clauses[1], [
      ["ranked_serp_element.serp_item.relative_url", "=", "/blog"],
      "or",
      ["ranked_serp_element.serp_item.relative_url", "like", "/blog/%"],
      "or",
      ["ranked_serp_element.serp_item.relative_url", "like", "/blog?%"],
    ]);
    assert.equal(filter.conditionCount, 4);
  });

  it("escapes like wildcards in the path but not equality values", () => {
    const filter = buildRankedKeywordsScopeFilter(
      target("example.com/100%25_deals", "subfolder"),
    );
    assert.deepEqual(filter.clauses[1], [
      ["ranked_serp_element.serp_item.relative_url", "=", "/100%25_deals"],
      "or",
      [
        "ranked_serp_element.serp_item.relative_url",
        "like",
        "/100\\%25\\_deals/%",
      ],
      "or",
      [
        "ranked_serp_element.serp_item.relative_url",
        "like",
        "/100\\%25\\_deals?%",
      ],
    ]);
  });

  it("covers trailing-slash and query variants for exact_url scope", () => {
    const filter = buildRankedKeywordsScopeFilter(
      target("example.com/pricing", "exact_url"),
    );
    assert.deepEqual(filter.clauses[1], [
      [
        "ranked_serp_element.serp_item.relative_url",
        "in",
        ["/pricing", "/pricing/"],
      ],
      "or",
      ["ranked_serp_element.serp_item.relative_url", "like", "/pricing?%"],
      "or",
      ["ranked_serp_element.serp_item.relative_url", "like", "/pricing/?%"],
    ]);
  });
});

describe("buildRelevantPagesScopeFilter", () => {
  it("pins both host variants for domain scope", () => {
    const filter = buildRelevantPagesScopeFilter(
      target("example.com", "domain"),
    );
    assert.deepEqual(filter.clauses, [
      [
        ["page_address", "like", "%://example.com/%"],
        "or",
        ["page_address", "like", "%://www.example.com/%"],
      ],
    ]);
    assert.equal(filter.conditionCount, 2);
  });

  it("builds absolute prefix patterns for subfolder scope", () => {
    const filter = buildRelevantPagesScopeFilter(
      target("example.com/blog", "subfolder"),
    );
    assert.deepEqual(filter.clauses[0], [
      ["page_address", "like", "%://example.com/blog"],
      "or",
      ["page_address", "like", "%://example.com/blog/%"],
      "or",
      ["page_address", "like", "%://www.example.com/blog"],
      "or",
      ["page_address", "like", "%://www.example.com/blog/%"],
    ]);
    assert.equal(filter.conditionCount, 4);
  });
});

it("keeps the shared filter-slot constants in sync with the built clauses", () => {
  for (const scope of RESEARCH_SCOPES) {
    const parsed = target("example.com/blog", scope);
    assert.equal(
      buildRankedKeywordsScopeFilter(parsed).conditionCount,
      RESEARCH_SCOPE_FILTER_SLOTS.keywords[parsed.scope],
    );
    assert.equal(
      buildRelevantPagesScopeFilter(parsed).conditionCount,
      RESEARCH_SCOPE_FILTER_SLOTS.pages[parsed.scope],
    );
  }
  assert.equal(
    buildBacklinksScopeFilter("url_to", {
      scope: "subfolder",
      apiTarget: "example.com",
      path: "/blog",
    }).conditionCount,
    BACKLINKS_SUBFOLDER_FILTER_CONDITIONS,
  );
});
