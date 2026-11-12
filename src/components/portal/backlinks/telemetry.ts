export type BacklinksEventName =
  | "backlinks:lookup"
  | "backlinks:tab"
  | "backlinks:expand_domain"
  | "backlinks:ahrefs_dr"
  | "backlinks:track_history";

export type BacklinksEventTracker = (
  name: BacklinksEventName,
  props?: Record<string, unknown>,
) => void;

let tracker: BacklinksEventTracker | null = null;

export function setBacklinksEventTracker(fn: BacklinksEventTracker | null): void {
  tracker = fn;
}

export function trackBacklinksEvent(
  name: BacklinksEventName,
  props?: Record<string, unknown>,
): void {
  if (tracker) {
    try {
      tracker(name, props);
    } catch {
      // Telemetry failures must never break user actions
    }
  }
}
