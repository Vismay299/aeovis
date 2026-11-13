// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/features/saved-keywords
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

/**
 * The stats-refresh progress line. The job reports batches, but §6.6.3's copy
 * says "requests"; the copy is kept literally.
 */
export function RefreshStatsStatus({
  active,
  progress,
}: {
  active: boolean;
  progress?: { done: number; total: number } | null;
}) {
  if (!active) return null;
  return (
    <p className="text-sm text-muted-foreground" aria-live="polite">
      {progress
        ? `Updating keyword stats… ${progress.done} of ${progress.total} requests`
        : "Updating keyword stats…"}
    </p>
  );
}
