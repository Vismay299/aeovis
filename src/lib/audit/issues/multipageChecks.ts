// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/issues/multipage-checks.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * Pure cross-page checks (no database access):
 * duplicate grouping, redirect chain/loop detection, and hreflang return link checks.
 */

import type { DetectedIssue } from "./pageReporters.ts";
import type { PageFetchClass } from "../../../shared/audit-fetch-class.ts";
import type { HreflangEntry } from "../types.ts";
import { findMissingReturnLinks } from "../hreflang.ts";

const DUPLICATE_GROUP_SAMPLE = 3;

export interface SlimPage {
  id: string;
  url: string;
  statusCode: number | null;
  fetchClass: PageFetchClass;
  title: string | null;
  metaDescription: string | null;
  contentHash: string | null;
  redirectUrl: string | null;
  wordCount: number;
  isIndexable: boolean;
  canonicalUrl: string | null;
  headerCanonicalUrl: string | null;
  javascriptShell?: boolean;
  hreflang?: HreflangEntry[];
}

function isOkHtmlPage(page: SlimPage): boolean {
  return (
    page.fetchClass === "ok" &&
    page.statusCode !== null &&
    page.statusCode >= 200 &&
    page.statusCode < 300
  );
}

function isDuplicateCandidate(page: SlimPage): boolean {
  if (!isOkHtmlPage(page) || !page.isIndexable || page.javascriptShell) {
    return false;
  }
  const effectiveCanonical = page.canonicalUrl ?? page.headerCanonicalUrl;
  return !effectiveCanonical || effectiveCanonical === page.url;
}

export function findDuplicates(pages: SlimPage[]): DetectedIssue[] {
  const okPages = pages.filter(isDuplicateCandidate);

  const groupBy = (
    keyOf: (page: SlimPage) => string | null,
  ): Map<string, SlimPage[]> => {
    const groups = new Map<string, SlimPage[]>();
    for (const page of okPages) {
      const key = keyOf(page);
      if (!key) continue;
      const group = groups.get(key);
      if (group) group.push(page);
      else groups.set(key, [page]);
    }
    return groups;
  };

  const issues: DetectedIssue[] = [];
  const emitGroups = (
    groups: Map<string, SlimPage[]>,
    issueType: DetectedIssue["issueType"],
  ) => {
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      for (const page of group) {
        issues.push({
          issueType,
          pageId: page.id,
          pageUrl: page.url,
          details: {
            groupSize: group.length,
            otherUrls: group
              .filter((other) => other.id !== page.id)
              .slice(0, DUPLICATE_GROUP_SAMPLE)
              .map((other) => other.url),
          },
        });
      }
    }
  };

  emitGroups(
    groupBy((page) => page.title || null),
    "duplicate-title",
  );
  emitGroups(
    groupBy((page) => page.metaDescription || null),
    "duplicate-meta-description",
  );
  emitGroups(
    groupBy((page) => (page.wordCount > 0 ? page.contentHash : null)),
    "duplicate-content",
  );
  return issues;
}

export function findRedirectChainsAndLoops(pages: SlimPage[]): DetectedIssue[] {
  const redirects = new Map<string, SlimPage>();
  for (const page of pages) {
    const isRedirect =
      page.statusCode !== null &&
      page.statusCode >= 300 &&
      page.statusCode < 400 &&
      page.redirectUrl;
    if (isRedirect) redirects.set(page.url, page);
  }

  const redirectTargets = new Set(
    Array.from(redirects.values(), (page) => page.redirectUrl!),
  );

  const issues: DetectedIssue[] = [];
  const walked = new Set<string>();

  for (const [url, head] of redirects) {
    if (redirectTargets.has(url)) continue;

    const hops: string[] = [url];
    const seen = new Set(hops);
    walked.add(url);
    let current = head.redirectUrl;
    let isLoop = false;
    while (current) {
      if (seen.has(current)) {
        isLoop = true;
        hops.push(current);
        break;
      }
      hops.push(current);
      seen.add(current);
      if (redirects.has(current)) walked.add(current);
      current = redirects.get(current)?.redirectUrl ?? null;
    }

    if (isLoop) {
      issues.push({
        issueType: "redirect-loop",
        pageId: head.id,
        pageUrl: url,
        details: { hops },
      });
    } else if (hops.length > 2) {
      issues.push({
        issueType: "redirect-chain",
        pageId: head.id,
        pageUrl: url,
        details: { hops, finalUrl: hops[hops.length - 1] },
      });
    }
  }

  for (const [url, page] of redirects) {
    if (walked.has(url)) continue;

    const cycle: string[] = [];
    let current: string | null = url;
    while (current && !walked.has(current)) {
      walked.add(current);
      cycle.push(current);
      current = redirects.get(current)?.redirectUrl ?? null;
    }
    issues.push({
      issueType: "redirect-loop",
      pageId: page.id,
      pageUrl: url,
      details: { hops: [...cycle, url] },
    });
  }

  return issues;
}

export function findHreflangReturnLinks(
  pages: Array<{
    id?: string;
    url: string;
    hreflang?: HreflangEntry[];
    statusCode: number;
    fetchClass: PageFetchClass;
    javascriptShell?: boolean;
  }>,
): DetectedIssue[] {
  const missing = findMissingReturnLinks(pages);
  const pageIdByUrl = new Map<string, string | null>();
  for (const p of pages) {
    pageIdByUrl.set(p.url, p.id ?? null);
  }

  return missing.map((item) => ({
    issueType: "hreflang-no-return-link",
    pageId: pageIdByUrl.get(item.pageUrl) ?? null,
    pageUrl: item.pageUrl,
    dedupeKey: item.alternateUrl,
    details: {
      alternate: item.alternateUrl,
      lang: item.lang,
    },
  }));
}
