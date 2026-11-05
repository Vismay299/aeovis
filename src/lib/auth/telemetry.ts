export type AuthServerEvent = "auth:sign_up_completed";

export type AuthServerTracker = (
  name: AuthServerEvent,
  props: Record<string, string | number | boolean>,
  distinctId?: string
) => void;

let serverTracker: AuthServerTracker | null = null;

export function setAuthServerTracker(fn: AuthServerTracker | null): void {
  serverTracker = fn;
}

export function trackAuthServerEvent(
  name: AuthServerEvent,
  props: Record<string, string | number | boolean>,
  distinctId?: string
): void {
  if (serverTracker) {
    serverTracker(name, props, distinctId);
  }
}
