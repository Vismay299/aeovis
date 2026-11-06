// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/shared.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export function pollIntervalMs<T>(
  data: T | undefined,
  o: {
    isActive(d: T): boolean;
    pollAfterSeconds?(d: T): number | null | undefined;
    floorSeconds?: number; // default 4
    fallbackSeconds?: number; // default 5
  }
): number | false {
  if (data === undefined || !o.isActive(data)) return false;
  const pas = o.pollAfterSeconds ? o.pollAfterSeconds(data) : undefined;
  const floor = o.floorSeconds ?? 4;
  const fallback = o.fallbackSeconds ?? 5;
  const sec = Math.max(floor, pas ?? fallback);
  return sec * 1000;
}

export function pacedStaleTime<T>(
  data: T | undefined,
  isActive: (d: T) => boolean
): number {
  return data === undefined || isActive(data) ? 0 : Infinity;
}

export function finishTransition<T>(
  prev: T | undefined,
  next: T | undefined,
  o: {
    isActive(d: T): boolean;
    sameRun?(a: T, b: T): boolean;
  }
): boolean {
  if (prev === undefined || next === undefined) return false;
  if (!o.isActive(prev)) return false;
  if (o.isActive(next)) return false;
  if (o.sameRun && !o.sameRun(prev, next)) return false;
  return true;
}

export const JOB_ACTIVE_STATUSES = ["queued", "running"] as const;

export function isJobActive(s: { status: string } | undefined): boolean {
  return Boolean(s && (JOB_ACTIVE_STATUSES as readonly string[]).includes(s.status));
}
