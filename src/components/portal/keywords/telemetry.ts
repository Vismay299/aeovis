"use client";

export type KeywordEventTracker = (
  event: string,
  properties: Record<string, unknown>,
) => void;

let tracker: KeywordEventTracker | null = null;

export function setKeywordEventTracker(fn: KeywordEventTracker | null): void {
  tracker = fn;
}

export function trackKeywordResearch(event: string, properties: Record<string, unknown> = {}) {
  if (!tracker) return;
  try {
    tracker(event, properties);
  } catch {
    // The analytics sink is opt-in and telemetry failures must never break user actions.
  }
}
