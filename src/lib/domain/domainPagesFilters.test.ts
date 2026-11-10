import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPageFilters,
  buildPagesOrderBy,
} from "./domainPagesFilters.ts";
import { AppError } from "../http/appError.ts";
import type { ScopeFilter } from "../providers/dataforseo/researchScopeFilters.ts";

describe("domainPagesFilters", () => {
  it("buildPagesOrderBy builds correct sort fields and orders", () => {
    assert.deepEqual(buildPagesOrderBy("traffic", "desc"), ["metrics.organic.etv,desc"]);
    assert.deepEqual(buildPagesOrderBy("keywords", "asc"), ["metrics.organic.count,asc"]);
    assert.deepEqual(buildPagesOrderBy("traffic"), ["metrics.organic.etv,desc"]);
  });

  it("translates include, exclude, traffic, volume and search filters", () => {
    assert.deepEqual(
      buildPageFilters(
        {
          include: "blog",
          exclude: "tag",
          minTraffic: 50,
          maxTraffic: 500,
          minVol: 10,
          maxVol: 100,
        },
        "pricing",
      ),
      [
        ["page_address", "ilike", "%blog%"],
        "and",
        ["page_address", "not_ilike", "%tag%"],
        "and",
        ["metrics.organic.etv", ">=", 50],
        "and",
        ["metrics.organic.etv", "<=", 500],
        "and",
        ["metrics.organic.count", ">=", 10],
        "and",
        ["metrics.organic.count", "<=", 100],
        "and",
        ["page_address", "ilike", "%pricing%"],
      ],
    );
  });

  it("escapes SQL LIKE wildcards in user-supplied terms", () => {
    const result = buildPageFilters({ include: "test%_\\foo" }) as unknown[][];
    assert.deepEqual(result[0], ["page_address", "ilike", "%test\\%\\_\\\\foo%"]);
  });

  it("packs exactly 8 conditions without throwing", () => {
    const result = buildPageFilters({
      include: "a,b,c",
      exclude: "d,e",
      minTraffic: 1,
      maxTraffic: 10,
      minVol: 1,
    });
    assert.equal(result.filter((entry) => Array.isArray(entry)).length, 8);
  });

  it("throws when conditions exceed the 8-condition cap", () => {
    assert.throws(
      () =>
        buildPageFilters({
          include: "a,b,c",
          exclude: "d,e",
          minTraffic: 1,
          maxTraffic: 10,
          minVol: 1,
          maxVol: 20, // 9th condition
        }),
      (err: unknown) =>
        err instanceof AppError &&
        err.status === 400 &&
        err.code === "filters_over_budget" &&
        /Too many filter conditions/.test(err.message),
    );
  });

  it("accounts for scope filter conditionCount in budget", () => {
    const scopeFilter: ScopeFilter = {
      clauses: [["page_address", "like", "%://example.com/%"]],
      conditionCount: 2,
    };

    // 6 filter conditions + 2 scope conditions = 8 -> succeeds
    const allowed = buildPageFilters(
      {
        include: "a,b",
        exclude: "c",
        minTraffic: 1,
        maxTraffic: 10,
        minVol: 5,
      },
      undefined,
      scopeFilter,
    );
    assert.ok(Array.isArray(allowed));

    // 7 filter conditions + 2 scope conditions = 9 -> throws
    assert.throws(
      () =>
        buildPageFilters(
          {
            include: "a,b,c",
            exclude: "d",
            minTraffic: 1,
            maxTraffic: 10,
            minVol: 5,
            maxVol: 50,
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
