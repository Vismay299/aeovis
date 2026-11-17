// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/local-seo-tools.ts:691-1180
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { createHash } from "node:crypto";
import { workspaceMarket } from "../../shared/keyword-locations.ts";
import { stableStringify } from "../cache/providerCache.ts";
import { AppError } from "../../shared/http/appError.ts";
import { createDataforseoClient } from "../../shared/providers/dataforseo/client.ts";
import { fetchLocalSerpTaskResult, type LocalSerpTaskOutcome } from "../../shared/providers/dataforseo/serp.ts";
import { toResearchError } from "../research/providerErrors.ts";
import { AmbiguousCallError, ChargedCallError } from "../../shared/spend/errors.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import { businessNotFound } from "./businesses.ts";
import { appendLocalResearch, gridResearchKey, gridResearchSummary } from "./research.ts";
import { formatLocalSerpCoordinate, readPath } from "./shared.ts";
import { LOCAL_UNAVAILABLE_MESSAGE, localLog, localStoreFor, type GridRow, type LocalDeps } from "./store.ts";

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

// ---------------------------------------------------------------------------
// Service half (F17 §6.2.6): storage, reuse, inline collection and re-matching.
// ---------------------------------------------------------------------------

export const GRID_REUSE_WINDOW_MINUTES = 60;
export const GRID_DAILY_LIMIT = 20;
export const GRID_POLL_AFTER_SECONDS = 5;
const GRID_FAILED_MESSAGE = "Every map search failed at the data provider. Try again later.";
const MAX_STORED_ROWS_PER_POINT = 20;

export type GridTarget = { cid?: string; placeId?: string; name?: string };

export type GridView = {
  id: string;
  status: "processing" | "completed" | "failed";
  keyword: string;
  center: { latitude: number; longitude: number };
  gridSize: number;
  spacingKm: number;
  zoom: number;
  device: "desktop" | "mobile";
  pointsReady: number;
  pointsTotal: number;
  points: GridPointResult[] | null;
  summary: GridSummary | null;
  matched: { title: string | null; cid: string | null; placeId: string | null } | null;
  reused: boolean;
  error: { code: string; message: string } | null;
  createdAt: string;
  pollAfterSeconds: number | null;
};

export type GridSummaryRow = {
  id: string;
  keyword: string;
  gridSize: number;
  spacingKm: number;
  status: GridView["status"];
  summary: GridSummary | null;
  createdAt: string;
};

/** One stored point: null while pending, { error: true } when refused, else the top rows. */
type StoredRow = { cid: string | null; place_id: string | null; title: string | null; rank: number | null };
type StoredPoint = null | { error: true } | StoredRow[];

type Ws = Pick<Workspace, "brandKey" | "brand" | "admin" | "user">;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function text(value: unknown, max = 120): string | null {
  return typeof value === "string" && value !== "" ? value.slice(0, max) : null;
}

function toStoredPoint(outcome: LocalSerpTaskOutcome): StoredPoint {
  if (outcome.status === "pending") return null;
  if (outcome.status === "failed") return { error: true };
  return outcome.items.slice(0, MAX_STORED_ROWS_PER_POINT).map((item) => {
    const rank = readPath(item, "rank_absolute") ?? readPath(item, "rank_group");
    return {
      cid: text(readPath(item, "cid"), 40),
      place_id: text(readPath(item, "place_id"), 256),
      title: text(readPath(item, "title")),
      rank: typeof rank === "number" ? rank : null,
    };
  });
}

function rowsAsOutcome(stored: StoredPoint | undefined): { status: "completed" | "failed"; items?: unknown[] } {
  if (!Array.isArray(stored)) return { status: "failed" };
  return {
    status: "completed",
    items: stored.map((r) => ({ cid: r.cid, place_id: r.place_id, title: r.title, rank_absolute: r.rank })),
  };
}

function matchedFrom(pointRows: StoredPoint[], target: GridTarget): GridView["matched"] {
  for (const stored of pointRows) {
    if (!Array.isArray(stored)) continue;
    const found = matchGridItem(rowsAsOutcome(stored).items ?? [], target);
    if (found) {
      return {
        title: text(readPath(found, "title")),
        cid: text(readPath(found, "cid"), 40),
        placeId: text(readPath(found, "place_id"), 256),
      };
    }
  }
  return null;
}

function pointsFor(row: GridRow, pointRows: StoredPoint[], target: GridTarget): GridPointResult[] {
  const grid = buildRankGridPoints({ latitude: row.center_lat, longitude: row.center_lng }, row.grid_size, row.spacing_km);
  return grid.map((point, index) => gridPointResult(point, rowsAsOutcome(pointRows[index]), target));
}

function targetOf(row: GridRow): GridTarget {
  const t = row.target as { cid?: string; placeId?: string; name?: string };
  return { cid: t.cid, placeId: t.placeId, name: t.name };
}

function sameTarget(a: GridTarget, b: GridTarget): boolean {
  return (
    (a.cid ?? "") === (b.cid ?? "") &&
    (a.placeId ?? "") === (b.placeId ?? "") &&
    (a.name ?? "").toLowerCase() === (b.name ?? "").toLowerCase()
  );
}

function toView(row: GridRow, reused: boolean, override?: { target: GridTarget }): GridView {
  const total = row.grid_size * row.grid_size;
  const stored = (Array.isArray(row.point_rows) ? row.point_rows : []) as StoredPoint[];
  const ready = row.status === "completed" ? total : stored.filter((p) => p !== null && p !== undefined).length;
  let points = row.status === "completed" ? ((row.points as GridPointResult[] | null) ?? null) : null;
  let summary = (row.summary as GridSummary | null) ?? null;
  let matched = (row.matched as GridView["matched"]) ?? null;
  if (override && row.status === "completed" && stored.length === total) {
    // Re-read the stored rows for another target: no new purchase.
    points = pointsFor(row, stored, override.target);
    summary = summarizeGrid(points);
    matched = matchedFrom(stored, override.target);
  }
  return {
    id: row.id,
    status: row.status,
    keyword: row.keyword,
    center: { latitude: row.center_lat, longitude: row.center_lng },
    gridSize: row.grid_size,
    spacingKm: row.spacing_km,
    zoom: row.zoom,
    device: row.device,
    pointsReady: ready,
    pointsTotal: total,
    points,
    summary,
    matched,
    reused,
    error: row.error_code ? { code: row.error_code, message: row.error_message ?? GRID_FAILED_MESSAGE } : null,
    createdAt: row.created_at,
    pollAfterSeconds: row.status === "processing" ? GRID_POLL_AFTER_SECONDS : null,
  };
}

export function gridParamsHash(input: {
  keyword: string;
  center: { latitude: number; longitude: number };
  gridSize: number;
  spacingKm: number;
  zoom: number;
  device: string;
  languageCode: string;
}): string {
  // The target is not part of the key: it only filters rows.
  return createHash("sha256").update(stableStringify(input)).digest("hex");
}

function startOfUtcDay(ms: number): string {
  const d = new Date(ms);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/** Writes points, summary and match once every point is ready; a total failure marks the grid failed. */
async function finalizeGrid(ws: Ws, row: GridRow, pointRows: StoredPoint[], deps?: LocalDeps): Promise<GridRow> {
  const store = localStoreFor(ws, deps);
  const completedAt = new Date((deps?.now ?? Date.now)()).toISOString();
  const target = targetOf(row);
  const failed = pointRows.filter((p) => !Array.isArray(p)).length;
  if (failed === pointRows.length) {
    const patch = {
      status: "failed" as const,
      point_rows: pointRows,
      error_code: "local_grid_failed",
      error_message: GRID_FAILED_MESSAGE,
      completed_at: completedAt,
    };
    await store.updateGrid(ws.brandKey, row.id, patch);
    localLog(deps, `[local] grid ${row.id} failed ready=${pointRows.length}/${pointRows.length}`);
    return { ...row, ...patch };
  }
  const points = pointsFor(row, pointRows, target);
  const summary = summarizeGrid(points);
  const matched = matchedFrom(pointRows, target);
  const patch = {
    status: "completed" as const,
    points,
    point_rows: pointRows,
    summary: summary as unknown as Record<string, unknown>,
    matched: matched as unknown as Record<string, unknown> | null,
    error_code: null,
    error_message: null,
    completed_at: completedAt,
  };
  await store.updateGrid(ws.brandKey, row.id, patch);
  await appendLocalResearch(
    ws,
    {
      kind: "local.grid",
      researchKey: gridResearchKey({
        keyword: row.keyword,
        latitude: row.center_lat,
        longitude: row.center_lng,
        gridSize: row.grid_size,
        spacingKm: row.spacing_km,
      }),
      summary: gridResearchSummary({
        keyword: row.keyword,
        gridSize: row.grid_size,
        spacingKm: row.spacing_km,
        found: summary.pointsFound,
        searched: summary.pointsSearched,
        averageRank: summary.averageRank,
      }),
    },
    deps,
  );
  localLog(deps, `[local] grid ${row.id} completed ready=${pointRows.length}/${pointRows.length}`);
  return { ...row, ...patch };
}

/** One free read per still-pending point, all in parallel; transient errors leave a point pending. */
async function readPendingPoints(row: GridRow, pointRows: StoredPoint[], deps?: LocalDeps): Promise<StoredPoint[]> {
  const read = deps?.fetchSerpTaskResult ?? fetchLocalSerpTaskResult;
  const next = [...pointRows];
  await Promise.all(
    next.map(async (stored, index) => {
      if (stored !== null) return;
      const taskId = row.task_ids[index];
      if (!taskId) {
        next[index] = { error: true };
        return;
      }
      try {
        next[index] = toStoredPoint(await read(taskId));
      } catch {
        next[index] = null;
      }
    }),
  );
  return next;
}

export async function startGrid(
  ws: Ws,
  i: {
    keyword: string;
    center: { latitude: number; longitude: number };
    gridSize: 3 | 5;
    spacingKm: number;
    device: "desktop" | "mobile";
    zoom?: number;
    languageCode?: string;
    target: { businessId?: string; cid?: string; placeId?: string; name?: string };
    maxUsd?: number;
    requestId: string;
  },
  deps?: LocalDeps,
): Promise<GridView> {
  const store = localStoreFor(ws, deps);
  const nowMs = deps?.now ?? Date.now;
  const sleep = deps?.sleep ?? defaultSleep;

  let target: GridTarget = {};
  let businessId: string | null = null;
  let businessLanguage: string | null = null;
  if (i.target.businessId) {
    const business = await store.getBusiness(ws.brandKey, i.target.businessId);
    if (!business) throw businessNotFound();
    businessId = business.id;
    businessLanguage = business.language_code;
    target = {
      ...(business.cid ? { cid: business.cid } : {}),
      ...(business.place_id ? { placeId: business.place_id } : {}),
      name: business.title,
    };
  } else {
    target = {
      ...(i.target.cid ? { cid: i.target.cid } : {}),
      ...(i.target.placeId ? { placeId: i.target.placeId } : {}),
      ...(i.target.name ? { name: i.target.name } : {}),
    };
  }
  if (!target.cid && !target.placeId && !target.name) {
    throw new AppError(400, "grid_target_required", "Choose the business to find in each search.");
  }

  const keyword = i.keyword.trim();
  const zoom = i.zoom ?? rankGridZoom(i.spacingKm, i.center.latitude);
  const languageCode = i.languageCode ?? businessLanguage ?? workspaceMarket(ws.brand).languageCode;
  const hash = gridParamsHash({
    keyword,
    center: i.center,
    gridSize: i.gridSize,
    spacingKm: i.spacingKm,
    zoom,
    device: i.device,
    languageCode,
  });

  // Reuse within the window (failed runs are excluded by find_local_reuse).
  const since = new Date(nowMs() - GRID_REUSE_WINDOW_MINUTES * 60_000).toISOString();
  const reuseId = await store.findReuse(ws.brandKey, "grid", hash, since);
  if (reuseId) {
    const reusedRow = await store.getGrid(ws.brandKey, reuseId);
    if (reusedRow) {
      return toView(reusedRow, true, sameTarget(targetOf(reusedRow), target) ? undefined : { target });
    }
  }

  // Daily limit: 20 grids per workspace per UTC day.
  if ((await store.countGridsSince(ws.brandKey, startOfUtcDay(nowMs()))) >= GRID_DAILY_LIMIT) {
    throw new AppError(429, "local_grid_limit", "This workspace has run 20 map grids today. Try again tomorrow.");
  }

  const inserted = await store.insertGrid({
    brandKey: ws.brandKey,
    requestId: i.requestId,
    businessId,
    keyword,
    centerLat: i.center.latitude,
    centerLng: i.center.longitude,
    gridSize: i.gridSize,
    spacingKm: i.spacingKm,
    zoom,
    device: i.device,
    languageCode,
    target: target as Record<string, unknown>,
    paramsHash: hash,
    requestedBy: ws.user.id,
  });
  if (!inserted.created) return toView(inserted.row, false);
  let row = inserted.row;

  const points = buildRankGridPoints(i.center, i.gridSize, i.spacingKm);
  const serp = deps?.serp ?? createDataforseoClient().serp;
  let taskIds: Array<string | null>;
  try {
    taskIds = await serp.localTaskPost(
      {
        brandKey: ws.brandKey,
        feature: "local.grid",
        idempotencyKey: `local.grid:${i.requestId}`,
        maxUsd: i.maxUsd,
      },
      {
        keyword,
        locationCoordinates: points.map((p) =>
          formatLocalSerpCoordinate({ latitude: p.latitude, longitude: p.longitude, zoom }),
        ),
        languageCode,
        device: i.device,
        depth: RANK_GRID_DEPTH,
      },
    );
  } catch (err) {
    if (err instanceof ChargedCallError || err instanceof AmbiguousCallError) {
      await store.updateGrid(ws.brandKey, row.id, {
        status: "failed",
        error_code: "local_grid_failed",
        error_message: GRID_FAILED_MESSAGE,
        completed_at: new Date(nowMs()).toISOString(),
      });
      localLog(deps, `[local] grid ${row.id} failed ready=0/${points.length}`);
      throw new AppError(502, "local_grid_failed", GRID_FAILED_MESSAGE, { cause: err });
    }
    // Nothing was billed: drop the placeholder row.
    await store.deleteGrid(ws.brandKey, row.id);
    throw toResearchError(err, {
      unavailableCode: "local_unavailable",
      unavailableMessage: LOCAL_UNAVAILABLE_MESSAGE,
    });
  }

  // The task ids are stored before any collection so a lost response never loses the purchase.
  await store.updateGrid(ws.brandKey, row.id, { task_ids: taskIds });
  row = { ...row, task_ids: taskIds };

  let pointRows: StoredPoint[] = taskIds.map((id) => (id ? null : { error: true }));
  const startedAt = nowMs();
  for (;;) {
    pointRows = await readPendingPoints(row, pointRows, deps);
    if (pointRows.every((p) => p !== null)) break;
    if (nowMs() - startedAt + GRID_POLL_INTERVAL_MS > GRID_INLINE_COLLECT_MS) break;
    await sleep(GRID_POLL_INTERVAL_MS);
  }

  if (pointRows.every((p) => p !== null)) {
    row = await finalizeGrid(ws, row, pointRows, deps);
    if (row.status === "failed") throw new AppError(502, "local_grid_failed", GRID_FAILED_MESSAGE);
    return toView(row, false);
  }
  await store.updateGrid(ws.brandKey, row.id, { point_rows: pointRows });
  row = { ...row, point_rows: pointRows };
  localLog(
    deps,
    `[local] grid ${row.id} processing ready=${pointRows.filter((p) => p !== null).length}/${pointRows.length}`,
  );
  return toView(row, false);
}

export async function collectGrid(ws: Ws, gridId: string, deps?: LocalDeps): Promise<GridView> {
  const store = localStoreFor(ws, deps);
  let row = await store.getGrid(ws.brandKey, gridId);
  if (!row) throw new AppError(404, "grid_not_found", "That map grid was not found.");
  if (row.status !== "processing") return toView(row, false);
  if (!(await store.claimPoll(ws.brandKey, "grid", row.id))) return toView(row, false);

  const total = row.grid_size * row.grid_size;
  const known = Array.isArray(row.point_rows) ? (row.point_rows as StoredPoint[]) : [];
  const current: StoredPoint[] = Array.from({ length: total }, (_, index) => {
    const stored = known[index];
    if (stored !== undefined && stored !== null) return stored;
    return row?.task_ids[index] ? null : { error: true };
  });
  const next = await readPendingPoints(row, current, deps);
  if (next.every((p) => p !== null)) {
    row = await finalizeGrid(ws, row, next, deps);
  } else {
    await store.updateGrid(ws.brandKey, row.id, { point_rows: next });
    row = { ...row, point_rows: next };
    localLog(deps, `[local] grid ${row.id} processing ready=${next.filter((p) => p !== null).length}/${next.length}`);
  }
  return toView(row, false);
}

export async function listGrids(
  ws: Pick<Workspace, "brandKey" | "admin">,
  limit: number,
  deps?: LocalDeps,
): Promise<GridSummaryRow[]> {
  const rows = await localStoreFor(ws, deps).listGrids(ws.brandKey, limit);
  return rows.map((row) => ({
    id: row.id,
    keyword: row.keyword,
    gridSize: row.grid_size,
    spacingKm: row.spacing_km,
    status: row.status,
    summary: (row.summary as GridSummary | null) ?? null,
    createdAt: row.created_at,
  }));
}
