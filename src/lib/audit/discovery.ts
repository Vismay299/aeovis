// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/discovery.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * robots.txt and sitemap.xml discovery for the site audit crawler.
 */
import { XMLParser } from "fast-xml-parser";
import { parseRobotsTxt as parseRobotsTxtRep, evaluateBot } from "../crawlers/robots.js";
import { safeFetch, type SafeFetchResult } from "../http/safeFetch.ts";
import { normalizeUrl, isSameOrigin } from "./urlUtils.ts";
import { isCrawlableUrl } from "./urlPolicy.ts";
import { crawlerHeadersFor, type CrawlerAccess } from "./crawlerAccess.ts";

const SITEMAP_FETCH_TIMEOUT_MS = 15_000;
const MAX_ROBOTS_TXT_BYTES = 500 * 1024;
const MAX_SITEMAP_DEPTH = 3;
const MAX_SITEMAP_DOCS = 300;
const SITEMAP_CONCURRENCY = 5;
const SITEMAP_RETRIES = 1;
const MAX_SITEMAP_BYTES = 10 * 1024 * 1024; // 10 MB shard skip
const DISCOVERY_TOTAL_BUDGET_MS = 150_000; // 150 s budget

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => name === "sitemap" || name === "url",
});

export interface RobotsResult {
  isAllowed: (url: string) => boolean;
  sitemapUrls: string[];
}

export interface DiscoveryDeps {
  safeFetch?: (
    url: string | URL,
    init?: any,
    deps?: { lookup?: (hostname: string) => Promise<string[]> },
  ) => Promise<SafeFetchResult>;
  lookup?: (hostname: string) => Promise<string[]>;
}

export function parseRobotsTxt(
  origin: string,
  text: string | null,
): RobotsResult {
  if (text === null || text.trim() === "") {
    return { isAllowed: () => true, sitemapUrls: [] };
  }

  const parsed = parseRobotsTxtRep(text);
  return {
    isAllowed: (url: string) => {
      try {
        const u = new URL(url, origin);
        const evalRes = evaluateBot(parsed, "*", u.pathname + u.search);
        return evalRes.status !== "blocked";
      } catch {
        return true;
      }
    },
    sitemapUrls: parsed.sitemaps.map((loc: string) => {
      try {
        return new URL(loc, origin).toString();
      } catch {
        return loc;
      }
    }),
  };
}

function isProbablySitemapXml(
  contentType: string | null,
  body: string,
): boolean {
  if (contentType?.toLowerCase().includes("xml")) {
    return true;
  }
  const trimmed = body.trimStart().toLowerCase();
  return (
    trimmed.startsWith("<?xml") ||
    trimmed.startsWith("<urlset") ||
    trimmed.startsWith("<sitemapindex")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function getSitemapLocations(input: unknown): string[] {
  if (!input) return [];
  const entries = Array.isArray(input) ? input : [input];
  return entries
    .map((entry) => {
      if (isRecord(entry)) {
        const loc = entry["loc"];
        return typeof loc === "string" ? loc : null;
      }
      return null;
    })
    .filter((loc): loc is string => typeof loc === "string");
}

function getParsedSitemapSections(parsed: unknown): {
  sitemap: unknown;
  url: unknown;
} {
  if (!parsed || typeof parsed !== "object") {
    return { sitemap: undefined, url: undefined };
  }

  const root = parsed as {
    sitemapindex?: { sitemap?: unknown };
    urlset?: { url?: unknown };
  };

  return {
    sitemap: root.sitemapindex?.sitemap,
    url: root.urlset?.url,
  };
}

async function fetchRobotsTxtText(
  origin: string,
  access?: CrawlerAccess | null,
  deps?: DiscoveryDeps,
): Promise<string | null> {
  const fetchFn = deps?.safeFetch ?? safeFetch;
  try {
    const res = await fetchFn(
      `${origin}/robots.txt`,
      {
        headers: {
          "user-agent": "Perceev-Audit/1.0",
          ...crawlerHeadersFor(`${origin}/robots.txt`, access),
        },
        maxBytes: MAX_ROBOTS_TXT_BYTES,
        timeoutMs: 10_000,
        maxRedirects: 5,
        truncate: true,
      },
      { lookup: deps?.lookup },
    );
    if (res.status >= 200 && res.status < 300) {
      return res.text().slice(0, MAX_ROBOTS_TXT_BYTES);
    }
    return null;
  } catch (error) {
    return null;
  }
}

async function fetchSitemapDocumentWithRetry(
  sitemapUrl: string,
  access?: CrawlerAccess | null,
  deps?: DiscoveryDeps,
): Promise<{
  nestedSitemaps: string[];
  pageUrls: string[];
  timedOut: boolean;
}> {
  const normalizedSitemapUrl = normalizeUrl(sitemapUrl);
  if (!normalizedSitemapUrl || !isCrawlableUrl(normalizedSitemapUrl)) {
    return { nestedSitemaps: [], pageUrls: [], timedOut: false };
  }

  const fetchFn = deps?.safeFetch ?? safeFetch;

  for (let attempt = 0; attempt <= SITEMAP_RETRIES; attempt++) {
    try {
      const res = await fetchFn(
        normalizedSitemapUrl,
        {
          headers: {
            "user-agent": "Perceev-Audit/1.0",
            ...crawlerHeadersFor(normalizedSitemapUrl, access),
          },
          maxBytes: MAX_SITEMAP_BYTES,
          timeoutMs: SITEMAP_FETCH_TIMEOUT_MS,
          maxRedirects: 5,
          truncate: true,
        },
        { lookup: deps?.lookup },
      );

      const finalUrl = normalizeUrl(res.url, normalizedSitemapUrl);
      if (!finalUrl || !isSameOrigin(finalUrl, normalizedSitemapUrl)) {
        return { nestedSitemaps: [], pageUrls: [], timedOut: false };
      }

      if (res.status < 200 || res.status >= 300) {
        return { nestedSitemaps: [], pageUrls: [], timedOut: false };
      }

      // If the body was truncated, it exceeded 10 MB; skip shard
      if (res.truncated) {
        return { nestedSitemaps: [], pageUrls: [], timedOut: false };
      }

      const body = res.text();
      const contentType = res.headers.get("content-type");
      if (!isProbablySitemapXml(contentType, body)) {
        return { nestedSitemaps: [], pageUrls: [], timedOut: false };
      }

      const parsed = xmlParser.parse(body) as unknown;
      const sections = getParsedSitemapSections(parsed);
      const nestedSitemaps = getSitemapLocations(sections.sitemap)
        .map((loc) => normalizeUrl(loc, finalUrl))
        .filter((loc): loc is string => loc !== null);
      const pageUrls = getSitemapLocations(sections.url)
        .map((loc) => normalizeUrl(loc, finalUrl))
        .filter((loc): loc is string => loc !== null);

      return { nestedSitemaps, pageUrls, timedOut: false };
    } catch (error: any) {
      const isTimeout =
        error?.name === "TimeoutError" ||
        error?.code === "ETIMEDOUT" ||
        error?.code === "UND_ERR_CONNECT_TIMEOUT";
      if (!isTimeout || attempt === SITEMAP_RETRIES) {
        return { nestedSitemaps: [], pageUrls: [], timedOut: isTimeout };
      }
    }
  }

  return { nestedSitemaps: [], pageUrls: [], timedOut: false };
}

/**
 * Discover all page URLs from robots.txt + sitemaps for an origin.
 */
export async function discoverUrls(
  origin: string,
  maxPages = 50,
  access?: CrawlerAccess | null,
  deps?: DiscoveryDeps,
): Promise<{ urls: string[]; robotsText: string | null }> {
  const deadline = Date.now() + DISCOVERY_TOTAL_BUDGET_MS;
  const robotsText = await fetchRobotsTxtText(origin, access, deps);
  const robots = parseRobotsTxt(origin, robotsText);

  const sitemapSources = new Set(robots.sitemapUrls);
  sitemapSources.add(`${origin}/sitemap.xml`);

  const maxDiscoveredUrls = Math.min(Math.max(maxPages * 20, 500), 50_000);
  const allUrls = new Set<string>();

  const queue: Array<{ url: string; depth: number }> = Array.from(sitemapSources)
    .map((url) => normalizeUrl(url, origin))
    .filter((url): url is string => url !== null)
    .filter((url) => isSameOrigin(url, origin))
    .map((url) => ({ url, depth: MAX_SITEMAP_DEPTH }));

  const seenSitemapDocs = new Set<string>();
  let fetchedDocs = 0;

  while (queue.length > 0 && allUrls.size < maxDiscoveredUrls) {
    if (fetchedDocs >= MAX_SITEMAP_DOCS || Date.now() >= deadline) {
      break;
    }

    const batch = queue.splice(0, SITEMAP_CONCURRENCY);
    await Promise.all(
      batch.map(async ({ url, depth }) => {
        const normalizedUrl = normalizeUrl(url);
        if (
          !normalizedUrl ||
          !isSameOrigin(normalizedUrl, origin) ||
          depth <= 0 ||
          seenSitemapDocs.has(normalizedUrl) ||
          Date.now() >= deadline
        ) {
          return;
        }

        seenSitemapDocs.add(normalizedUrl);
        fetchedDocs += 1;

        const result = await fetchSitemapDocumentWithRetry(
          normalizedUrl,
          access,
          deps,
        );

        for (const pageUrl of result.pageUrls) {
          if (!isSameOrigin(pageUrl, origin)) continue;
          if (allUrls.size >= maxDiscoveredUrls) break;
          allUrls.add(pageUrl);
        }

        if (depth <= 1) return;

        for (const nestedUrl of result.nestedSitemaps) {
          if (!isSameOrigin(nestedUrl, origin)) continue;
          if (!seenSitemapDocs.has(nestedUrl)) {
            queue.push({ url: nestedUrl, depth: depth - 1 });
          }
        }
      }),
    );
  }

  return {
    urls: Array.from(allUrls),
    robotsText,
  };
}
