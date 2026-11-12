// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/workflows/rankCheckRetries.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { RETRY_DROP_POSITIONS } from "../../shared/rank-tracking.ts";
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
