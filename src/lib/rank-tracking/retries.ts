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
  previous: Array<{ trackingKeywordId: string; position: number }>;
}): RetryPair[] {
  const devices: RankCheckDevice[] = input.devices === "both" ? ["desktop", "mobile"] : [input.devices];
  const current = new Map(input.current.map((snapshot) => [key(snapshot.trackingKeywordId, snapshot.device), snapshot.position]));
  const previous = new Map(input.previous.map((snapshot) => [snapshot.trackingKeywordId, snapshot.position]));
  const all = input.keywords.flatMap((keyword) => devices.map((device): RetryPair => {
    const pairKey = key(keyword.trackingKeywordId, device);
    const other = current.get(key(keyword.trackingKeywordId, otherDevice(device)));
    const previousPosition = previous.get(keyword.trackingKeywordId);
    const known = [other, previousPosition].filter((position): position is number => position != null);
    return {
      ...keyword,
      device,
      position: current.get(pairKey) ?? null,
      answered: current.has(pairKey),
      knownPosition: known.length ? Math.min(...known) : null,
      recheckMiss: !previous.has(keyword.trackingKeywordId),
    };
  }));
  const retryKeywordIds = new Set(all.filter(needsRetry).map((pair) => pair.trackingKeywordId));
  return all.filter((pair) => retryKeywordIds.has(pair.trackingKeywordId));
}

export function selectRetryResults(
  pairs: RetryPair[],
  collected: RetryObservation[],
): { pairs: RetryPair[]; snapshotsToSave: RetrySave[] } {
  const results = new Map(collected.map((result) => [key(result.trackingKeywordId, result.device), result]));
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
  return { pairs: withOtherDevicePositions, snapshotsToSave };
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
  const snaps = await repo.snapshotsForRun(ctx.brandKey, run.id);
  const current = snaps.map((s: any) => ({ trackingKeywordId: s.tracking_keyword_id, device: s.device, position: s.position }));
  const best = await repo.bestPositions(ctx.brandKey, run.config_id);
  const previous = (best ?? []).map((b: any) => ({ trackingKeywordId: b.tracking_keyword_id, position: b.position }));
  const hadPreviousCheck = new Set(previous.map((p: any) => p.trackingKeywordId));

  const devices = run.devices;
  for (let round = 1; round <= 2; round++) {
    const pairsAll = buildRetryPairs({
      keywords: frozen.map((k: any) => ({ trackingKeywordId: k.id, keyword: k.keyword })),
      devices,
      current,
      previous,
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
      const pairs = buildRetryPairs({
        keywords: frozen.map((k: any) => ({ trackingKeywordId: k.id, keyword: k.keyword })),
        devices,
        current,
        previous,
      });
      const sel = selectRetryResults(pairs, rows.map((r: any) => ({ trackingKeywordId: r.keywordId, device: r.device, position: r.position })));
      await repo.upsertSnapshots(sel.snapshotsToSave.map((s: any) => ({
        brand_key: ctx.brandKey,
        run_id: run.id,
        tracking_keyword_id: s.trackingKeywordId,
        keyword: s.keyword,
        device: s.device,
        position: s.position,
        url: null,
        serp_features: [],
      })));
    });
    // save upserts handled in onCompleted
    await ctx.step.do("save-" + round, { timeoutMs: 60000, retries: 3 } as any, async () => {
      // re-derive and drop unconfirmed misses handled after loop
    });
  }

  await ctx.step.do("drop-unconfirmed-misses", { timeoutMs: 60000, retries: 3 } as any, async () => {
    const pairsAll = buildRetryPairs({
      keywords: frozen.map((k: any) => ({ trackingKeywordId: k.id, keyword: k.keyword })),
      devices,
      current,
      previous,
    });
    const misses = unconfirmedMisses(pairsAll);
    for (const m of misses) {
      // delete null-position snapshots for these
      try {
        await repo.deleteNotFoundSnapshots([{ keywordId: m.trackingKeywordId, device: m.device }]);
      } catch {
        // ignore
      }
    }
  });

  await repo.updateRun(ctx.brandKey, run.id, { phase: "rechecking" } as any);
  ctx.progress?.(run.keywords_checked ?? 0, run.keywords_total ?? 0, "Re-checking results that look wrong");
}

