// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/rank-tracking/services/rankTrackingResults.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../http/appError.ts";
import { createRankTrackingRepository } from "./repository.ts";
import { COMPARE_PERIOD_DAYS, type ComparePeriod } from "../rank-tracking.ts";

export type ResultsDeps = { admin?: any; repo?: ReturnType<typeof createRankTrackingRepository> };

function repoOf(deps?: ResultsDeps) {
  return deps?.repo ?? createRankTrackingRepository(deps?.admin);
}

export async function getLatestResults(
  ws: { brandKey: string },
  configId: string,
  compare: ComparePeriod = "7d",
  deps?: ResultsDeps,
): Promise<{ rows: any[]; run: any | null }> {
  const repo = repoOf(deps);
  const config = await repo.getConfig(ws.brandKey, configId);
  if (!config) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");
  const keywords = await repo.listKeywords(ws.brandKey, configId);
  const now = new Date();
  const before = new Date(now.getTime() - COMPARE_PERIOD_DAYS[compare] * 86400000);
  const latest = await repo.latestSnapshots(ws.brandKey, configId, now.toISOString());
  const previous = await repo.latestSnapshots(ws.brandKey, configId, before.toISOString());
  const keywordIds = keywords.map((k: any) => k.id);
  const earliest = keywordIds.length
    ? await repo.earliestSnapshots(ws.brandKey, configId, keywordIds)
    : [];
  const run = await repo.getLatestRun(ws.brandKey, configId);

  const { aiStatusesForKeywords } = await import("./aiQuestions.ts");
  const aioMap = deps?.admin
    ? await aiStatusesForKeywords(deps.admin, ws.brandKey, keywordIds)
    : new Map();

  const latestMap = new Map(latest.map((s: any) => [s.tracking_keyword_id + ":" + s.device, s]));
  const prevMap = new Map(previous.map((s: any) => [s.tracking_keyword_id + ":" + s.device, s]));
  const earliestMap = new Map(earliest.map((s: any) => [s.tracking_keyword_id + ":" + s.device, s]));

  const rows = keywords.map((k: any) => {
    const desktopLatest = latestMap.get(k.id + ":desktop");
    const mobileLatest = latestMap.get(k.id + ":mobile");
    const desktopPrev = prevMap.get(k.id + ":desktop") ?? earliestMap.get(k.id + ":desktop");
    const mobilePrev = prevMap.get(k.id + ":mobile") ?? earliestMap.get(k.id + ":mobile");
    return {
      trackingKeywordId: k.id,
      keyword: k.keyword,
      matchCase: k.match_case,
      pinned: !!k.pinned_at,
      searchVolume: k.search_volume,
      keywordDifficulty: k.keyword_difficulty,
      cpc: k.cpc,
      desktop: {
        position: desktopLatest?.position ?? null,
        previousPosition: desktopPrev?.position ?? null,
        rankingUrl: desktopLatest?.url ?? null,
        serpFeatures: desktopLatest?.serp_features ?? [],
        checkedAt: desktopLatest?.checked_at ?? null,
      },
      mobile: {
        position: mobileLatest?.position ?? null,
        previousPosition: mobilePrev?.position ?? null,
        rankingUrl: mobileLatest?.url ?? null,
        serpFeatures: mobileLatest?.serp_features ?? [],
        checkedAt: mobileLatest?.checked_at ?? null,
      },
      aiQuestion: aioMap.get(k.id) ?? null,
    };
  });
  return { rows, run };
}

export async function getKeywordHistory(
  ws: { brandKey: string },
  configId: string,
  keywordId: string,
  sinceDays: number,
  deps?: ResultsDeps,
): Promise<Array<{ device: string; checkedAt: string; position: number | null }>> {
  const repo = repoOf(deps);
  const config = await repo.getConfig(ws.brandKey, configId);
  if (!config) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const snaps = await repo.keywordHistory(ws.brandKey, configId, keywordId, since);
  return snaps.map((s: any) => ({ device: s.device, checkedAt: s.checked_at, position: s.position }));
}

export async function getConfigTrend(
  ws: { brandKey: string },
  configId: string,
  device: "desktop" | "mobile",
  sinceDays: number,
  deps?: ResultsDeps,
): Promise<Array<{ runId: string; checkedAt: string; top3: number; top4to10: number; top11to20: number; notRanking: number; notChecked: number; aiOverview: number; checked: number }>> {
  const repo = repoOf(deps);
  const config = await repo.getConfig(ws.brandKey, configId);
  if (!config) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");
  const since = new Date(Date.now() - sinceDays * 86400000);
  const rows = await repo.configTrend(ws.brandKey, configId, device, since.toISOString());
  return rows.map((r: any) => ({
    runId: r.run_id,
    checkedAt: r.checked_at,
    top3: r.top3,
    top4to10: r.top4to10,
    top11to20: r.top11to20,
    notRanking: Math.max(0, r.keywords_total - r.top3 - r.top4to10 - r.top11to20),
    notChecked: Math.max(0, r.keywords_total - r.total),
    aiOverview: r.ai_overview,
    checked: r.total,
  }));
}

export async function getPositionMatrix(
  ws: { brandKey: string },
  configId: string,
  device: "desktop" | "mobile",
  runLimit: number,
  deps?: ResultsDeps,
): Promise<Array<{ runId: string; checkedAt: string; trackingKeywordId: string; position: number | null }>> {
  const repo = repoOf(deps);
  const config = await repo.getConfig(ws.brandKey, configId);
  if (!config) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");
  const rows = await repo.positionMatrix(ws.brandKey, configId, device, runLimit);
  return rows.map((r: any) => ({
    runId: r.run_id,
    checkedAt: r.checked_at,
    trackingKeywordId: r.tracking_keyword_id,
    position: r.position,
  }));
}
