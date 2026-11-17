import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  countFilterConditions,
  toBacklinksFiltersPayload,
  type BacklinksTabFilterValues,
  EMPTY_BACKLINKS_FILTERS,
} from "../../shared/backlinks.ts";
import {
  buildBacklinksRowsApiFilters,
  buildReferringDomainsApiFilters,
  buildTopPagesApiFilters,
} from "./backlinksApiFilters.ts";

describe("buildBacklinksRowsApiFilters", () => {
  it("ORs include terms in one group and ANDs everything else", () => {
    assert.deepEqual(
      buildBacklinksRowsApiFilters({
        include: "blog, news",
        exclude: "spam",
        minDomainRank: 30,
        linkType: "dofollow",
        hideLost: true,
      }),
      [
        [["url_from", "ilike", "%blog%"], "or", ["url_from", "ilike", "%news%"]],
        "and",
        ["url_from", "not_ilike", "%spam%"],
        "and",
        ["domain_from_rank", ">=", 30],
        "and",
        ["dofollow", "=", true],
        "and",
        ["is_lost", "=", false],
      ],
    );
  });

  it("emits a single include term as a plain condition", () => {
    assert.deepEqual(buildBacklinksRowsApiFilters({ include: "blog" }), [
      ["url_from", "ilike", "%blog%"],
    ]);
  });

  it("throws when the condition budget is exceeded", () => {
    assert.throws(
      () =>
        buildBacklinksRowsApiFilters({
          include: "a, b, c, d, e",
          exclude: "f, g, h, i",
        }),
      /Too many filter conditions/,
    );
  });
});

describe("per-endpoint filter builders", () => {
  it("referring domains uses its own field names", () => {
    assert.deepEqual(
      buildReferringDomainsApiFilters({
        include: "edu",
        minBacklinks: 5,
        maxSpamScore: 30,
      }),
      [
        ["domain", "ilike", "%edu%"],
        "and",
        ["backlinks", ">=", 5],
        "and",
        ["backlinks_spam_score", "<=", 30],
      ],
    );
  });

  it("top pages uses its own field names", () => {
    assert.deepEqual(
      buildTopPagesApiFilters({ include: "/blog", minReferringDomains: 2 }),
      [
        ["url", "ilike", "%/blog%"],
        "and",
        ["referring_domains", ">=", 2],
      ],
    );
  });
});

describe("client condition count vs server condition budget", () => {
  function serverConditionCount(values: BacklinksTabFilterValues): number {
    const expressions = buildBacklinksRowsApiFilters(
      toBacklinksFiltersPayload(values),
    );
    let count = 0;
    for (const expression of expressions) {
      if (expression === "and") continue;
      // An include OR-group contains nested clauses and "or" connectors.
      count +=
        Array.isArray(expression) && Array.isArray(expression[0])
          ? Math.ceil(expression.length / 2)
          : 1;
    }
    return count;
  }

  const cases: Array<[string, BacklinksTabFilterValues]> = [
    [
      "terms and ranges",
      {
        ...EMPTY_BACKLINKS_FILTERS,
        include: "blog, news",
        exclude: "spam",
        minDomainRank: "30",
        maxSpamScore: "50",
      },
    ],
    [
      "toggles",
      {
        ...EMPTY_BACKLINKS_FILTERS,
        linkType: "nofollow",
        hideLost: "true",
        hideBroken: "true",
      },
    ],
    [
      "everything",
      {
        ...EMPTY_BACKLINKS_FILTERS,
        include: "a",
        exclude: "b",
        minDomainRank: "1",
        maxDomainRank: "90",
        minLinkAuthority: "2",
        linkType: "dofollow",
        hideLost: "true",
      },
    ],
  ];

  for (const [name, values] of cases) {
    it(`matches for ${name}`, () => {
      assert.equal(serverConditionCount(values), countFilterConditions(values));
    });
  }
});
