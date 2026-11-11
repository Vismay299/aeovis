// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tools/local-seo-tools.test.ts:281, :375, :392, :410, :431
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../http/appError.ts";
import type { LocalSerpTaskOutcome } from "../providers/dataforseo/serp.ts";
import { ChargedCallError, UnbilledCallError } from "../spend/errors.ts";
import { saveBusiness } from "./businesses.ts";
import {
  collectGrid,
  GRID_DAILY_LIMIT,
  GRID_INLINE_COLLECT_MS,
  listGrids,
  rankGridZoom,
  startGrid,
} from "./grid.ts";
import { localKit, makeWs, type LocalKit } from "./testKit.ts";

const ws = makeWs();
const CENTER = { latitude: 19.076, longitude: 72.8777 };
const TARGET_CID = "1234567890123456789";
const COMPETITOR_CID = "5550001";
const req = (n: number) => `${String(n).padStart(8, "0")}-bbbb-4bbb-8bbb-${String(n).padStart(12, "0")}`;
const pending: LocalSerpTaskOutcome = { status: "pending" };

function rows(targetRank: number | null, competitorRank: number | null, total = 20) {
  const items: Array<Record<string, unknown>> = [];
  for (let rank = 1; rank <= total; rank += 1) {
    let cid = String(8000 + rank);
    let title = `Business ${rank}`;
    if (rank === targetRank) {
      cid = TARGET_CID;
      title = "Offcult Store";
    }
    if (rank === competitorRank) {
      cid = COMPETITOR_CID;
      title = "Bonkers Corner";
    }
    items.push({ rank_group: rank, rank_absolute: rank, title, cid, place_id: `place_${cid}`, image: "https://example.test/skip.png" });
  }
  return items;
}

// Point index -> target rank (null = absent). Index 4 is the refused point (no task id).
const TARGET_RANKS: Array<number | null> = [6, 3, 1, 2, null, 4, 9, null, 5];

function taskIds(): Array<string | null> {
  return TARGET_RANKS.map((_, i) => (i === 4 ? null : `task-${i}`));
}

function outcomesReady(): Map<string, LocalSerpTaskOutcome> {
  const map = new Map<string, LocalSerpTaskOutcome>();
  TARGET_RANKS.forEach((rank, i) => {
    if (i === 4) return;
    // Point 7 is sparse: two rows and the target is not among them.
    map.set(`task-${i}`, { status: "completed", items: i === 7 ? rows(null, null, 2) : rows(rank, i === 0 ? 2 : null) });
  });
  return map;
}

function makeKit(
  outcomes: Map<string, LocalSerpTaskOutcome>,
  responders: Parameters<typeof localKit>[0] = { localTaskPost: () => ({ data: taskIds(), costUsd: 0.0096 }) },
  extra: { reads?: string[] } = {},
): LocalKit {
  return localKit(responders, {
    fetchSerpTaskResult: (async (id: string) => {
      extra.reads?.push(id);
      return outcomes.get(id) ?? pending;
    }) as never,
  });
}

const baseInput = (target: Record<string, string> = { cid: TARGET_CID }, n = 1) => ({
  keyword: "streetwear store",
  center: CENTER,
  gridSize: 3 as const,
  spacingKm: 2,
  device: "mobile" as const,
  target,
  maxUsd: 0.02,
  requestId: req(n),
});

test("a 3x3 grid posts 9 searches north row first with a zoom suffix, collects them and logs one research entry", async () => {
  const kit = makeKit(outcomesReady());
  const view = await startGrid(ws, baseInput(), kit.deps);
  assert.equal(view.status, "completed");
  assert.equal(kit.harness.calls.localTaskPost?.length, 1, "one paid post");
  const post = kit.harness.calls.localTaskPost?.[0];
  const zoom = rankGridZoom(2, CENTER.latitude);
  assert.equal(view.zoom, zoom);
  assert.equal(post.locationCoordinates.length, 9);
  assert.ok(post.locationCoordinates.every((c: string) => c.endsWith(`,${zoom}z`)));
  assert.equal(post.keyword, "streetwear store");
  assert.equal(post.depth, 20);
  assert.equal(post.device, "mobile");
  assert.ok(Number(post.locationCoordinates[0].split(",")[0]) > Number(post.locationCoordinates[6].split(",")[0]), "row 0 is the northernmost");
  assert.equal(view.pointsTotal, 9);
  assert.equal(view.pointsReady, 9);
  assert.equal(view.points?.length, 9);
  assert.equal(view.points?.[0]?.rank, 6);
  assert.equal(view.points?.[0]?.resultsCount, 20);
  assert.deepEqual(view.points?.[0]?.topResult, { title: "Business 1", cid: "8001" });
  assert.equal(view.points?.[7]?.resultsCount, 2, "a sparse point keeps its small count");
  assert.equal(view.points?.[7]?.rank, null);
  assert.deepEqual(view.matched, { title: "Offcult Store", cid: TARGET_CID, placeId: `place_${TARGET_CID}` });
  assert.equal(view.reused, false);
  assert.equal(view.pollAfterSeconds, null);
  assert.equal(kit.harness.spend.ledger.length, 1);
  assert.equal(kit.harness.spend.ledger[0]?.feature, "local.grid");
  assert.equal(kit.research.length, 1);
  assert.equal(kit.research[0]?.kind, "local.grid");
  assert.equal(kit.research[0]?.researchKey, "streetwear store|19.076|72.8777|3|2");
  assert.match(kit.research[0]?.summary ?? "", /^Map ranking grid for “streetwear store” \(3×3, 2 km\): ranked at 7 of 9 points, average 4.29\.$/);
  const row = [...kit.store.grids.values()][0];
  assert.deepEqual(row?.task_ids, taskIds());
  assert.equal(row?.point_rows?.length, 9);
});

test("a refused point is an error cell, counted as failed, and the rest still summarise", async () => {
  const kit = makeKit(outcomesReady());
  const view = await startGrid(ws, baseInput(), kit.deps);
  assert.equal(view.points?.[4]?.error, true);
  assert.equal(view.points?.[4]?.rank, null);
  assert.equal(view.summary?.failed, 1);
  assert.equal(view.summary?.pointsSearched, 9);
  assert.equal(view.summary?.pointsFound, 7);
  assert.equal(view.summary?.top3Count, 3);
  assert.equal(view.summary?.top10Count, 7);
  assert.equal(view.summary?.averageRank, 4.29);
});

test("every point failing is 502 local_grid_failed and the run is not reused", async () => {
  const failed = new Map<string, LocalSerpTaskOutcome>();
  for (let i = 0; i < 9; i += 1) failed.set(`task-${i}`, { status: "failed", message: "provider refused" });
  const kit = makeKit(failed);
  await assert.rejects(
    startGrid(ws, baseInput(), kit.deps),
    (err: unknown) => err instanceof AppError && err.status === 502 && err.code === "local_grid_failed",
  );
  const [row] = [...kit.store.grids.values()];
  assert.equal(row?.status, "failed");
  assert.equal(row?.error_code, "local_grid_failed");
  // The same parameters post again: a failed run never counts as a receipt.
  await assert.rejects(startGrid(ws, baseInput({ cid: TARGET_CID }, 2), kit.deps), /Every map search failed/);
  assert.equal(kit.harness.calls.localTaskPost?.length, 2);
});

test("pending points leave the grid processing after the 20 s inline budget; collection is free and finishes it", async () => {
  const outcomes = new Map<string, LocalSerpTaskOutcome>();
  const ready = outcomesReady();
  for (const id of ["task-0", "task-1", "task-2"]) outcomes.set(id, ready.get(id) as LocalSerpTaskOutcome);
  const reads: string[] = [];
  const kit = makeKit(outcomes, undefined, { reads });
  const view = await startGrid(ws, baseInput(), kit.deps);
  assert.equal(view.status, "processing");
  assert.equal(view.pollAfterSeconds, 5);
  assert.equal(view.points, null);
  assert.equal(view.pointsTotal, 9);
  assert.equal(view.pointsReady, 4, "three answered plus the refused point");
  assert.ok(kit.clock.slept.reduce((a, b) => a + b, 0) <= GRID_INLINE_COLLECT_MS);
  assert.equal(kit.harness.calls.localTaskPost?.length, 1);
  assert.equal(kit.research.length, 0);

  // Everything is ready by the next poll.
  for (const [id, outcome] of ready) outcomes.set(id, outcome);
  reads.length = 0;
  kit.clock.advance(5000);
  const done = await collectGrid(ws, view.id, kit.deps);
  assert.equal(done.status, "completed");
  assert.equal(done.points?.length, 9);
  assert.equal(kit.harness.calls.localTaskPost?.length, 1, "no second post");
  assert.equal(kit.harness.spend.ledger.length, 1, "collection costs nothing");
  assert.equal(reads.length, 5, "only the still-pending points are read (task-3 and task-5..8)");
  assert.ok(!reads.includes("task-0"));
  assert.equal(kit.research.length, 1);
});

test("collection is throttled to one provider read round per 4 s", async () => {
  const reads: string[] = [];
  const kit = makeKit(new Map(), undefined, { reads });
  const view = await startGrid(ws, baseInput(), kit.deps);
  assert.equal(view.status, "processing");
  reads.length = 0;
  kit.clock.advance(5000);
  await collectGrid(ws, view.id, kit.deps);
  const afterFirst = reads.length;
  assert.ok(afterFirst > 0);
  await collectGrid(ws, view.id, kit.deps);
  assert.equal(reads.length, afterFirst, "a second collection inside 4 s reads nothing");
});

test("the same arguments within 60 minutes reuse the run with no spend; different arguments post again", async () => {
  const kit = makeKit(outcomesReady());
  const first = await startGrid(ws, baseInput(), kit.deps);
  kit.clock.advance(30 * 60_000);
  const again = await startGrid(ws, baseInput({ cid: TARGET_CID }, 2), kit.deps);
  assert.equal(again.id, first.id);
  assert.equal(again.reused, true);
  assert.equal(kit.harness.calls.localTaskPost?.length, 1);
  assert.equal(kit.research.length, 1);
  const wider = await startGrid(ws, { ...baseInput({ cid: TARGET_CID }, 3), spacingKm: 3 }, kit.deps);
  assert.notEqual(wider.id, first.id);
  assert.equal(kit.harness.calls.localTaskPost?.length, 2);
  kit.clock.advance(31 * 60_000);
  const expired = await startGrid(ws, baseInput({ cid: TARGET_CID }, 4), kit.deps);
  assert.notEqual(expired.id, first.id);
  assert.equal(kit.harness.calls.localTaskPost?.length, 3);
});

test("a repeated requestId returns the same run and buys nothing more", async () => {
  const kit = makeKit(outcomesReady());
  const first = await startGrid(ws, baseInput(), kit.deps);
  kit.clock.advance(61 * 60_000);
  const retry = await startGrid(ws, baseInput(), kit.deps);
  assert.equal(retry.id, first.id);
  assert.equal(kit.harness.calls.localTaskPost?.length, 1);
});

test("a stored run is re-read for another target without buying again", async () => {
  const kit = makeKit(outcomesReady());
  const mine = await startGrid(ws, baseInput(), kit.deps);
  const rival = await startGrid(ws, baseInput({ cid: COMPETITOR_CID }, 2), kit.deps);
  assert.equal(rival.id, mine.id);
  assert.equal(rival.reused, true);
  assert.equal(kit.harness.calls.localTaskPost?.length, 1);
  assert.deepEqual(rival.matched, { title: "Bonkers Corner", cid: COMPETITOR_CID, placeId: `place_${COMPETITOR_CID}` });
  assert.equal(rival.points?.[0]?.rank, 2, "the competitor ranks 2 at point 0");
  assert.equal(rival.points?.[1]?.rank, null);
  assert.equal(rival.summary?.pointsFound, 1);
  assert.equal(mine.points?.[0]?.rank, 6, "the original is unchanged");
});

test("a target is required, and a saved business supplies cid, place id and title", async () => {
  const kit = makeKit(outcomesReady());
  await assert.rejects(
    startGrid(ws, { ...baseInput({}), target: {} }, kit.deps),
    (err: unknown) => err instanceof AppError && err.status === 400 && err.code === "grid_target_required",
  );
  assert.equal(kit.harness.calls.localTaskPost, undefined);
  const saved = await saveBusiness(ws, { role: "own", title: "Offcult Store", cid: TARGET_CID, languageCode: "en" }, kit.deps);
  const view = await startGrid(ws, baseInput({ businessId: saved.id }), kit.deps);
  assert.equal(view.status, "completed");
  assert.equal(view.matched?.cid, TARGET_CID);
  assert.equal([...kit.store.grids.values()][0]?.business_id, saved.id);
  await assert.rejects(
    startGrid(ws, baseInput({ businessId: "99999999-9999-4999-8999-999999999999" }, 9), kit.deps),
    (err: unknown) => err instanceof AppError && err.code === "business_not_found",
  );
});

test("more than 20 grids today is 429 local_grid_limit with no spend", async () => {
  const kit = makeKit(outcomesReady());
  for (let i = 0; i < GRID_DAILY_LIMIT; i += 1) {
    await kit.store.insertGrid({
      brandKey: ws.brandKey,
      requestId: req(100 + i),
      businessId: null,
      keyword: `k${i}`,
      centerLat: 1,
      centerLng: 1,
      gridSize: 3,
      spacingKm: 2,
      zoom: 13,
      device: "mobile",
      languageCode: "en",
      target: { cid: "1" },
      paramsHash: String(i).padStart(64, "0"),
      requestedBy: null,
    });
  }
  await assert.rejects(
    startGrid(ws, baseInput(), kit.deps),
    (err: unknown) => err instanceof AppError && err.status === 429 && err.code === "local_grid_limit",
  );
  assert.equal(kit.harness.calls.localTaskPost, undefined);
  // Another workspace is unaffected, and tomorrow the count resets.
  await startGrid(makeWs("other.example"), baseInput({ cid: TARGET_CID }, 7), kit.deps);
  kit.clock.advance(24 * 3600_000);
  await startGrid(ws, baseInput({ cid: TARGET_CID }, 8), kit.deps);
});

test("an unbilled post error removes the placeholder run and maps to local_unavailable", async () => {
  const kit = makeKit(outcomesReady(), {
    localTaskPost: () => {
      throw new UnbilledCallError("rejected", { code: "dataforseo_invalid_field", status: 422 });
    },
  });
  await assert.rejects(startGrid(ws, baseInput(), kit.deps), (err: unknown) => err instanceof AppError);
  assert.equal(kit.store.grids.size, 0);
});

test("a charged post failure is recorded as failed local_grid_failed and never retried", async () => {
  let posts = 0;
  const kit = makeKit(outcomesReady(), {
    localTaskPost: () => {
      posts += 1;
      throw new ChargedCallError("all rejected", { actualUsd: 0.0108, provider: "dataforseo", endpoint: "serp/maps/task_post" });
    },
  });
  await assert.rejects(
    startGrid(ws, baseInput(), kit.deps),
    (err: unknown) => err instanceof AppError && err.status === 502 && err.code === "local_grid_failed",
  );
  assert.equal(posts, 1);
  assert.equal([...kit.store.grids.values()][0]?.status, "failed");
});

test("collectGrid and listGrids are workspace scoped; an unknown grid is 404", async () => {
  const kit = makeKit(outcomesReady());
  const view = await startGrid(ws, baseInput(), kit.deps);
  await assert.rejects(
    collectGrid(makeWs("other.example"), view.id, kit.deps),
    (err: unknown) => err instanceof AppError && err.status === 404 && err.code === "grid_not_found",
  );
  const mine = await listGrids(ws, 20, kit.deps);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.keyword, "streetwear store");
  assert.equal(mine[0]?.status, "completed");
  assert.equal(mine[0]?.summary?.pointsFound, 7);
  assert.equal((await listGrids(makeWs("other.example"), 20, kit.deps)).length, 0);
});

test("a 5x5 grid posts 25 searches", async () => {
  const ids = Array.from({ length: 25 }, (_, i) => `t${i}`);
  const outcomes = new Map<string, LocalSerpTaskOutcome>(ids.map((id) => [id, { status: "completed", items: rows(3, null) }]));
  const kit = makeKit(outcomes, { localTaskPost: () => ({ data: ids, costUsd: 0.03 }) });
  const view = await startGrid(ws, { ...baseInput(), gridSize: 5, maxUsd: 0.05 }, kit.deps);
  assert.equal(kit.harness.calls.localTaskPost?.[0].locationCoordinates.length, 25);
  assert.equal(view.pointsTotal, 25);
  assert.equal(view.summary?.pointsFound, 25);
});
