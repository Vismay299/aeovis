// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/workflows/rankCheckRetries.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { RETRY_DROP_POSITIONS } from "../../shared/rank-tracking.ts";
import { runQueuedRound } from "./checkPaths.ts";
import type { Devices } from "../../shared/rank-tracking.ts";

export type RankCheckDevice = "desktop" | "mobile";
export type RetryPair = {
  trackingKeywordId: string;
  keyword: string;
  device: RankCheckDevice;
  position: number | null;
  answered: boolean;
  knownPosition: number | null;
  recheckMiss: boolean;
};
export type RetryObservation = { trackingKeywordId: string; device: RankCheckDevice; position: number | null };
export type RetrySave = RetryObservation & { keyword: string };

function key(keywordId: string, device: RankCheckDevice): string {
  return `${keywordId}:${device}`;
}

function otherDevice(device: RankCheckDevice): RankCheckDevice {
  return device === "desktop" ? "mobile" : "desktop";
}

export function needsRetry(pair: RetryPair): boolean {
  if (!pair.answered) return true;
  if (pair.knownPosition === null) return pair.recheckMiss && pair.position === null;
  return pair.position === null || pair.position - pair.knownPosition >= RETRY_DROP_POSITIONS;
}

export function buildRetryPairs(input: {
  keywords: Array<{ trackingKeywordId: string; keyword: string }>;
  devices: Devices;
  current: RetryObservation[];
  answeredInRun?: Set<string>;
  previousBest?: Map<string, number | null>;
  hadPreviousCheck?: Set<string>;
  previous?: Array<{ trackingKeywordId: string; position: number }>;
}): RetryPair[] {
  const devices: RankCheckDevice[] = input.devices === "both" ? ["desktop", "mobile"] : [input.devices];
  const current = new Map(input.current.map((snapshot) => [key(snapshot.trackingKeywordId, snapshot.device), snapshot.position]));
  let previousBest: Map<string, number | null>;
  let hadPrevious: Set<string>;
  if (input.previousBest && input.hadPreviousCheck) {
    previousBest = input.previousBest;
    hadPrevious = input.hadPreviousCheck;
  } else {
    previousBest = new Map((input.previous ?? []).map((s) => [s.trackingKeywordId, s.position]));
    hadPrevious = new Set((input.previous ?? []).map((s) => s.trackingKeywordId));
  }
  const answeredInRun = input.answeredInRun;
  const all = input.keywords.flatMap((keyword) => devices.map((device): RetryPair => {
    const pairKey = key(keyword.trackingKeywordId, device);
    const other = current.get(key(keyword.trackingKeywordId, otherDevice(device)));
    const prevBest = previousBest.get(keyword.trackingKeywordId) ?? null;
    const knownCandidates = [other ?? null, prevBest].filter((p): p is number => p != null);
    let answered = current.has(pairKey);
    if (answeredInRun && answeredInRun.has(pairKey)) answered = true;
    return {
      ...keyword,
      device,
      position: current.get(pairKey) ?? null,
      answered,
      knownPosition: knownCandidates.length ? Math.min(...knownCandidates) : null,
      recheckMiss: !hadPrevious.has(keyword.trackingKeywordId),
    };
  }));
  const retryKeywordIds = new Set(all.filter(needsRetry).map((pair) => pair.trackingKeywordId));
  return all.filter((pair) => retryKeywordIds.has(pair.trackingKeywordId));
}

export function selectRetryResults(
  pairs: RetryPair[],
  collected: RetryObservation[] | any[],
): { pairs: RetryPair[]; snapshotsToSave: RetrySave[]; toSave: RetrySave[]; updated: RetryPair[] } {
  const norm = (collected as any[]).map((r: any) => ({
    trackingKeywordId: r.trackingKeywordId ?? r.keywordId,
    device: r.device,
    position: r.position ?? null,
  })) as RetryObservation[];
  const results = new Map(norm.map((result) => [key(result.trackingKeywordId, result.device), result]));
  const snapshotsToSave: RetrySave[] = [];
  const updated = pairs.map((pair) => {
    const result = results.get(key(pair.trackingKeywordId, pair.device));
    if (!result) return pair;
    const answered = { ...pair, answered: true };
    const isBetter = result.position !== null && (pair.position === null || result.position < pair.position);
    const isFirstAnswerForNeverRanked = !pair.answered && pair.knownPosition === null;
    if (!isBetter && !isFirstAnswerForNeverRanked) return answered;
    snapshotsToSave.push({ trackingKeywordId: pair.trackingKeywordId, keyword: pair.keyword, device: pair.device, position: result.position });
    return { ...answered, position: result.position };
  });

  const positions = new Map(updated.map((pair) => [key(pair.trackingKeywordId, pair.device), pair.position]));
  const withOtherDevicePositions = updated.map((pair) => {
    const other = positions.get(key(pair.trackingKeywordId, otherDevice(pair.device)));
    if (other == null) return pair;
    return { ...pair, knownPosition: Math.min(pair.knownPosition ?? other, other) };
  });
  return { pairs: withOtherDevicePositions, snapshotsToSave, toSave: snapshotsToSave, updated: withOtherDevicePositions };
}

export function unconfirmedMisses(pairs: RetryPair[]): Array<{ trackingKeywordId: string; device: RankCheckDevice }> {
  return pairs
    .filter((pair) => pair.position === null && pair.knownPosition !== null)
    .map(({ trackingKeywordId, device }) => ({ trackingKeywordId, device }));
}

export async function retryRankChecks(ctx: any, run: any, deps: { repo: any; client: any; fetchTaskResult?: any; logger?: any }): Promise<void> {
  const repo = deps.repo;
  const keywords = await repo.listKeywords(ctx.brandKey, run.config_id);
  const byId = new Map(keywords.map((k: any) => [k.id, k]));
  const frozen = (run.keyword_ids ?? []).map((id: string) => byId.get(id)).filter(Boolean);
  const frozenEntries = frozen.map((k: any) => ({ trackingKeywordId: k.id, keyword: k.keyword }));
  await repo.updateRun(ctx.brandKey, run.id, { phase: "rechecking" } as any).catch(() => {});
  const devices = run.devices;
  for (let round = 1; round <= 2; round++) {
    const snaps = await repo.snapshotsForRun(ctx.brandKey, run.id);
    const current = snaps.map((s: any) => ({ trackingKeywordId: s.tracking_keyword_id, device: s.device, position: s.position }));
    const best = await repo.bestPositions(ctx.brandKey, run.config_id);
    const previousBest = new Map<string, number | null>((best ?? []).map((b: any) => [b.tracking_keyword_id, b.position ?? null] as [string, number | null]));
    const hadPreviousCheck = new Set<string>((best ?? []).map((b: any) => b.tracking_keyword_id as string));
    // answeredInRun: pairs with snapshot or completed task in earlier round
    const answeredInRun = new Set<string>();
    for (const s of snaps) answeredInRun.add(`${s.tracking_keyword_id}:${s.device}`);
    try {
      const earlier = await repo.tasksByState(ctx.brandKey, run.id, 0, ["completed"], 10000);
      for (const t of earlier) answeredInRun.add(`${t.tracking_keyword_id}:${t.device}`);
      for (let pr = 1; pr < round; pr++) {
        const done = await repo.tasksByState(ctx.brandKey, run.id, pr, ["completed"], 10000);
        for (const t of done) answeredInRun.add(`${t.tracking_keyword_id}:${t.device}`);
      }
    } catch { /* ignore */ }
    const pairsAll = buildRetryPairs({
      keywords: frozenEntries,
      devices,
      current,
      answeredInRun,
      previousBest,
      hadPreviousCheck,
    });
    const toRetry = pairsAll.filter((p) => needsRetry(p));
    if (toRetry.length === 0) break;
    // plan
    await ctx.step.do("plan-" + round, { timeoutMs: 60000, retries: 3 } as any, async () => {
      await repo.insertTasks(toRetry.map((p) => ({
        brand_key: ctx.brandKey,
        run_id: run.id,
        round,
        tracking_keyword_id: p.trackingKeywordId,
        keyword: p.keyword,
        device: p.device,
        state: "planned",
      })));
      return { planned: toRetry.length };
    });
    // run queued round for retries
    await runQueuedRound(ctx, run, round as any, deps as any, async (rows: any[]) => {
      const freshSnaps = await repo.snapshotsForRun(ctx.brandKey, run.id);
      const freshCurrent = freshSnaps.map((s: any) => ({ trackingKeywordId: s.tracking_keyword_id, device: s.device, position: s.position }));
      const pairs = buildRetryPairs({
        keywords: frozenEntries,
        devices,
        current: freshCurrent,
        answeredInRun,
        previousBest,
        hadPreviousCheck,
      });
      const sel = selectRetryResults(pairs, rows.map((r: any) => ({ trackingKeywordId: r.keywordId, device: r.device, position: r.position })));
      // round tasks carry url/features; preserve what collect stored
      const completedTasks = await repo.tasksByState(ctx.brandKey, run.id, round, ["completed"], 10000);
      const byPair = new Map(completedTasks.map((t: any) => [`${t.tracking_keyword_id}:${t.device}`, t]));
      await repo.upsertSnapshots(sel.toSave.map((s: any) => {
        const t = byPair.get(`${s.trackingKeywordId}:${s.device}`);
        return {
          brand_key: ctx.brandKey,
          run_id: run.id,
          tracking_keyword_id: s.trackingKeywordId,
          keyword: s.keyword,
          device: s.device,
          position: s.position,
          url: (t as any)?.url ?? null,
          serp_features: (t as any)?.serp_features ?? [],
        };
      }));
    });
    await ctx.step.do("save-" + round, { timeoutMs: 60000, retries: 3 } as any, async () => {
      return { saved: true };
    });
  }

  await ctx.step.do("drop-unconfirmed-misses", { timeoutMs: 60000, retries: 3 } as any, async () => {
    const snaps = await repo.snapshotsForRun(ctx.brandKey, run.id);
    const current = snaps.map((s: any) => ({ trackingKeywordId: s.tracking_keyword_id, device: s.device, position: s.position }));
    const best = await repo.bestPositions(ctx.brandKey, run.config_id);
    const previousBest = new Map<string, number | null>((best ?? []).map((b: any) => [b.tracking_keyword_id, b.position ?? null] as [string, number | null]));
    const hadPreviousCheck = new Set<string>((best ?? []).map((b: any) => b.tracking_keyword_id as string));
    const pairsAll = buildRetryPairs({
      keywords: frozenEntries,
      devices,
      current,
      previousBest,
      hadPreviousCheck,
    });
    const misses = unconfirmedMisses(pairsAll);
    for (const m of misses) {
      try {
        await repo.deleteNotFoundSnapshots(ctx.brandKey, [{ runId: run.id, trackingKeywordId: m.trackingKeywordId, device: m.device }]);
      } catch {
        // ignore
      }
    }
    return { dropped: misses.length };
  });

  ctx.progress?.(run.keywords_checked ?? 0, run.keywords_total ?? 0, "Re-checking results that look wrong");
}

