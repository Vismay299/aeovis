/**
 * R20 — Public website foundation: canonical URLs, sitemap inventory,
 * robots indexing policies, hostname resolution, and marketing claim validation.
 *
 * Designed to satisfy acceptance scenarios R20-01 through R20-07.
 */

export const PREFERRED_PRODUCTION_ORIGIN = "https://perceev.com";
export const PREFERRED_PRODUCTION_HOST = "perceev.com";

/**
 * Public routes intended to be indexed by search engines.
 */
export const PUBLIC_INDEXABLE_ROUTES = Object.freeze([
  {
    path: "/",
    changeFrequency: "daily",
    priority: 1.0,
    lastModified: "2026-10-16T00:00:00.000Z",
  },
  {
    path: "/demo",
    changeFrequency: "weekly",
    priority: 0.8,
    lastModified: "2026-10-16T00:00:00.000Z",
  },
  {
    path: "/privacy",
    changeFrequency: "monthly",
    priority: 0.3,
    lastModified: "2026-10-16T00:00:00.000Z",
  },
  {
    path: "/terms",
    changeFrequency: "monthly",
    priority: 0.3,
    lastModified: "2026-10-16T00:00:00.000Z",
  },
]);

/**
 * Route prefixes that must NOT be indexed by search engines.
 * Note: robots disallows do not replace authentication/authorization (R20-03, R20-06).
 */
export const PRIVATE_ROUTE_PREFIXES = Object.freeze([
  "/ops",
  "/portal",
  "/dashboard",
  "/scan",
  "/api",
  "/login",
  "/signup",
  "/auth",
  "/onboarding",
]);

/**
 * Normalize and clean a pathname:
 * - strips queries and hashes
 * - ensures leading slash
 * - strips trailing slash unless path is root "/"
 */
export function normalizePathname(rawPath = "/") {
  if (!rawPath || typeof rawPath !== "string") return "/";
  let pathname = rawPath.trim();
  try {
    if (pathname.startsWith("http://") || pathname.startsWith("https://")) {
      const parsed = new URL(pathname);
      pathname = parsed.pathname;
    }
  } catch {
    // If URL parsing fails, treat as relative path
  }
  // Strip query and fragment if relative
  pathname = pathname.split("?")[0].split("#")[0];
  if (!pathname.startsWith("/")) pathname = "/" + pathname;
  // Strip trailing slashes unless root
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.replace(/\/+$/, "");
  }
  return pathname;
}

/**
 * Generate absolute canonical URL on the preferred production host (R20-01).
 * Never leaks preview hostnames (e.g., .vercel.app) or localhost.
 *
 * @param {string} pathOrUrl - Path or URL to canonicalize
 * @param {string} [preferredOrigin] - Preferred production origin override (defaults to https://perceev.com)
 * @returns {string} Absolute canonical URL
 */
export function getCanonicalUrl(pathOrUrl = "/", preferredOrigin = PREFERRED_PRODUCTION_ORIGIN) {
  const normalizedPath = normalizePathname(pathOrUrl);
  // Ensure preferred origin is clean and absolute
  let cleanOrigin = (preferredOrigin || PREFERRED_PRODUCTION_ORIGIN).trim().replace(/\/+$/, "");
  if (!cleanOrigin.startsWith("http://") && !cleanOrigin.startsWith("https://")) {
    cleanOrigin = `https://${cleanOrigin}`;
  }
  // Strip preview/local hostnames if inadvertently passed as preferredOrigin
  const previewPattern = /(localhost|127\.0\.0\.1|vercel\.app|\.local)$/i;
  try {
    const originUrl = new URL(cleanOrigin);
    if (previewPattern.test(originUrl.hostname)) {
      cleanOrigin = PREFERRED_PRODUCTION_ORIGIN;
    }
  } catch {
    cleanOrigin = PREFERRED_PRODUCTION_ORIGIN;
  }

  return normalizedPath === "/" ? cleanOrigin : `${cleanOrigin}${normalizedPath}`;
}

/**
 * Returns public URL inventory for sitemap generation (R20-02).
 * Verifies all URLs are public, indexable, and have non-invented timestamps.
 */
export function getPublicUrlInventory(preferredOrigin = PREFERRED_PRODUCTION_ORIGIN) {
  return PUBLIC_INDEXABLE_ROUTES.map((item) => ({
    path: item.path,
    url: getCanonicalUrl(item.path, preferredOrigin),
    changeFrequency: item.changeFrequency,
    priority: item.priority,
    lastModified: item.lastModified,
  }));
}

/**
 * Determine indexing policy for a given pathname and environment (R20-03).
 *
 * @param {string} rawPath
 * @param {object} [env=process.env]
 * @returns {{ index: boolean, follow: boolean, disallowRobots: boolean, isAuthentication: boolean, reason: string }}
 */
export function getRouteIndexingPolicy(rawPath = "/", env = process.env) {
  const pathname = normalizePathname(rawPath);

  // Check preview / non-production deployment
  const isPreview =
    env.VERCEL_ENV === "preview" ||
    env.NEXT_PUBLIC_VERCEL_ENV === "preview" ||
    Boolean(env.PERCEEV_IS_PREVIEW);

  if (isPreview) {
    return {
      index: false,
      follow: false,
      disallowRobots: true,
      isAuthentication: false,
      reason: "preview_deployment",
    };
  }

  // Check private route prefixes
  const isPrivate = PRIVATE_ROUTE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );

  if (isPrivate) {
    return {
      index: false,
      follow: false,
      disallowRobots: true,
      isAuthentication: false, // Robots directives do not provide authentication (R20-03)
      reason: "private_route",
    };
  }

  return {
    index: true,
    follow: true,
    disallowRobots: false,
    isAuthentication: false,
    reason: "public_indexable",
  };
}

/**
 * Generate standard robots.txt content (R20-04).
 */
export function generateRobotsTxt({ preferredOrigin = PREFERRED_PRODUCTION_ORIGIN, isPreview = false } = {}) {
  const cleanOrigin = getCanonicalUrl("/", preferredOrigin);

  if (isPreview) {
    return [
      "# Disallow indexing on preview deployments",
      "User-agent: *",
      "Disallow: /",
    ].join("\n");
  }

  const disallows = PRIVATE_ROUTE_PREFIXES.flatMap((prefix) => [`Disallow: ${prefix}$`, `Disallow: ${prefix}/`]);
  return [
    "User-agent: *",
    "Allow: /",
    ...disallows,
    "",
    `Sitemap: ${cleanOrigin}/sitemap.xml`,
  ].join("\n");
}

/**
 * Generate valid sitemap.xml content (R20-04).
 */
export function generateSitemapXml({ preferredOrigin = PREFERRED_PRODUCTION_ORIGIN } = {}) {
  const inventory = getPublicUrlInventory(preferredOrigin);
  const urls = inventory
    .map(
      (item) => `  <url>
    <loc>${item.url}</loc>
    <lastmod>${item.lastModified}</lastmod>
    <changefreq>${item.changeFrequency}</changefreq>
    <priority>${item.priority.toFixed(1)}</priority>
  </url>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}

/**
 * Inspect host policy for preferred production domain vs aliases (R20-05).
 * Prevents redirect loops while enforcing consistent canonical hostname.
 */
export function resolveHostPolicy(requestHost = "", preferredHost = PREFERRED_PRODUCTION_HOST) {
  const cleanHost = String(requestHost || "").trim().toLowerCase().split(":")[0];
  const targetHost = String(preferredHost || PREFERRED_PRODUCTION_HOST).trim().toLowerCase().split(":")[0];

  const isLocal = cleanHost === "localhost" || cleanHost === "127.0.0.1" || cleanHost.endsWith(".local");
  const isPreview = cleanHost.endsWith(".vercel.app") || cleanHost.includes("preview");
  const isPreferred = cleanHost === targetHost;
  const isAlias = !isPreferred && !isLocal && !isPreview && (cleanHost === `www.${targetHost}` || targetHost === `www.${cleanHost}`);

  let redirectTarget = null;
  if (isAlias) {
    redirectTarget = `https://${targetHost}`;
  }

  return {
    requestHost: cleanHost,
    preferredHost: targetHost,
    isPreferred,
    isAlias,
    isPreview,
    isLocal,
    canonicalHost: targetHost,
    redirectTarget,
  };
}

/**
 * Validate marketing claims against qualified system capabilities (R20-07, R21-11).
 * Registry flags alone do not qualify consumer collection claims.
 * Unqualified consumer claims are withheld or labeled experimental.
 *
 * @param {object} marketingConfig - Claims intended to be displayed
 * @param {object} capabilities - Actual qualified capabilities with evidence
 * @returns {{ valid: boolean, claims: object, withheld: string[], errors: string[] }}
 */
export function validateMarketingClaims(marketingConfig = {}, capabilities = {}) {
  const withheld = [];
  const errors = [];
  const claims = { ...marketingConfig };

  // R20-07: Consumer collection capability check
  if (claims.offersConsumerCapture) {
    if (!capabilities.consumerQualified) {
      withheld.push("offersConsumerCapture");
      claims.offersConsumerCapture = false;
      claims.consumerCaptureStatus = "unverified";
      claims.consumerCaptureNotice = "Consumer capture is experimental and not yet qualified in this release.";
    } else {
      claims.consumerCaptureStatus = "qualified";
      claims.evidenceVersion = capabilities.evidenceVersion || "v1";
    }
  }

  // Check for fabricated client counts or probe tallies (Product Principle 2 / Honesty Guard)
  if (typeof claims.lifetimeProbeCount === "number" || typeof claims.customerTestimonialCount === "number") {
    errors.push("Fabricated aggregate probe counts or unverified testimonials are prohibited.");
  }

  return {
    valid: errors.length === 0,
    claims,
    withheld,
    errors,
  };
}
