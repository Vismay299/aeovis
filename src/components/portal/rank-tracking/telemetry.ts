// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   openseo:src/client/lib/posthog.ts (rank-tracking event names)
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

"use client";

export type RankEventName =
  | "rank_tracking:config_create"
  | "rank_tracking:keywords_add"
  | "rank_tracking:check_trigger"
  | "rank_tracking:check_complete"
  | "rank_tracking:pin"
  | "rank_tracking:metrics_refresh"
  | "rank_tracking:suggestions_open"
  | "rank_tracking:export_csv"
  | "rank_tracking:track_question";

export type RankEventTracker = (
  event: RankEventName,
  properties?: Record<string, number | string | boolean>,
) => void;

let tracker: RankEventTracker | null = null;

/**
 * Registers the analytics sink. F26 wires it; until then events are dropped.
 * Payloads carry counts and options only — never keyword text, domains or URLs.
 */
export function setRankEventTracker(fn: RankEventTracker | null): void {
  tracker = fn;
}

export function trackRankEvent(
  event: RankEventName,
  properties?: Record<string, number | string | boolean>,
): void {
  tracker?.(event, properties);
}
