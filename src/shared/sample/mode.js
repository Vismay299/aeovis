/**
 * Sample workspace mode.
 *
 * Visiting /sample sets this cookie and opens the real portal on a fictional
 * workspace ("Brightwave"). While it is set:
 *   - the portal skips sign-in and boots the sample workspace (PortalShell),
 *   - every portal data request is answered in the browser from
 *     src/shared/sample/fixtures (sampleFetch.js), and
 *   - the server refuses the portal's API routes outright (middleware via
 *     src/server/sampleGuard.js), so a missed request can never read real
 *     data, write anything or spend money.
 * /sample/exit clears it. Signing in clears it too (auth callback).
 */
export const SAMPLE_COOKIE = "perceev_sample";
export const SAMPLE_BRAND_KEY = "sample-brightwave";
/** Two hours, then the visitor is back to the signed-out site. */
export const SAMPLE_COOKIE_MAX_AGE = 60 * 60 * 2;

/** API paths the portal reads. Sample mode answers these and the server refuses them. */
export const SAMPLE_API_PREFIXES = Object.freeze([
  "/api/customer",
  "/api/content",
  "/api/content-items",
  "/api/agents",
  "/api/brand-briefs",
  "/api/knowledge",
  "/api/lessons",
]);

export function isSampleApiPath(pathname) {
  return SAMPLE_API_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

/** Browser-side read of the cookie. */
export function sampleCookieSet() {
  if (typeof document === "undefined") return false;
  return document.cookie.split(";").some((part) => part.trim() === `${SAMPLE_COOKIE}=1`);
}
