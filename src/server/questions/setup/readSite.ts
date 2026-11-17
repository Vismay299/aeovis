// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/scrape.ts:13-261
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { safeFetch, type SafeFetchResult } from "../../../shared/http/safeFetch.ts";
import { scrapeSite } from "../../firecrawl.js";
import { firecrawlScrapeUsd } from "../../../shared/pricing/firecrawl.ts";

export const MAX_SITE_PAGES = 3;
export const MAX_COMPETITOR_PAGES = 2;
export const PER_PAGE_CHAR_LIMIT = 4000;
export const FETCH_TIMEOUT_MS = 10000;
export const MAX_RESPONSE_BYTES = 2000000;

export type ScrapedPage = {
  url: string;
  title: string | null;
  content: string;
};

export type ReadSiteDeps = {
  safeFetch?: typeof safeFetch;
  scrapeSite?: typeof scrapeSite;
  firecrawlScrapeUsd?: () => number;
  scrapeDeps?: Record<string, unknown>;
};

export function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

export function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return match ? decodeEntities(match[1].trim()) : null;
}

export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = withoutBlocks
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return decodeEntities(text);
}

export function parseSitemapUrls(xml: string, origin: string): string[] {
  const urls: string[] = [];
  const regex = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let expectedOrigin: string;
  try {
    expectedOrigin = new URL(origin).origin;
  } catch {
    return urls;
  }
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    let resolved: URL;
    try {
      resolved = new URL(match[1], expectedOrigin);
    } catch {
      continue;
    }
    if (resolved.origin === expectedOrigin && !resolved.pathname.toLowerCase().endsWith(".xml")) {
      urls.push(resolved.toString());
    }
  }
  return urls;
}

function ensureHttpUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

export async function discoverSiteUrls(
  root: string,
  limit: number = MAX_SITE_PAGES,
  deps?: ReadSiteDeps,
): Promise<string[]> {
  const rootUrl = ensureHttpUrl(root);
  let origin: string;
  let canonicalRoot = rootUrl;
  try {
    const parsedRoot = new URL(rootUrl);
    origin = parsedRoot.origin;
    canonicalRoot = parsedRoot.toString();
  } catch {
    return [rootUrl].slice(0, limit);
  }

  const fetcher = deps?.safeFetch ?? safeFetch;
  let discovered: string[] = [];

  try {
    const sitemapRes = await fetcher(`${origin}/sitemap.xml`, {
      timeoutMs: FETCH_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
    });
    if (sitemapRes.status >= 200 && sitemapRes.status < 300) {
      const xml = await sitemapRes.text();
      discovered = parseSitemapUrls(xml, origin);
    }
  } catch {
    // Sitemap failure falls back to root URL
  }

  const combined = [...new Set([canonicalRoot, ...discovered])];
  return combined.slice(0, Math.max(0, limit));
}

export async function readPagesFree(
  urls: string[],
  max: number = MAX_SITE_PAGES,
  deps?: ReadSiteDeps,
): Promise<{ pages: ScrapedPage[]; failed: string[] }> {
  const fetcher = deps?.safeFetch ?? safeFetch;
  const pages: ScrapedPage[] = [];
  const failed: string[] = [];

  for (const rawUrl of urls.slice(0, max)) {
    const url = ensureHttpUrl(rawUrl);
    try {
      const res: SafeFetchResult = await fetcher(url, {
        timeoutMs: FETCH_TIMEOUT_MS,
        maxBytes: MAX_RESPONSE_BYTES,
        headers: { accept: "text/html,*/*" },
      });

      if (res.status < 200 || res.status >= 300) {
        failed.push(url);
        continue;
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("text/html")) {
        // Non-HTML skipped
        failed.push(url);
        continue;
      }

      const html = typeof res.text === "function" ? await res.text() : "";
      const text = htmlToText(html).slice(0, PER_PAGE_CHAR_LIMIT);
      if (text.length === 0) {
        failed.push(url);
        continue;
      }

      const title = extractTitle(html);
      pages.push({ url, title, content: text });
    } catch {
      failed.push(url);
    }
  }

  return { pages, failed };
}

export type MeterFunction = <T>(
  opts: { estimateUsd: number },
  fn: () => Promise<{
    value: T;
    actualUsd: number | null;
    provider: string;
    endpoint: string;
    billed: boolean;
  }>,
) => Promise<T>;

export async function readPageFirecrawl(
  url: string,
  meter: MeterFunction,
  deps?: ReadSiteDeps,
): Promise<{ page: ScrapedPage | null; billed: boolean }> {
  const scrape = deps?.scrapeSite ?? scrapeSite;
  const scrapeUsd = deps?.firecrawlScrapeUsd ? deps.firecrawlScrapeUsd() : firecrawlScrapeUsd();

  const outcome = await meter({ estimateUsd: scrapeUsd }, async () => {
    const r = await scrape(url, deps?.scrapeDeps);
    const billed = r?.source === "firecrawl";
    return {
      value: r,
      actualUsd: null,
      provider: "firecrawl",
      endpoint: "v1/scrape",
      billed,
    };
  });

  const billed = outcome?.source === "firecrawl";
  if (outcome?.content && typeof outcome.content === "string" && outcome.content.trim().length > 0) {
    const content = outcome.content.slice(0, PER_PAGE_CHAR_LIMIT);
    return {
      page: {
        url,
        title: (outcome as any).title ?? null,
        content,
      },
      billed,
    };
  }

  return { page: null, billed };
}

export async function readSiteWithWwwRetry(
  domain: string,
  limit: number = MAX_SITE_PAGES,
  deps?: ReadSiteDeps,
): Promise<{ pages: ScrapedPage[]; failed: string[] }> {
  const urls = await discoverSiteUrls(domain, limit, deps);
  const result = await readPagesFree(urls, limit, deps);
  if (result.pages.length > 0) return result;

  try {
    const parsed = new URL(ensureHttpUrl(domain));
    if (!parsed.hostname.startsWith("www.")) {
      parsed.hostname = `www.${parsed.hostname}`;
      const retryUrls = await discoverSiteUrls(parsed.toString(), limit, deps);
      const retryResult = await readPagesFree(retryUrls, limit, deps);
      if (retryResult.pages.length > 0) return retryResult;
    }
  } catch {
    // ignore
  }

  return result;
}
