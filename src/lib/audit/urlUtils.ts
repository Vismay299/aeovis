// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/url-utils.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * URL normalization and utility functions for the site audit crawler.
 */

/**
 * Normalize a URL for deduplication:
 * - Resolve relative URLs against a base
 * - Strip fragments (#...)
 * - Sort query parameters
 * - Lowercase the hostname
 * - Preserve trailing slashes.
 */
export function normalizeUrl(url: string, base?: string): string | null {
  try {
    const parsed = new URL(url, base);

    // Only crawl HTTP(S)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }

    // Strip fragment
    parsed.hash = "";

    // Sort query params for consistent dedup
    parsed.searchParams.sort();

    // Lowercase hostname
    parsed.hostname = parsed.hostname.toLowerCase();

    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * A canonical key for URL equality checks that should survive common redirect patterns:
 * - trailing-slash redirects (/services -> /services/)
 * - www <-> non-www (www.example.com -> example.com)
 * - http -> https upgrades
 */
export function canonicalUrlKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.protocol = "https:";
    parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, "");
    parsed.hash = "";
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return url.toLowerCase();
  }
}

function getEffectivePort(parsed: URL): string {
  if (parsed.port) return parsed.port;
  return parsed.protocol === "https:" ? "443" : "80";
}

function areEquivalentHostnames(a: string, b: string): boolean {
  const hostA = a.toLowerCase();
  const hostB = b.toLowerCase();
  if (hostA === hostB) return true;
  return hostA === `www.${hostB}` || hostB === `www.${hostA}`;
}

/**
 * Check if a URL belongs to the same crawl boundary as the crawl target.
 *
 * Rules:
 * - Hostname must match exactly or with www equivalent.
 * - Same protocol/port is always allowed.
 * - http -> https upgrade on default ports is allowed.
 */
export function isSameOrigin(url: string, origin: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const parsedOrigin = new URL(origin);

    if (!areEquivalentHostnames(parsedUrl.hostname, parsedOrigin.hostname)) {
      return false;
    }

    const originProtocol = parsedOrigin.protocol.toLowerCase();
    const urlProtocol = parsedUrl.protocol.toLowerCase();

    const originPort = getEffectivePort(parsedOrigin);
    const urlPort = getEffectivePort(parsedUrl);

    if (originProtocol === urlProtocol) {
      return originPort === urlPort;
    }

    const isHttpToHttpsUpgrade =
      originProtocol === "http:" &&
      urlProtocol === "https:" &&
      originPort === "80" &&
      urlPort === "443";

    return isHttpToHttpsUpgrade;
  } catch {
    return false;
  }
}

/**
 * Detect a URL template pattern by replacing path segments that look like
 * dynamic values (IDs, slugs, dates) with `:param`.
 */
export function detectUrlTemplate(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);

  const normalized = segments.map((segment) => {
    // Pure numeric IDs
    if (/^\d+$/.test(segment)) return ":id";
    // UUIDs
    if (
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        segment,
      )
    )
      return ":uuid";
    // Date-like segments (2024-01-15)
    if (/^\d{4}-\d{2}-\d{2}$/.test(segment)) return ":date";
    // Slug-like: contains hyphens and has more than 2 sub-parts
    if (segment.includes("-") && segment.split("-").length > 2) return ":slug";

    return segment;
  });

  return "/" + normalized.join("/");
}

/**
 * Extract the origin (protocol + hostname + port) from a URL string.
 */
export function getOrigin(url: string): string {
  return new URL(url).origin;
}
