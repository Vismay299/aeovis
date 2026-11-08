export type IndexNowEventName =
  | "indexnow:setup"
  | "indexnow:check"
  | "indexnow:submit"
  | "indexnow:offer_shown"
  | "indexnow:offer_dismissed";

export type IndexNowEventTracker = (
  name: IndexNowEventName,
  props?: Record<string, unknown>
) => void;

let tracker: IndexNowEventTracker | null = null;

export function setIndexNowEventTracker(fn: IndexNowEventTracker | null): void {
  tracker = fn;
}

export function trackIndexNowEvent(
  name: IndexNowEventName,
  props?: Record<string, unknown>
): void {
  if (tracker) {
    try {
      tracker(name, props);
    } catch {
      // Telemetry failures must never break user actions
    }
  }
}
