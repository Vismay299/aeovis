import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDomainFiltersClearSearchUpdate,
  buildDomainResearchHref,
  buildKeywordsSearchUpdate,
  buildPagesSearchUpdate,
  competitorsToTable,
  countKeywordFilterConditions,
  countPageFilterConditions,
  getDomainRouteState,
  getDefaultSortOrder,
  keywordsToTable,
  pagesToTable,
  EMPTY_DOMAIN_FILTERS,
  EMPTY_PAGE_FILTERS,
} from "./domain.ts";
import { toScopeSearchParam } from "./researchScope.ts";

describe("research scope resolution (ported from OpenSEO)", () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ domain: "example.com" }, "subdomains"],
    [{ domain: "example.com/blog" }, "subfolder"],
    [{ domain: "example.com", subdomains: true }, "subdomains"],
    [{ domain: "example.com", subdomains: false }, "domain"],
    [{ domain: "example.com", scope: "subfolder" }, "subdomains"],
  ];

  for (const [search, expectedScope] of cases) {
    it(`derives scope from input ${JSON.stringify(search)} -> ${expectedScope}`, () => {
      const state = getDomainRouteState(search as any);
      assert.equal(state.scope, expectedScope);
    });
  }

  it("omits the scope param when it matches the input's default", () => {
    assert.equal(toScopeSearchParam("example.com", "subdomains"), undefined);
    assert.equal(toScopeSearchParam("example.com", "domain"), "domain");
    assert.equal(toScopeSearchParam("example.com/blog", "subfolder"), undefined);
    assert.equal(toScopeSearchParam("example.com/blog", "exact_url"), "exact_url");
  });
});

describe("getDomainRouteState location and markets (ported from OpenSEO)", () => {
  const project = { locationCode: 2704, languageCode: "vi" };

  it("uses the Labs-backed project market unless URL names a location", () => {
    const defaultState = getDomainRouteState({}, project);
    assert.equal(defaultState.defaultLocationCode, 2704);
    assert.equal(defaultState.locationCode, 2704);
    assert.equal(defaultState.sentLocationCode, undefined);

    const explicitState = getDomainRouteState({ loc: 2840 }, project);
    assert.equal(explicitState.defaultLocationCode, 2704);
    assert.equal(explicitState.locationCode, 2840);
    assert.equal(explicitState.sentLocationCode, 2840);
  });

  it("falls back to US for a Google-Ads-only project market", () => {
    // 2352 is Iceland (Google-Ads-only in Labs)
    const state = getDomainRouteState({}, { locationCode: 2352, languageCode: "is" });
    assert.equal(state.defaultLocationCode, 2840);
    assert.equal(state.locationCode, 2840);
    assert.equal(state.sentLocationCode, undefined);
  });

  it("ignores a Google-Ads-only URL location", () => {
    const state = getDomainRouteState({ loc: 2352 }, project);
    assert.equal(state.defaultLocationCode, 2704);
    assert.equal(state.locationCode, 2704);
    assert.equal(state.sentLocationCode, undefined);
  });
});

describe("filter condition counts and search updates", () => {
  it("counts keyword filter conditions accurately", () => {
    const filters = {
      ...EMPTY_DOMAIN_FILTERS,
      include: "shoes, running + sneakers",
      exclude: "used",
      minTraffic: "100",
      maxRank: "10",
    };
    // include: 3 terms ("shoes", "running", "sneakers")
    // exclude: 1 term ("used")
    // minTraffic: 1 condition
    // maxRank: 1 condition
    // total: 6 conditions
    assert.equal(countKeywordFilterConditions(filters), 6);
  });

  it("counts page filter conditions accurately", () => {
    const filters = {
      ...EMPTY_PAGE_FILTERS,
      include: "blog, guides",
      minTraffic: "50",
    };
    // include: 2 terms
    // minTraffic: 1 condition
    // total: 3 conditions
    assert.equal(countPageFilterConditions(filters), 3);
  });

  it("builds keyword and page search updates and clears", () => {
    const kwUpdate = buildKeywordsSearchUpdate({
      ...EMPTY_DOMAIN_FILTERS,
      include: "shoes",
      minTraffic: "100",
    });
    assert.deepEqual(kwUpdate, {
      page: undefined,
      include: "shoes",
      exclude: undefined,
      minTraffic: 100,
      maxTraffic: undefined,
      minVol: undefined,
      maxVol: undefined,
      minCpc: undefined,
      maxCpc: undefined,
      minKd: undefined,
      maxKd: undefined,
      minRank: undefined,
      maxRank: undefined,
    });

    const pageUpdate = buildPagesSearchUpdate({
      ...EMPTY_PAGE_FILTERS,
      include: "pricing",
      minVol: "5",
    });
    assert.deepEqual(pageUpdate, {
      page: undefined,
      pInclude: "pricing",
      pExclude: undefined,
      pMinTraffic: undefined,
      pMaxTraffic: undefined,
      pMinVol: 5,
      pMaxVol: undefined,
    });

    const clearUpdate = buildDomainFiltersClearSearchUpdate();
    assert.equal(clearUpdate.include, undefined);
    assert.equal(clearUpdate.pInclude, undefined);
    assert.equal(clearUpdate.page, undefined);
  });
});

describe("buildDomainResearchHref (F14-AC-11)", () => {
  it("builds striking_distance preset href", () => {
    const href = buildDomainResearchHref({
      domain: "offcult.in",
      preset: "striking_distance",
    });
    assert.equal(
      href,
      "/portal/domain?domain=offcult.in&minRank=4&maxRank=20&sort=volume&order=desc",
    );
  });

  it("builds plain domain href and optional locationCode", () => {
    const plain = buildDomainResearchHref({ domain: "example.com" });
    assert.equal(plain, "/portal/domain?domain=example.com");

    const withLoc = buildDomainResearchHref({
      domain: "example.com",
      locationCode: 2356, // India
    });
    assert.equal(withLoc, "/portal/domain?domain=example.com&loc=2356");
  });
});

describe("sort order defaults", () => {
  it("defaults rank to asc and others to desc", () => {
    assert.equal(getDefaultSortOrder("rank"), "asc");
    assert.equal(getDefaultSortOrder("traffic"), "desc");
    assert.equal(getDefaultSortOrder("volume"), "desc");
    assert.equal(getDefaultSortOrder("score"), "desc");
    assert.equal(getDefaultSortOrder("cpc"), "desc");
  });
});

describe("export tables", () => {
  it("formats keywordsToTable with fallback relativeUrl", () => {
    const table = keywordsToTable([
      {
        keyword: "t shirt",
        position: 1,
        searchVolume: 1000,
        traffic: 250,
        cpc: 0.5,
        url: "https://example.com/tshirt",
        keywordDifficulty: 20,
      },
      {
        keyword: "hoodie",
        position: 2,
        searchVolume: 500,
        traffic: 100,
        cpc: 0.8,
        url: null,
        relativeUrl: "/hoodie",
        keywordDifficulty: 30,
      },
    ]);
    assert.deepEqual(table.headers, [
      "Keyword",
      "Rank",
      "Volume",
      "Traffic",
      "CPC",
      "URL",
      "Score",
    ]);
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[0][5], "https://example.com/tshirt");
    assert.equal(table.rows[1][5], "/hoodie");
  });

  it("formats pagesToTable", () => {
    const table = pagesToTable([
      { page: "https://example.com/blog", organicTraffic: 500, keywords: 20 },
    ]);
    assert.deepEqual(table.headers, ["Page", "Organic Traffic", "Keywords"]);
    assert.equal(table.rows.length, 1);
    assert.deepEqual(table.rows[0], ["https://example.com/blog", 500, 20]);
  });

  it("formats competitorsToTable", () => {
    const table = competitorsToTable([
      {
        domain: "competitor.com",
        keywordsCount: 15,
        avgPosition: 4.5,
        visibility: 0.35,
        etv: 1200,
      },
    ]);
    assert.deepEqual(table.headers, [
      "Domain",
      "Shared Keywords",
      "Avg. Position",
      "Visibility",
      "Estimated Traffic",
    ]);
    assert.equal(table.rows.length, 1);
    assert.deepEqual(table.rows[0], ["competitor.com", 15, 4.5, 0.35, 1200]);
  });
});
