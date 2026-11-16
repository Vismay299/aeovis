// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/scrape.ts
//   src/server/features/sam/samChatTools.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { safeFetch as defaultSafeFetch } from "../../http/safeFetch.ts";
import {
  declaredCompetitors as defaultDeclaredCompetitors,
} from "../../projectContext/service.ts";
import type {
  ToolDefinition,
  ToolHandlerContext,
  TurnMemory,
} from "../types.ts";

const MAX_MAPPED_URLS = 60;
const PER_PAGE_CHAR_LIMIT = 4000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_RESPONSE_BYTES = 2_000_000;

/** Strips scripts/styles/tags and collapses whitespace into readable text. */
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

function decodeEntities(value: string): string {
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

/** Resolves `<loc>` entries against the origin and keeps same-origin HTML pages. */
export function parseSitemapUrls(xml: string, origin: string): string[] {
  const urls: string[] = [];
  const regex = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(xml)) !== null) {
    let resolved: URL;
    try {
      resolved = new URL(match[1], origin);
    } catch {
      continue;
    }
    if (resolved.origin !== origin) continue;
    if (resolved.pathname.endsWith(".xml")) continue;
    resolved.hash = "";
    urls.push(resolved.toString());
  }
  return urls;
}

/** Lower-case host without a trailing dot or a leading `www.`. */
export function normaliseHost(raw: string): string {
  let host = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return "";
    }
  }
  host = host.replace(/\.$/, "");
  return host.replace(/^www\./, "");
}

function hostIsOrSubdomain(host: string, domain: string): boolean {
  const normalised = normaliseHost(domain);
  return Boolean(normalised) && (host === normalised || host.endsWith("." + normalised));
}

function ownHost(ctx: ToolHandlerContext): string {
  return normaliseHost(ctx.brand.website_host || ctx.brand.website || "");
}

function parseAllowedUrl(raw: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed;
}

/** The URL without its fragment, canonicalised by the URL parser. */
export function urlWithoutFragment(raw: string): string {
  const parsed = new URL(raw);
  parsed.hash = "";
  return parsed.toString();
}

function isHomepage(parsed: URL): boolean {
  return (parsed.pathname === "/" || parsed.pathname === "") && parsed.search === "";
}

type Row = Record<string, any>;

async function readCitationUrls(ctx: ToolHandlerContext): Promise<readonly string[]> {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString();
  try {
    const { data, error } = (await ctx.admin
      .from("citations")
      .select("url")
      .eq("brand", ctx.brand.brandKey)
      .gte("created_at", since)) as {
      data: Row[] | null;
      error: unknown;
    };
    if (error) return [];
    return (Array.isArray(data) ? data : [])
      .map((row) => (typeof row.url === "string" ? row.url : ""))
      .filter(Boolean)
      .map((url) => {
        try {
          return urlWithoutFragment(url);
        } catch {
          return "";
        }
      })
      .filter(Boolean);
  } catch {
    // A citation read failure denies citation URLs; own and competitor hosts
    // are still usable, so site reading degrades instead of failing the tool.
    return [];
  }
}

async function loadCompetitorDomains(ctx: ToolHandlerContext): Promise<string[]> {
  try {
    const competitors = await defaultDeclaredCompetitors(ctx.admin, ctx.brand.brandKey);
    return competitors.map((competitor) => competitor.domain).filter(Boolean);
  } catch {
    return [];
  }
}

export type SiteReadDeps = {
  safeFetch?: typeof defaultSafeFetch;
  declaredCompetitors?: typeof defaultDeclaredCompetitors;
  competitorDomains?: readonly string[];
  citationUrls?: () => Promise<readonly string[]>;
};

async function competitorDomainsFor(
  ctx: ToolHandlerContext,
  deps: SiteReadDeps,
): Promise<readonly string[]> {
  if (deps.competitorDomains) return deps.competitorDomains;
  if (deps.declaredCompetitors) {
    try {
      const rows = await deps.declaredCompetitors(ctx.admin, ctx.brand.brandKey);
      return rows.map((row) => row.domain).filter(Boolean);
    } catch {
      return [];
    }
  }
  return loadCompetitorDomains(ctx);
}

/**
 * The allow rule: own host/subdomain; a declared competitor's homepage or a
 * URL mapped for that host earlier in this turn; or an exact stored citation.
 */
export async function isAllowedReadUrl(
  raw: string,
  ctx: ToolHandlerContext,
  turnMemory?: TurnMemory,
  deps: SiteReadDeps = {},
): Promise<boolean> {
  const parsed = parseAllowedUrl(raw);
  if (!parsed) return false;

  const host = normaliseHost(parsed.hostname);
  const own = ownHost(ctx);
  if (own && hostIsOrSubdomain(host, own)) return true;

  const competitors = await competitorDomainsFor(ctx, deps);
  const competitor = competitors.some((domain) => hostIsOrSubdomain(host, domain));
  if (competitor) {
    if (isHomepage(parsed)) return true;
    const target = urlWithoutFragment(parsed.toString());
    const mapped = turnMemory?.mappedUrls?.[host] ?? [];
    if (mapped.includes(target)) return true;
  }

  const citations = deps.citationUrls
    ? await deps.citationUrls()
    : await readCitationUrls(ctx);
  return citations.includes(urlWithoutFragment(parsed.toString()));
}

function rememberMappedUrls(
  turnMemory: TurnMemory | undefined,
  host: string,
  urls: readonly string[],
): void {
  if (!turnMemory) return;
  if (!turnMemory.mappedUrls) turnMemory.mappedUrls = {};
  turnMemory.mappedUrls[host] = urls;
}

const mapInput = z.strictObject({
  host: z.string().trim().max(253).optional(),
});

const mapOutput = z.looseObject({
  host: z.string(),
  urls: z.array(z.string()),
  blocked: z.boolean(),
});

const readInput = z.strictObject({
  urls: z.array(z.url().max(2048)).min(1).max(10),
});

const readOutput = z.looseObject({
  pages: z.array(
    z.looseObject({
      url: z.string(),
      title: z.string().nullable(),
      text: z.string(),
    }),
  ),
  skipped: z.array(
    z.looseObject({
      url: z.string(),
      reason: z.enum(["host_not_allowed", "unreachable", "empty", "blocked"]),
    }),
  ),
});

export function createMapSitePagesTool(deps: SiteReadDeps = {}): ToolDefinition {
  return {
    name: "map_site_pages",
    description:
      "List a workspace or declared-competitor site's homepage and sitemap URLs.",
    input: mapInput,
    output: mapOutput,
    handler: async (ctx, raw) => {
      const input = mapInput.parse(raw);
      const requested = normaliseHost(input.host || ownHost(ctx));
      if (!requested) {
        return mapOutput.parse({ host: "", urls: [], blocked: true });
      }

      const own = ownHost(ctx);
      const competitors = await competitorDomainsFor(ctx, deps);
      const allowed =
        (own && hostIsOrSubdomain(requested, own)) ||
        competitors.some((domain) => hostIsOrSubdomain(requested, domain));
      if (!allowed) {
        return mapOutput.parse({ host: requested, urls: [], blocked: true });
      }

      const origin = `https://${requested}`;
      let sitemap = "";
      try {
        const fetcher = deps.safeFetch ?? defaultSafeFetch;
        const response = await fetcher(`${origin}/sitemap.xml`, {
          method: "GET",
          headers: { accept: "application/xml,text/xml,text/html,*/*" },
          maxBytes: MAX_RESPONSE_BYTES,
          timeoutMs: FETCH_TIMEOUT_MS,
          maxRedirects: MAX_REDIRECTS,
        });
        if (response.status >= 200 && response.status < 300) {
          sitemap = response.text();
        }
      } catch {
        sitemap = "";
      }

      const urls = [origin + "/", ...parseSitemapUrls(sitemap, origin)]
        .filter((url, index, all) => all.indexOf(url) === index)
        .slice(0, MAX_MAPPED_URLS);

      rememberMappedUrls(ctx.turnMemory, requested, urls);

      return mapOutput.parse({ host: requested, urls, blocked: false });
    },
  };
}

export function createReadPagesTool(deps: SiteReadDeps = {}): ToolDefinition {
  return {
    name: "read_pages",
    description:
      "Read up to ten allowed pages as plain text: the workspace site, declared-competitor pages mapped this turn, or stored citations.",
    input: readInput,
    output: readOutput,
    handler: async (ctx, raw) => {
      const input = readInput.parse(raw);
      const competitorDomains = await competitorDomainsFor(ctx, deps);
      let citationCache: readonly string[] | null = null;
      const allowDeps: SiteReadDeps = {
        ...deps,
        competitorDomains,
        citationUrls: async () => {
          if (citationCache === null) {
            citationCache = deps.citationUrls
              ? await deps.citationUrls()
              : await readCitationUrls(ctx);
          }
          return citationCache;
        },
      };
      const fetcher = deps.safeFetch ?? defaultSafeFetch;
      const pages: Array<{ url: string; title: string | null; text: string }> = [];
      const skipped: Array<{
        url: string;
        reason: "host_not_allowed" | "unreachable" | "empty" | "blocked";
      }> = [];

      for (const url of input.urls) {
        const allowed = await isAllowedReadUrl(url, ctx, ctx.turnMemory, allowDeps);
        if (!allowed) {
          skipped.push({ url, reason: "host_not_allowed" });
          continue;
        }

        let response: Awaited<ReturnType<typeof defaultSafeFetch>>;
        try {
          response = await fetcher(url, {
            method: "GET",
            headers: { accept: "text/html,*/*" },
            maxBytes: MAX_RESPONSE_BYTES,
            timeoutMs: FETCH_TIMEOUT_MS,
            maxRedirects: MAX_REDIRECTS,
          });
        } catch {
          skipped.push({ url, reason: "unreachable" });
          continue;
        }

        if (response.status === 401 || response.status === 403 || response.status === 429) {
          skipped.push({ url, reason: "blocked" });
          continue;
        }
        if (response.status < 200 || response.status >= 300) {
          skipped.push({ url, reason: "unreachable" });
          continue;
        }

        // A redirect must not escape the allow rule. Re-check the final URL
        // whenever it differs from the requested URL at all, so a same-host
        // redirect from a mapped competitor page to an unmapped deep page is
        // refused as well.
        let finalUrl = response.url;
        let requestedUrl = url;
        try {
          finalUrl = urlWithoutFragment(response.url);
          requestedUrl = urlWithoutFragment(url);
        } catch {
          // safeFetch always returns a URL, but never widen the rule on a parse failure.
          skipped.push({ url, reason: "host_not_allowed" });
          continue;
        }
        if (
          finalUrl !== requestedUrl &&
          !(await isAllowedReadUrl(response.url, ctx, ctx.turnMemory, allowDeps))
        ) {
          skipped.push({ url, reason: "host_not_allowed" });
          continue;
        }

        const html = response.text();
        const text = htmlToText(html).slice(0, PER_PAGE_CHAR_LIMIT);
        if (text.length === 0) {
          skipped.push({ url, reason: "empty" });
          continue;
        }

        pages.push({ url, title: extractTitle(html), text });
      }

      return readOutput.parse({ pages, skipped });
    },
  };
}

export const mapSitePagesTool = createMapSitePagesTool();
export const readPagesTool = createReadPagesTool();
