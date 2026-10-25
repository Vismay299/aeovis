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
 * Account decision wins when signed in and decided; else cookie; else false.
 * GPC with no explicit decision → false (banner not offered).
 * DNT is intentionally ignored here and in the PostHog client (`respect_dnt: false`):
 * an explicit account opt-in must not be silently overridden by DNT.
 */
export function effectiveAnalyticsChoice(args: {
  account: boolean | null;
  cookie: boolean | null;
  gpc: boolean;
}): boolean {
  if (args.account !== null) return args.account;
  if (args.gpc) return false;
  if (args.cookie !== null) return args.cookie;
  return false;
}

export function hasGlobalPrivacyControl(
  navigatorLike?: { globalPrivacyControl?: unknown } | null,
): boolean {
  const nav =
    navigatorLike !== undefined
      ? navigatorLike
      : typeof navigator !== "undefined"
        ? (navigator as { globalPrivacyControl?: unknown })
        : null;
  return Boolean(nav && Reflect.get(nav, "globalPrivacyControl") === true);
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
