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

const FIRST_SESSION_TOLERANCE_MS = 60_000;
const SIGN_UP_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * True on the session that completes a new account. The sign-in must land
 * within a minute of the moment the account became usable: email confirmation
 * for email sign-ups (often minutes after `created_at`), creation for Google
 * (whose timestamps are written separately and can straddle a second). The
 * account must also be under a day old, the life of a confirmation link.
 */
export function isFirstSession(
  user: { created_at?: string | null; last_sign_in_at?: string | null; email_confirmed_at?: string | null } | null | undefined,
  nowMs: number,
): boolean {
  if (!user?.created_at || !user.last_sign_in_at) return false;
  const createdMs = Date.parse(user.created_at);
  const signInMs = Date.parse(user.last_sign_in_at);
  const anchorMs = Date.parse(user.email_confirmed_at ?? user.created_at);
  if (![createdMs, signInMs, anchorMs].every(Number.isFinite)) return false;
  return nowMs - createdMs <= SIGN_UP_WINDOW_MS && Math.abs(signInMs - anchorMs) <= FIRST_SESSION_TOLERANCE_MS;
}
