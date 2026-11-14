// F20 phase 5 — client analytics event sink. A no-op until F26 wires it.

export type Ga4EventName =
  | "ga4:link_start"
  | "ga4:property_select"
  | "ga4:disconnect"
  | "ga4:account_remove"
  | "ga4:tab_view"
  | "ga4:range_change";

export type Ga4EventTracker = (
  name: Ga4EventName,
  props?: Record<string, unknown>,
) => void;

let tracker: Ga4EventTracker | null = null;

export function setGa4EventTracker(fn: Ga4EventTracker | null): void {
  tracker = fn;
}

export function trackGa4Event(
  name: Ga4EventName,
  props?: Record<string, unknown>,
): void {
  if (tracker) {
    try {
      tracker(name, props);
    } catch {
      // Telemetry failures must never break user actions.
    }
  }
}
