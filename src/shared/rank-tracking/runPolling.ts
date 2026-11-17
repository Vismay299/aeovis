// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/useRankRunPolling.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export interface RankRunPollCandidate {
  id?: string;
  status: string;
  maybeStale?: boolean;
  pollAfterSeconds?: number | null;
}

export const RANK_RUN_ACTIVE_STATUSES = ["pending", "running"] as const;

/**
 * A run is active if it is pending or running, and has not been marked as maybeStale.
 */
export function isRankRunActive(
  run: RankRunPollCandidate | null | undefined,
): boolean {
  if (!run) return false;
  return (
    (RANK_RUN_ACTIVE_STATUSES as readonly string[]).includes(run.status) &&
    !run.maybeStale
  );
}

/**
 * Returns poll interval in milliseconds with floor of 3 seconds.
 * Returns false when the run is not active.
 */
export function rankRunPollIntervalMs(
  run: RankRunPollCandidate | null | undefined,
  options?: { floorSeconds?: number; fallbackSeconds?: number },
): number | false {
  if (!isRankRunActive(run)) return false;
  const floor = options?.floorSeconds ?? 3;
  const fallback = options?.fallbackSeconds ?? 3;
  const pas = run?.pollAfterSeconds;
  const sec = Math.max(floor, pas ?? fallback);
  return sec * 1000;
}

/**
 * Returns true if a transition from active to finished occurred for the same run.
 */
export function isRankRunFinishTransition(
  prev: RankRunPollCandidate | null | undefined,
  next: RankRunPollCandidate | null | undefined,
): boolean {
  if (!prev || !next) return false;
  if (!isRankRunActive(prev)) return false;
  if (isRankRunActive(next)) return false;
  if (prev.id && next.id && prev.id !== next.id) return false;
  return true;
}
