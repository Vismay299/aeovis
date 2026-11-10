// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/local-seo-tools.ts:691-1180
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { readPath } from "./shared.ts";

export const KM_PER_DEGREE_LATITUDE = 110.574;
export const KM_PER_DEGREE_LONGITUDE = 111.32;
export const MIN_LONGITUDE_COSINE = 0.01;
export const RANK_GRID_DEPTH = 20;
export const RANK_GRID_ZOOM_NUMERATOR_KM = 24045;
export const MIN_RANK_GRID_ZOOM = 4;
export const MAX_RANK_GRID_ZOOM = 18;
export const GRID_INLINE_COLLECT_MS = 20_000;
export const GRID_POLL_INTERVAL_MS = 5000;

export function rankGridZoom(spacingKm: number, latitude: number): number {
  const cosine = Math.max(
    Math.abs(Math.cos((latitude * Math.PI) / 180)),
    MIN_LONGITUDE_COSINE,
  );
  const zoom = Math.floor(
    Math.log2((RANK_GRID_ZOOM_NUMERATOR_KM * cosine) / spacingKm),
  );
  return Math.min(MAX_RANK_GRID_ZOOM, Math.max(MIN_RANK_GRID_ZOOM, zoom));
}

export type GridPoint = {
  row: number;
  col: number;
  latitude: number;
  longitude: number;
};

export function buildRankGridPoints(
  center: { latitude: number; longitude: number },
  gridSize: 3 | 5,
  spacingKm: number,
): GridPoint[] {
  const middle = (gridSize - 1) / 2;
  const latitudeStep = spacingKm / KM_PER_DEGREE_LATITUDE;
  const longitudeStep =
    spacingKm /
    (KM_PER_DEGREE_LONGITUDE *
      Math.max(
        Math.abs(Math.cos((center.latitude * Math.PI) / 180)),
        MIN_LONGITUDE_COSINE,
      ));

  const points: GridPoint[] = [];
  for (let row = 0; row < gridSize; row++) {
    for (let col = 0; col < gridSize; col++) {
      points.push({
        row,
        col,
        // Row 0 is the northernmost line so the rendered grid reads like a map.
        latitude: Number(
          (center.latitude + (middle - row) * latitudeStep).toFixed(7),
        ),
        longitude: Number(
          (center.longitude + (col - middle) * longitudeStep).toFixed(7),
        ),
      });
    }
  }
  return points;
}

export function matchGridItem(
  items: unknown[],
  target: { cid?: string; placeId?: string; name?: string },
): unknown {
  if (target.cid != null && target.cid !== "") {
    const match = items.find((item) => readPath(item, "cid") === target.cid);
    if (match) return match;
  }
  if (target.placeId != null && target.placeId !== "") {
    const match = items.find(
      (item) => readPath(item, "place_id") === target.placeId,
    );
    if (match) return match;
  }
  const name = target.name?.toLowerCase().trim();
  if (name) {
    const match = items.find((item) => {
      const title = readPath(item, "title");
      return typeof title === "string" && title.toLowerCase().includes(name);
    });
    if (match) return match;
  }
  return undefined;
}

export type GridPointResult = {
  row: number;
  col: number;
  latitude: number;
  longitude: number;
  rank: number | null;
  resultsCount?: number;
  topResult?: { title: string | null; cid: string | null } | null;
  error?: true;
};

export type GridSummary = {
  pointsSearched: number;
  pointsFound: number;
  failed: number;
  averageRank: number | null;
  top3Count: number;
  top10Count: number;
};

export function gridPointResult(
  point: GridPoint,
  outcome: { status: string; items?: unknown[]; message?: string },
  target: { cid?: string; placeId?: string; name?: string },
): GridPointResult {
  if (outcome.status !== "completed" || !Array.isArray(outcome.items)) {
    return { ...point, rank: null, error: true };
  }
  const items = outcome.items;
  const match = matchGridItem(items, target);
  const rawRank = readPath(match, "rank_absolute") ?? readPath(match, "rank_group");
  const rank = typeof rawRank === "number" ? rawRank : null;
  const first = items[0];
  const topTitle = readPath(first, "title");
  const topCid = readPath(first, "cid");

  return {
    ...point,
    rank,
    resultsCount: items.length,
    topResult:
      first == null
        ? null
        : {
            title: typeof topTitle === "string" ? topTitle : null,
            cid: typeof topCid === "string" ? topCid : null,
          },
  };
}

export function summarizeGrid(points: GridPointResult[]): GridSummary {
  const searched = points.length;
  const failed = points.filter((p) => p.error === true).length;
  const found = points.filter((p) => p.rank != null && !p.error);
  const ranks = found.map((p) => p.rank as number);
  const averageRank = ranks.length
    ? Number((ranks.reduce((sum, r) => sum + r, 0) / ranks.length).toFixed(2))
    : null;
  const top3Count = ranks.filter((r) => r <= 3).length;
  const top10Count = ranks.filter((r) => r <= 10).length;

  return {
    pointsSearched: searched,
    pointsFound: found.length,
    failed,
    averageRank,
    top3Count,
    top10Count,
  };
}
