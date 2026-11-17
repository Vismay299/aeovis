// Hreflang utilities and return-link validation for Perceev site audit.

import { normalizeUrl } from "./urlUtils.ts";
import type { HreflangEntry } from "./types.ts";

const HREFLANG_REGEX = /^(x-default|[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?)$/i;

export function isValidHreflang(code: string): boolean {
  if (typeof code !== "string") return false;
  return HREFLANG_REGEX.test(code.trim());
}

export function isAbsoluteHttpUrl(url: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function pageHreflangProblems(page: {
  hreflang: HreflangEntry[];
  url: string;
}): { invalid: HreflangEntry[]; missingSelf: boolean } {
  if (!page.hreflang || page.hreflang.length === 0) {
    return { invalid: [], missingSelf: false };
  }

  const invalid: HreflangEntry[] = [];
  const normalizedPageUrl = normalizeUrl(page.url);
  let hasSelf = false;

  for (const entry of page.hreflang) {
    const codeValid = isValidHreflang(entry.lang);
    const hrefValid = isAbsoluteHttpUrl(entry.href);

    if (!codeValid || !hrefValid) {
      if (invalid.length < 10) {
        invalid.push(entry);
      }
    }

    if (entry.href && normalizeUrl(entry.href) === normalizedPageUrl) {
      hasSelf = true;
    }
  }

  return {
    invalid,
    missingSelf: !hasSelf,
  };
}

export interface MissingReturnLink {
  pageUrl: string;
  alternateUrl: string;
  lang: string;
}

export function findMissingReturnLinks(
  pages: Array<{
    url: string;
    hreflang?: HreflangEntry[];
    statusCode: number;
    fetchClass: string;
    javascriptShell?: boolean;
  }>,
): MissingReturnLink[] {
  const crawledMap = new Map<string, Set<string>>();

  // First pass: index 2xx ok pages that are not app shells
  for (const p of pages) {
    if (
      p.statusCode >= 200 &&
      p.statusCode < 300 &&
      p.fetchClass === "ok" &&
      !p.javascriptShell
    ) {
      const norm = normalizeUrl(p.url);
      if (norm) {
        const targetUrls = new Set<string>();
        for (const entry of p.hreflang ?? []) {
          if (entry.href) {
            const normHref = normalizeUrl(entry.href);
            if (normHref) targetUrls.add(normHref);
          }
        }
        crawledMap.set(norm, targetUrls);
      }
    }
  }

  const missing: MissingReturnLink[] = [];

  // Second pass: check return links
  for (const p of pages) {
    if (
      p.statusCode >= 200 &&
      p.statusCode < 300 &&
      p.fetchClass === "ok" &&
      !p.javascriptShell
    ) {
      const pageNorm = normalizeUrl(p.url);
      if (!pageNorm) continue;

      for (const entry of p.hreflang ?? []) {
        if (!entry.href) continue;
        const altNorm = normalizeUrl(entry.href);
        if (!altNorm || altNorm === pageNorm) continue;

        // If the alternate was crawled as 2xx ok, it must link back
        const alternateTargets: Set<string> | undefined = crawledMap.get(altNorm);
        if (alternateTargets && !alternateTargets.has(pageNorm)) {
          missing.push({
            pageUrl: p.url,
            alternateUrl: entry.href,
            lang: entry.lang,
          });
        }
      }
    }
  }

  return missing;
}
