export type LocalEventName =
  | "local:business_saved"
  | "local:profile_lookup"
  | "local:listings_search"
  | "local:reviews_collect"
  | "local:updates_collect"
  | "local:questions_collect"
  | "local:serp_search"
  | "local:grid_run";

export type LocalEventTracker = (
  name: LocalEventName,
  props?: Record<string, unknown>
) => void;

let tracker: LocalEventTracker | null = null;

export function setLocalEventTracker(fn: LocalEventTracker | null): void {
  tracker = fn;
}

export function trackLocalEvent(
  name: LocalEventName,
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
