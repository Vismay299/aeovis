type EmailEventTracker = (name: string, props?: Record<string, unknown>) => void;

let tracker: EmailEventTracker | null = null;

export function setEmailEventTracker(fn: EmailEventTracker | null): void {
  tracker = fn;
}

export function trackEmailEvent(name: string, props?: Record<string, unknown>): void {
  if (tracker) {
    try {
      tracker(name, props);
    } catch {
      // Swallowed: telemetry failures must not break email delivery
    }
  }
}
