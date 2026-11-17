// Telemetry sink for onboarding server events.
// Wires to F26 telemetry if set; no-op by default.

export type OnboardingServerTracker = (
  name: string,
  props: Record<string, unknown>,
  userId?: string,
) => void | Promise<void>;

let tracker: OnboardingServerTracker | null = null;

export function setOnboardingServerTracker(
  fn: OnboardingServerTracker | null,
): void {
  tracker = fn;
}

export function trackOnboardingServerEvent(
  name: string,
  props: Record<string, unknown>,
  userId?: string,
): void {
  if (!tracker) return;
  try {
    const res = tracker(name, props, userId);
    if (res && typeof (res as Promise<void>).catch === "function") {
      (res as Promise<void>).catch(() => {});
    }
  } catch {
    // telemetry must never throw
  }
}
