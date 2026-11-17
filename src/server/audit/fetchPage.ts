// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/workflows/site-audit-workflow-helpers.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { MAX_HTML_BYTES } from "./htmlResponse.ts";
import { classifyFetch } from "./classifyFetch.ts";
import type { CrawledPageResult } from "./types.ts";
import type { PageFetchClass } from "../../shared/audit-fetch-class.ts";
import { AUDIT_CRAWLER_USER_AGENT } from "../../shared/audit.ts";
import { sha256Hex } from "./ids.ts";
import { normalizeUrl } from "./urlUtils.ts";
import type { CrawlThrottle } from "./crawlThrottle.ts";
import { crawlerHeadersFor, type CrawlerAccess } from "./crawlerAccess.ts";
import { analyzeHtml } from "./pageAnalyzer.ts";
import { inspectJsonLd } from "./structuredData.ts";
import { assertPublicUrl, SsrfBlockedError } from "../ssrfGuard.js";
import { safeFetch, type SafeFetchResult } from "../../shared/http/safeFetch.ts";

/** Parse `Link: <url>; rel="canonical"` response headers. */

/**
 * `noindex` and `none` (= noindex, nofollow) both keep a page out of the index;
 * R15's technicalAudit.js treats both as restrictive (F18 §6.2.11 parity).
 */
export function isIndexableFromDirectives(robotsMeta: string | null, xRobotsTag: string | null): boolean {
  const directives = [robotsMeta, xRobotsTag].filter(Boolean).join(",").toLowerCase();
  return !/(?:^|[,\s])(?:noindex|none)(?:$|[,\s;])/.test(directives);
}

export function parseLinkHeaderCanonical(
  linkHeader: string | null,
  pageUrl: string,
): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;([^]*)/);
    if (!match) continue;
    if (/rel\s*=\s*"?canonical"?/i.test(match[2])) {
      return normalizeUrl(match[1].trim(), pageUrl);
    }
  }
  return null;
}

export function createCachedLookup(
  underlyingLookup: (hostname: string) => Promise<string[]>,
  ttlMs = 60_000,
): (hostname: string) => Promise<string[]> {
  const cache = new Map<string, { ips: string[]; expiresAt: number }>();
  return async (hostname: string): Promise<string[]> => {
    const lower = hostname.toLowerCase();
    const now = Date.now();
    const cached = cache.get(lower);
    if (cached && now < cached.expiresAt) {
      return cached.ips;
    }
    const ips = await underlyingLookup(hostname);
    cache.set(lower, { ips, expiresAt: now + ttlMs });
    return ips;
  };
}

export interface FetchDeps {
  safeFetch: (
    input: string | URL,
    init?: any,
    deps?: { lookup?: (hostname: string) => Promise<string[]> },
  ) => Promise<SafeFetchResult>;
  lookup: (hostname: string) => Promise<string[]>;
  now(): number;
}

export interface CrawlPageOptions {
  access?: CrawlerAccess | null;
  render?: (url: string) => Promise<{ html: string; status?: number }>;
  renderThrottled?: boolean;
  deps: FetchDeps;
}

export function emptyPageResult(input: {
  url: string;
  statusCode: number;
  fetchClass: PageFetchClass;
  redirectUrl: string | null;
  responseTimeMs: number;
  xRobotsTag: string | null;
  headerCanonicalUrl: string | null;
  crawlDepth: number | null;
  inSitemap: boolean;
  htmlBytes?: number;
  rateLimited?: boolean;
  blockedReason?: string | null;
}): CrawledPageResult {
  return {
    id: crypto.randomUUID(),
    url: input.url,
    statusCode: input.statusCode,
    fetchClass: input.fetchClass,
    redirectUrl: input.redirectUrl,
    blockedReason: input.blockedReason ?? null,
    title: "",
    metaDescription: "",
    canonicalUrl: null,
    robotsMeta: null,
    xRobotsTag: input.xRobotsTag,
    headerCanonicalUrl: input.headerCanonicalUrl,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    h1Count: 0,
    h2Count: 0,
    h3Count: 0,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    headingOrder: [],
    wordCount: 0,
    contentHash: null,
    isHtml: false,
    htmlBytes: input.htmlBytes ?? 0,
    rateLimited: input.rateLimited ?? false,
    imagesTotal: 0,
    imagesMissingAlt: 0,
    images: [],
    links: [],
    hasStructuredData: false,
    hreflangTags: [],
    hreflang: [],
    structuredData: { blocks: [], missingType: 0, missingRequired: [], claimsNotVisible: [] },
    structuredDataTypes: [],
    dataNosnippet: false,
    rendered: false,
    isIndexable: false,
    responseTimeMs: input.responseTimeMs,
    crawlDepth: input.crawlDepth,
    inSitemap: input.inSitemap,
  };
}

export async function crawlPage(
  url: string,
  crawlDepth: number | null,
  inSitemap: boolean,
  throttle: CrawlThrottle,
  options: CrawlPageOptions,
): Promise<CrawledPageResult | null> {
  const { access, render, deps } = options;
  const renderThrottled = Boolean(render && options.renderThrottled);

  // SSRF guard: private addresses refused before any network request
  try {
    await assertPublicUrl(url, { lookup: deps.lookup });
  } catch (err: any) {
    if (err instanceof SsrfBlockedError || err?.name === "SsrfBlockedError") {
      return emptyPageResult({
        url,
        statusCode: 0,
        fetchClass: "error",
        redirectUrl: null,
        responseTimeMs: 0,
        xRobotsTag: null,
        headerCanonicalUrl: null,
        crawlDepth,
        inSitemap,
        blockedReason: "url_blocked",
      });
    }
    throw err;
  }

  let fetched: {
    response: SafeFetchResult;
    responseTimeMs: number;
    rateLimited: boolean;
  } | null = null;

  for (let attempt = 1; ; attempt++) {
    if (!(await throttle.ready())) return null;
    const startedAt = deps.now();

    let res: SafeFetchResult;
    try {
      res = await deps.safeFetch(
        url,
        {
          method: "GET",
          headers: {
            "user-agent": AUDIT_CRAWLER_USER_AGENT,
            accept: "text/html,application/xhtml+xml",
            ...crawlerHeadersFor(url, access),
          },
          maxRedirects: 0,
          maxBytes: MAX_HTML_BYTES,
          truncate: true,
          timeoutMs: 15_000,
        },
        { lookup: deps.lookup },
      );
    } catch (error: any) {
      if (error instanceof SsrfBlockedError || error?.name === "SsrfBlockedError") {
        return emptyPageResult({
          url,
          statusCode: 0,
          fetchClass: "error",
          redirectUrl: null,
          responseTimeMs: deps.now() - startedAt,
          xRobotsTag: null,
          headerCanonicalUrl: null,
          crawlDepth,
          inSitemap,
          blockedReason: "url_blocked",
        });
      }
      return emptyPageResult({
        url,
        statusCode: 0,
        fetchClass: "error",
        redirectUrl: null,
        responseTimeMs: deps.now() - startedAt,
        xRobotsTag: null,
        headerCanonicalUrl: null,
        crawlDepth,
        inSitemap,
      });
    }

    const responseTimeMs = deps.now() - startedAt;
    const rateLimited = attempt > 1;

    if (res.status !== 429) {
      await throttle.recovered();
      fetched = { response: res, responseTimeMs, rateLimited };
      break;
    }

    if (renderThrottled) {
      fetched = { response: res, responseTimeMs, rateLimited };
      break;
    }

    const retry = await throttle.backoff(
      attempt,
      res.headers.get("retry-after"),
    );
    if (!retry) {
      fetched = { response: res, responseTimeMs, rateLimited };
      break;
    }
  }

  if (!fetched) return null;

  const { response, responseTimeMs, rateLimited } = fetched;
  let statusCode = response.status;
  const xRobotsTag = response.headers.get("x-robots-tag");
  const headerCanonicalUrl = parseLinkHeaderCanonical(
    response.headers.get("link"),
    url,
  );

  // Redirect handling: 3xx returned unfollowed
  if (statusCode >= 300 && statusCode < 400) {
    const location = response.headers.get("location");
    const redirectUrl = location ? normalizeUrl(location, url) : null;
    return emptyPageResult({
      url,
      statusCode,
      fetchClass: "ok",
      redirectUrl,
      responseTimeMs,
      xRobotsTag,
      headerCanonicalUrl,
      crawlDepth,
      inSitemap,
      rateLimited,
    });
  }

  const contentType = response.headers.get("content-type") ?? "";
  let isHtml = contentType.toLowerCase().includes("text/html");
  let body = response.text();
  let fetchClass = classifyFetch(
    statusCode,
    Boolean(response.headers.get("cf-mitigated")),
    body.slice(0, 4_000),
  );

  const challenged = fetchClass === "blocked" && statusCode !== 401;
  const throttled = renderThrottled && statusCode === 429;
  let rendered = false;

  if (
    render &&
    (throttled ||
      (isHtml && (challenged || (fetchClass === "ok" && statusCode < 400))))
  ) {
    try {
      const page = await render(url);
      body = page.html;
      isHtml = true;
      rendered = true;
      if (challenged || throttled) statusCode = page.status ?? 200;
      fetchClass = classifyFetch(statusCode, false, body.slice(0, 4_000));
    } catch (error) {
      if (!challenged && !throttled) throw error;
      if (throttled) {
        await throttle.backoff(1, response.headers.get("retry-after"));
      }
    }
  }

  if (!isHtml || fetchClass !== "ok" || statusCode >= 400) {
    return emptyPageResult({
      url,
      statusCode,
      fetchClass,
      redirectUrl: null,
      responseTimeMs,
      xRobotsTag,
      headerCanonicalUrl,
      crawlDepth,
      inSitemap,
      htmlBytes: response.body.byteLength,
      rateLimited,
    });
  }

  const analysis = analyzeHtml(body, url, statusCode, responseTimeMs);
  const javascriptShell = analysis.javascriptShell === true;
  const isIndexable = isIndexableFromDirectives(analysis.robotsMeta, xRobotsTag);
  const headingCount = (level: number) =>
    analysis.headingOrder.filter((h) => h === level).length;

  const contentHash =
    analysis.bodyText && !javascriptShell
      ? sha256Hex(analysis.bodyText)
      : null;

  const structuredData = javascriptShell
    ? { blocks: [], missingType: 0, missingRequired: [], claimsNotVisible: [] }
    : inspectJsonLd(analysis.jsonLdBlocks, analysis.bodyText);

  const structuredDataTypes = Array.from(
    new Set(structuredData.blocks.flatMap((b) => b.types)),
  ).slice(0, 20);

  const canonicalUrl = analysis.canonical
    ? (normalizeUrl(analysis.canonical, url) ?? analysis.canonical)
    : null;

  return structuredClone({
    id: crypto.randomUUID(),
    url,
    statusCode,
    fetchClass,
    redirectUrl: null,
    title: analysis.title,
    metaDescription: analysis.metaDescription,
    canonicalUrl,
    robotsMeta: analysis.robotsMeta,
    xRobotsTag,
    headerCanonicalUrl,
    ogTitle: analysis.ogTitle,
    ogDescription: analysis.ogDescription,
    ogImage: analysis.ogImage,
    h1Count: analysis.h1s.filter((h) => h.length > 0).length,
    h2Count: headingCount(2),
    h3Count: headingCount(3),
    h4Count: headingCount(4),
    h5Count: headingCount(5),
    h6Count: headingCount(6),
    headingOrder: analysis.headingOrder,
    wordCount: analysis.wordCount,
    contentHash,
    isHtml: true,
    javascriptShell,
    htmlBytes: response.body.byteLength,
    rateLimited,
    imagesTotal: analysis.images.length,
    imagesMissingAlt: analysis.images.filter((img) => img.alt === null).length,
    images: analysis.images,
    links: analysis.links,
    hasStructuredData: analysis.hasStructuredData,
    hreflangTags: analysis.hreflangTags,
    hreflang: analysis.hreflang,
    structuredData,
    structuredDataTypes,
    dataNosnippet: analysis.dataNosnippet,
    rendered,
    isIndexable,
    responseTimeMs,
    crawlDepth,
    inSitemap,
  });
}
