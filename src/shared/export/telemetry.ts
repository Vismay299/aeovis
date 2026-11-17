export type ExportTracker = (
  event: string,
  props: Record<string, unknown>,
) => void;

let tracker: ExportTracker | null = null;

export function setExportTracker(fn: ExportTracker | null): void {
  tracker = fn;
}

export function trackExport(
  event: string,
  props: Record<string, unknown>,
): void {
  if (tracker) {
    try {
      tracker(event, props);
    } catch {
      // Telemetry failures must never break user actions
    }
  }
}
