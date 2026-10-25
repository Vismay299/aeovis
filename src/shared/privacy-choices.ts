// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/privacy-choices.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.
// Analytics-only; default off; no region table; no shared parent-domain cookie.

export const PRIVACY_COOKIE = "perceev_privacy";
const PRIVACY_COOKIE_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;
export const PRIVACY_CHOICES_CHANGED_EVENT = "perceev:privacy-choices-changed";

/** Cookie value → boolean | null (undecided). `a1` / `a0`. */
export function readPrivacyCookie(cookieHeader: string | null | undefined): boolean | null {
  const raw = cookieHeader
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${PRIVACY_COOKIE}=`))
    ?.slice(PRIVACY_COOKIE.length + 1);
  if (raw === "a1") return true;
  if (raw === "a0") return false;
  return null;
}

/**
 * Account decision first. The cookie counts only while nobody is signed in: a signed-in
 * account that has not decided must ignore whatever the previous person left in this
 * browser, or one shared machine opts the next account in.
 * GPC or DNT with no account decision → false (banner not offered).
 * `respect_dnt: false` stays set on the PostHog client, so an explicit opt-in is honoured
 * for a DNT browser; the signal only defaults an undecided answer to off.
 */
export function effectiveAnalyticsChoice(args: {
  account: boolean | null;
  cookie: boolean | null;
  signedIn: boolean;
  gpc: boolean;
}): boolean {
  if (args.account !== null) return args.account;
  if (args.gpc) return false;
  if (!args.signedIn && args.cookie !== null) return args.cookie;
  return false;
}

/** GPC, or legacy Do Not Track: both mean "undecided stays off". */
export function hasGlobalPrivacyControl(
  navigatorLike?: { globalPrivacyControl?: unknown; doNotTrack?: unknown } | null,
): boolean {
  const nav =
    navigatorLike !== undefined
      ? navigatorLike
      : typeof navigator !== "undefined"
        ? (navigator as { globalPrivacyControl?: unknown; doNotTrack?: unknown })
        : null;
  if (!nav) return false;
  return Reflect.get(nav, "globalPrivacyControl") === true || Reflect.get(nav, "doNotTrack") === "1";
}

export function writePrivacyCookie(
  analytics: boolean,
  doc: { cookie: string; location?: { protocol?: string } } | null = typeof document !== "undefined" ? document : null,
): void {
  if (!doc) return;
  const secure = doc.location?.protocol === "https:" ? "; Secure" : "";
  const value = analytics ? "a1" : "a0";
  doc.cookie = `${PRIVACY_COOKIE}=${value}; Path=/; Max-Age=${PRIVACY_COOKIE_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PRIVACY_CHOICES_CHANGED_EVENT));
  }
}

/** Drop the cookie so the next person in this browser starts undecided (sign-out). */
export function clearPrivacyCookie(
  doc: { cookie: string } | null = typeof document !== "undefined" ? document : null,
): void {
  if (!doc) return;
  doc.cookie = `${PRIVACY_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PRIVACY_CHOICES_CHANGED_EVENT));
  }
}
