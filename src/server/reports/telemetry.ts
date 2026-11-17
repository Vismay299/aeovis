// Telemetry sink for report server events (F23 §6.7). F26 owns the product
// analytics client; until it wires this sink the tracker is null and every call
// is a no-op. This module deliberately does NOT import F26's telemetry module:
// the report feature must not drag the analytics bundle (or its required env)
// into a unit test or a document route.

export type ReportEventTracker = (
  name: string,
  props: Record<string, unknown>
) => void | Promise<void>;

let tracker: ReportEventTracker | null = null;

/** Attach the real sink. Passing null detaches it (used by tests). */
export function setReportEventTracker(fn: ReportEventTracker | null): void {
  tracker = fn;
}

/**
 * Capture one report event. Telemetry must never throw into a save or a share:
 * a failed analytics call is not a failed report.
 */
export function captureReportEvent(name: string, props: Record<string, unknown>): void {
  if (!tracker) return;
  try {
    const result = tracker(name, props);
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch(() => {});
    }
  } catch {
    // no-op
  }
}
