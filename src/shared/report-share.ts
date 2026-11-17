// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/shared/report-share.ts
//   src/server/features/reports/shareAccess.ts
//   src/routes/s/$token/raw.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

// Shared vocabulary for public share links: the mint, the shape check and the
// path the routes and the app all build. The token IS the capability — there is
// no second factor on `/s/<token>` — so it comes from `crypto.getRandomValues`,
// never `Math.random` or a uuid.

/**
 * 24 random bytes rendered base64url: 192 bits of entropy in exactly 32
 * characters, with no padding and nothing to percent-encode in a path segment.
 */
export function mintShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/** The shape every share token must have. Cheap, and checked before any query. */
export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/** The public path for a token. One definition, used by both routes and the app. */
export const sharePath = (token: string) => `/s/${token}`;

/**
 * A per-link identity for anonymous view counts: `"share:"` plus the first 16
 * hex characters of the token's SHA-256. It identifies the link, never a person,
 * and it is never equal to the token (so a leaked view row cannot become a
 * working link). Hashing rather than storing the token keeps the capability out
 * of a table that an analytics read can reach.
 */
export async function sharePseudonym(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const hex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `share:${hex.slice(0, 16)}`;
}
