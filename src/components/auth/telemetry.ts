export type AuthEventName =
  | "auth:sign_in_submit"
  | "auth:sign_in_success"
  | "auth:sign_in_block_unverified"
  | "auth:sign_up_submit"
  | "auth:sign_up_success"
  | "auth:google_start"
  | "auth:signup_blocked"
  | "auth:verification_resend"
  | "auth:verification_issue"
  | "auth:verification_success"
  | "auth:password_reset_requested";

export type AuthEventTracker = (
  name: AuthEventName,
  props?: Record<string, string | number | boolean>
) => void;

let clientTracker: AuthEventTracker | null = null;

export function setAuthEventTracker(fn: AuthEventTracker | null): void {
  clientTracker = fn;
}

export function trackAuthEvent(
  name: AuthEventName,
  props?: Record<string, string | number | boolean>
): void {
  if (clientTracker) {
    clientTracker(name, props);
  }
}
