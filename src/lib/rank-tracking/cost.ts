// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/rank-tracking.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { costPerSerpAtDepth, serpKeywordCostMultiplier } from "../pricing/dataforseo.ts";
import { fromMicros, toMicros } from "../spend/money.ts";
import { scheduledChecksPerMonth } from "../../shared/ai-visibility-pricing.ts";
import { devicesCount, RETRY_ROUNDS } from "../../shared/rank-tracking.ts";
import type { Devices } from "../../shared/rank-tracking.ts";

export type RankCheckMethod = "live" | "queued";

export function estimatePairsUsd(
  pairs: ReadonlyArray<{ keyword: string }>,
  depth: number,
  method: RankCheckMethod,
): number {
  let micros = 0;
  for (const pair of pairs) {
    micros += toMicros(costPerSerpAtDepth(depth, method) * serpKeywordCostMultiplier(pair.keyword));
  }
  return fromMicros(micros);
}

export function estimateRankCheckUsd(
  keywords: readonly string[],
  devices: Devices,
  depth: number,
  method: RankCheckMethod,
): { checkUsd: number; retryUsd: number; totalUsd: number; pairs: number } {
  const pairs = keywords.length * devicesCount(devices);
  const perDevice = (priceMethod: RankCheckMethod) => {
    let micros = 0;
    for (const keyword of keywords) {
      const one = toMicros(costPerSerpAtDepth(depth, priceMethod) * serpKeywordCostMultiplier(keyword));
      micros += one * devicesCount(devices);
    }
    return micros;
  };
  const checkMicros = perDevice(method);
  const retryMicros = perDevice("queued") * RETRY_ROUNDS;
  return {
    checkUsd: fromMicros(checkMicros),
    retryUsd: fromMicros(retryMicros),
    totalUsd: fromMicros(checkMicros + retryMicros),
    pairs,
  };
}

export function estimateScheduledRankCheckUsd(
  keywords: readonly string[],
  devices: Devices,
  depth: number,
  interval: "daily" | "weekly" | "monthly",
): { perCheckUsd: number; runsPerMonth: number; monthlyUsd: number } {
  const perCheckUsd = estimateRankCheckUsd(keywords, devices, depth, "queued").totalUsd;
  const runsPerMonth = scheduledChecksPerMonth(interval);
  return { perCheckUsd, runsPerMonth, monthlyUsd: fromMicros(toMicros(perCheckUsd) * runsPerMonth) };
}
