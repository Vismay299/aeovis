// F18 phase 4 — client telemetry sink.
//
// The no-op until F26 wires a tracker, exactly like the other feature sinks:
// `setAuditEventTracker(fn)` attaches one, and an event without a tracker
// goes nowhere (never into a log).

export type AuditEventTracker = (
  name: string,
  props: Record<string, unknown>,
) => void;

let tracker: AuditEventTracker | null = null;

export function setAuditEventTracker(fn: AuditEventTracker | null): void {
  tracker = fn;
}

export function trackAuditEvent(
  name: string,
  props: Record<string, unknown> = {},
): void {
  tracker?.(name, props);
}
