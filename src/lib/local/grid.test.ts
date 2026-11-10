// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/local-seo-tools.test.ts:281-440
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildRankGridPoints,
  gridPointResult,
  matchGridItem,
  rankGridZoom,
  summarizeGrid,
  type GridPoint,
  type GridPointResult,
} from "./grid.ts";

describe("local/grid (pure helpers)", () => {
  it("computes rankGridZoom with spacing and latitude, clamping to 4..18", () => {
    // 2 km at 37.3° latitude yields 13
    assert.equal(rankGridZoom(2, 37.3), 13);
    // 2 km at 40° latitude
    assert.equal(rankGridZoom(2, 40), 13);
    // very large spacing clamped to min 4
    assert.equal(rankGridZoom(10000, 40), 4);
    // very small spacing clamped to max 18
    assert.equal(rankGridZoom(0.001, 0), 18);
  });

  it("builds 3x3 rank grid points north row first with latitude/longitude steps", () => {
    const points = buildRankGridPoints({ latitude: 40, longitude: -74 }, 3, 2);
    assert.equal(points.length, 9);

    // Row 0 is the northernmost line (middle=1, row=0 -> latitude > 40)
    assert.equal(points[0]?.row, 0);
    assert.equal(points[0]?.col, 0);
    assert.equal(points[0]?.latitude, 40.0180874);
    assert.equal(points[0]?.longitude, -74.0234532);

    assert.equal(points[1]?.row, 0);
    assert.equal(points[1]?.col, 1);
    assert.equal(points[1]?.latitude, 40.0180874);
    assert.equal(points[1]?.longitude, -74);

    assert.equal(points[2]?.row, 0);
    assert.equal(points[2]?.col, 2);
    assert.equal(points[2]?.latitude, 40.0180874);
    assert.equal(points[2]?.longitude, -73.9765468);

    // Center point (row 1, col 1) is exactly the center
    assert.equal(points[4]?.row, 1);
    assert.equal(points[4]?.col, 1);
    assert.equal(points[4]?.latitude, 40);
    assert.equal(points[4]?.longitude, -74);

    // Southernmost row 2
    assert.equal(points[6]?.row, 2);
    assert.equal(points[6]?.col, 0);
    assert.equal(points[6]?.latitude, 39.9819126);
    assert.equal(points[6]?.longitude, -74.0234532);
  });

  it("builds 5x5 rank grid points with center at row 2 col 2", () => {
    const points = buildRankGridPoints({ latitude: 37.77, longitude: -122.42 }, 5, 1);
    assert.equal(points.length, 25);
    const center = points.find((p) => p.row === 2 && p.col === 2);
    assert.ok(center);
    assert.equal(center.latitude, 37.77);
    assert.equal(center.longitude, -122.42);
  });

  it("matches grid item prioritizing cid over placeId over case-insensitive name", () => {
    const items = [
      { cid: "111", place_id: "p1", title: "Cafe Blue" },
      { cid: "222", place_id: "p2", title: "Acme Coffee Downtown" },
    ];

    // CID match
    const byCid = matchGridItem(items, { cid: "222", name: "blue" });
    assert.equal((byCid as any)?.cid, "222");

    // place_id match
    const byPlace = matchGridItem(items, { placeId: "p1", name: "acme" });
    assert.equal((byPlace as any)?.place_id, "p1");

    // name case-insensitive match
    const byName = matchGridItem(items, { name: "ACME coffee" });
    assert.equal((byName as any)?.cid, "222");

    // No match
    const noMatch = matchGridItem(items, { name: "Nonexistent" });
    assert.equal(noMatch, undefined);
  });

  it("computes gridPointResult for matching and non-matching outcomes", () => {
    const point: GridPoint = { row: 0, col: 0, latitude: 40.018, longitude: -74.023 };
    const items = [
      { rank_absolute: 1, title: "Top Shop", cid: "999" },
      { rank_absolute: 3, title: "Target Shop", cid: "123" },
    ];

    // Found target
    const found = gridPointResult(point, { status: "completed", items }, { cid: "123" });
    assert.deepEqual(found, {
      ...point,
      rank: 3,
      resultsCount: 2,
      topResult: { title: "Top Shop", cid: "999" },
    });

    // Target not found (outranked)
    const outranked = gridPointResult(point, { status: "completed", items }, { cid: "000" });
    assert.deepEqual(outranked, {
      ...point,
      rank: null,
      resultsCount: 2,
      topResult: { title: "Top Shop", cid: "999" },
    });

    // Failed search
    const failed = gridPointResult(point, { status: "failed" }, { cid: "123" });
    assert.deepEqual(failed, {
      ...point,
      rank: null,
      error: true,
    });
  });

  it("summarizes grid results accurately", () => {
    const results: GridPointResult[] = [
      { row: 0, col: 0, latitude: 40, longitude: -74, rank: 1 },
      { row: 0, col: 1, latitude: 40, longitude: -74, rank: 2 },
      { row: 0, col: 2, latitude: 40, longitude: -74, rank: 5 },
      { row: 1, col: 0, latitude: 40, longitude: -74, rank: 12 },
      { row: 1, col: 1, latitude: 40, longitude: -74, rank: null }, // outranked
      { row: 1, col: 2, latitude: 40, longitude: -74, rank: null, error: true }, // search failed
    ];

    const summary = summarizeGrid(results);
    assert.deepEqual(summary, {
      pointsSearched: 6,
      pointsFound: 4,
      failed: 1,
      averageRank: 5.0, // (1 + 2 + 5 + 12) / 4 = 20 / 4 = 5.0
      top3Count: 2,
      top10Count: 3,
    });
  });
});
