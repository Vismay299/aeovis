// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/lib/auth-redirect.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

export const DEFAULT_AFTER_SIGN_IN = "/portal";

/** A Next.js searchParams value is a string, a string[] for a repeated key, or absent: take the first. */
export function firstParam(value: string | string[] | null | undefined): string {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : "";
  return typeof value === "string" ? value : "";
}

/**
 * Accept only same-origin paths. Backslashes are rejected because URL parsers
 * treat them as slashes, and tabs and newlines because URL parsers strip them:
 * "/\evil.com" and "/\t/evil.com" both resolve cross-origin, an open redirect
 * via location sinks.
 */
export function normalizeAuthRedirect(
  value: string | null | undefined,
  fallback?: string,
): string {
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\t\n\r]/.test(value)
  ) {
    return fallback ?? DEFAULT_AFTER_SIGN_IN;
  }
  return value;
}

const DOMAIN_PATTERN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

/** A site checked with the marketing site's free tool, carried into onboarding. */
export function normalizeHandoffDomain(value: string | null | undefined): string | null {
  if (!value) return null;
  const host = value
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/:\d+$/, "")
    .replace(/^www\./, "");
  if (host.length > 253 || !DOMAIN_PATTERN.test(host)) return null;
  return host;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A free-scan id (UUID v1 to v8), lower-cased; null otherwise. */
export function normalizeScanId(value: string | null | undefined): string | null {
  if (!value) return null;
  const id = value.trim().toLowerCase();
  return UUID_PATTERN.test(id) ? id : null;
}

/** "/onboarding" plus only the valid params, in order domain, scan, redirect. */
export function buildOnboardingPath(i: {
  domain?: string | null;
  scan?: string | null;
  redirect?: string | null;
}): string {
  const params: string[] = [];
  const domain = normalizeHandoffDomain(i.domain);
  if (domain) params.push(`domain=${encodeURIComponent(domain)}`);
  const scan = normalizeScanId(i.scan);
  if (scan) params.push(`scan=${encodeURIComponent(scan)}`);
  if (i.redirect) {
    const redirect = normalizeAuthRedirect(i.redirect);
    if (redirect !== DEFAULT_AFTER_SIGN_IN) params.push(`redirect=${encodeURIComponent(redirect)}`);
  }
  return params.length ? `/onboarding?${params.join("&")}` : "/onboarding";
}

export function authCallbackUrl(origin: string, next: string): string {
  return `${origin}/auth/callback?next=${encodeURIComponent(next)}`;
}

export function signInHref(next: string): string {
  return next === DEFAULT_AFTER_SIGN_IN || !next
    ? "/login"
    : `/login?next=${encodeURIComponent(next)}`;
}

export function verifyEmailHref(email: string | null, next: string): string {
  const params: string[] = [];
  if (email) params.push(`email=${encodeURIComponent(email)}`);
  if (next && next !== DEFAULT_AFTER_SIGN_IN) params.push(`next=${encodeURIComponent(next)}`);
  return params.length ? `/auth/verify?${params.join("&")}` : "/auth/verify";
}
