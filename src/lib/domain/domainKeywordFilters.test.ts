import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildKeywordFilters } from "./domainKeywordFilters.ts";
import { AppError } from "../http/appError.ts";
import type { ScopeFilter } from "../providers/dataforseo/researchScopeFilters.ts";

describe("buildKeywordFilters", () => {
  // Include terms are ANDed here (every term must match), unlike the
  // backlinks filters where they're ORed.
  it("translates each filter kind and chains them with 'and'", () => {
    assert.deepEqual(
      buildKeywordFilters({
        include: "audit, checker",
        exclude: "jobs+salary",
        minVol: 100,
        maxVol: 5000,
        minCpc: 0.5,
      }),
      [
        ["keyword_data.keyword", "ilike", "%audit%"],
        "and",
        ["keyword_data.keyword", "ilike", "%checker%"],
        "and",
        ["keyword_data.keyword", "not_ilike", "%jobs%"],
        "and",
        ["keyword_data.keyword", "not_ilike", "%salary%"],
        "and",
        ["keyword_data.keyword_info.search_volume", ">=", 100],
        "and",
        ["keyword_data.keyword_info.search_volume", "<=", 5000],
        "and",
        ["keyword_data.keyword_info.cpc", ">=", 0.5],
      ],
    );
  });

  it("escapes SQL LIKE wildcards in user-supplied terms", () => {
    const result = buildKeywordFilters({ include: "100%" }) as unknown[][];
    assert.deepEqual(result[0], ["keyword_data.keyword", "ilike", "%100\\%%"]);
  });

  it("ANDs the search OR-group after structured filters", () => {
    const result = buildKeywordFilters({ minVol: 100 }, "audit");
    assert.deepEqual(result, [
      ["keyword_data.keyword_info.search_volume", ">=", 100],
      "and",
      [
        ["keyword_data.keyword", "ilike", "%audit%"],
        "or",
        ["ranked_serp_element.serp_item.url", "ilike", "%audit%"],
      ],
    ]);
  });

  it("packs exactly 8 conditions without throwing", () => {
    const result = buildKeywordFilters({
      include: "a,b,c,d",
      exclude: "e,f",
      minVol: 1,
      maxVol: 2,
    });
    assert.equal(result.filter((entry) => Array.isArray(entry)).length, 8);
  });

  it("throws when conditions exceed the 8-condition cap", () => {
    assert.throws(
      () =>
        buildKeywordFilters({
          include: "a,b,c,d",
          exclude: "e,f",
          minVol: 1,
          maxVol: 2,
          minTraffic: 3,
          maxTraffic: 4,
        }),
      (err: unknown) =>
        err instanceof AppError &&
        err.status === 400 &&
        err.code === "filters_over_budget" &&
        /Too many filter conditions/.test(err.message),
    );
  });

  it("counts the search OR-group as 2 toward the cap", () => {
    assert.throws(
      () =>
        buildKeywordFilters(
          {
            include: "a,b,c,d",
            exclude: "e,f",
            minVol: 1,
          },
          "audit",
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.status === 400 &&
        err.code === "filters_over_budget",
    );
  });

  it("accounts for scope filter conditionCount in budget", () => {
    const scopeFilter: ScopeFilter = {
      clauses: [["ranked_serp_element.serp_item.domain", "in", ["example.com", "www.example.com"]]],
      conditionCount: 1,
    };

    // 7 filter conditions + 1 scope condition = 8 -> succeeds
    const allowed = buildKeywordFilters(
      {
        include: "a,b,c,d",
        exclude: "e,f",
        minVol: 1,
      },
      undefined,
      scopeFilter,
    );
    assert.ok(Array.isArray(allowed));

    // 8 filter conditions + 1 scope condition = 9 -> throws
    assert.throws(
      () =>
        buildKeywordFilters(
          {
            include: "a,b,c,d",
            exclude: "e,f",
            minVol: 1,
            maxVol: 2,
          },
          undefined,
          scopeFilter,
        ),
      (err: unknown) =>
        err instanceof AppError &&
        err.status === 400 &&
        err.code === "filters_over_budget",
    );
  });
});
