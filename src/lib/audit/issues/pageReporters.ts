// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/issues/page-reporters.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * Per-page issue reporters.
 *
 * Evaluates the ported and Perceev technical SEO issues on a single crawled page.
 */

import type { AuditIssueType } from "../../../shared/audit-issues.ts";
import type { CrawledPageResult } from "../types.ts";
import type { parseRobotsTxt } from "../../crawlers/robots.js";
import { blockedAiBots } from "../aiAccess.ts";
import { pathAndQuery } from "../robotsFile.ts";
import { pageHreflangProblems } from "../hreflang.ts";

export interface DetectedIssue {
  issueType: AuditIssueType;
  pageId: string | null;
  pageUrl: string;
  details?: Record<string, unknown>;
  dedupeKey?: string;
}

const TITLE_MAX_CHARS = 60;
const TITLE_MIN_CHARS = 10;
const META_DESCRIPTION_MAX_CHARS = 160;
const META_DESCRIPTION_MIN_CHARS = 70;
const THIN_CONTENT_WORDS = 150;
const SLOW_RESPONSE_MS = 1500;
const DEEP_PAGE_DEPTH = 5;
const MAX_FLAGGED_TEXT_CHARS = 100;

function truncateFlaggedText(text: string): string {
  return text.length > MAX_FLAGGED_TEXT_CHARS
    ? `${text.slice(0, MAX_FLAGGED_TEXT_CHARS)}…`
    : text;
}

function hasHeadingLevelSkip(headingOrder: number[]): boolean {
  for (let i = 1; i < headingOrder.length; i++) {
    if (headingOrder[i] > headingOrder[i - 1] + 1) return true;
  }
  return false;
}

export function runPageReporters(
  page: CrawledPageResult,
  ctx?: { robots: ReturnType<typeof parseRobotsTxt> | null; robotsUsable: boolean },
): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const report = (
    issueType: AuditIssueType,
    details?: Record<string, unknown>,
    dedupeKey?: string,
  ) => issues.push({ issueType, pageId: page.id, pageUrl: page.url, details, dedupeKey });

  if (page.fetchClass === "blocked") {
    report("blocked-page", { statusCode: page.statusCode });
    return issues;
  }
  if (page.fetchClass === "rate_limited") {
    report("rate-limited-page", { statusCode: page.statusCode });
    return issues;
  }
  if (page.fetchClass === "error") {
    return issues;
  }

  if (page.statusCode >= 500) {
    report("server-error", { statusCode: page.statusCode });
    return issues;
  }
  if (page.statusCode >= 400) {
    report("broken-page", { statusCode: page.statusCode });
    return issues;
  }
  if (page.statusCode >= 300) {
    return issues;
  }

  if (page.responseTimeMs > SLOW_RESPONSE_MS) {
    report("slow-response", { responseTimeMs: page.responseTimeMs });
  }

  if (!page.isHtml) {
    return issues;
  }

  // Indexability + canonical signals
  if (!page.isIndexable) {
    report("noindex-page", {
      robotsMeta: page.robotsMeta,
      xRobotsTag: page.xRobotsTag,
    });
  }
  if (
    page.canonicalUrl &&
    page.headerCanonicalUrl &&
    page.canonicalUrl !== page.headerCanonicalUrl
  ) {
    report("canonical-conflict", {
      htmlCanonical: page.canonicalUrl,
      headerCanonical: page.headerCanonicalUrl,
    });
  }
  const effectiveCanonical = page.canonicalUrl ?? page.headerCanonicalUrl;
  if (effectiveCanonical && effectiveCanonical !== page.url) {
    report("canonicalized-page", { canonicalUrl: effectiveCanonical });
  }

  if (page.crawlDepth !== null && page.crawlDepth >= DEEP_PAGE_DEPTH) {
    report("deep-page", { crawlDepth: page.crawlDepth });
  }

  // AI-crawler verdicts run on every 2xx ok HTML page including app shells
  if (ctx?.robotsUsable && ctx.robots) {
    const blocked = blockedAiBots(ctx.robots, pathAndQuery(page.url));
    if (blocked.search.length > 0) {
      report("ai-search-crawler-blocked", { bots: blocked.search });
    }
    if (blocked.agent.length > 0) {
      report("ai-agent-crawler-blocked", { bots: blocked.agent });
    }
  }

  // App shells skip content checks
  if (page.javascriptShell) {
    report("javascript-rendering-suspected", { wordCount: page.wordCount });
    return issues;
  }

  // Titles
  if (!page.title) {
    report("missing-title");
  } else if (page.title.length > TITLE_MAX_CHARS) {
    report("title-too-long", {
      length: page.title.length,
      max: TITLE_MAX_CHARS,
      title: truncateFlaggedText(page.title),
    });
  } else if (page.title.length < TITLE_MIN_CHARS) {
    report("title-too-short", {
      length: page.title.length,
      min: TITLE_MIN_CHARS,
      title: page.title,
    });
  }

  // Meta description
  if (!page.metaDescription) {
    report("missing-meta-description");
  } else if (page.metaDescription.length > META_DESCRIPTION_MAX_CHARS) {
    report("meta-description-too-long", {
      length: page.metaDescription.length,
      max: META_DESCRIPTION_MAX_CHARS,
      description: truncateFlaggedText(page.metaDescription),
    });
  } else if (page.metaDescription.length < META_DESCRIPTION_MIN_CHARS) {
    report("meta-description-too-short", {
      length: page.metaDescription.length,
      min: META_DESCRIPTION_MIN_CHARS,
      description: page.metaDescription,
    });
  }

  // Headings
  if (page.h1Count === 0) {
    report("missing-h1");
  } else if (page.h1Count > 1) {
    report("multiple-h1", { h1Count: page.h1Count });
  }
  if (hasHeadingLevelSkip(page.headingOrder)) {
    report("heading-order-skip");
  }

  // Content quality
  if (page.isIndexable && page.wordCount < THIN_CONTENT_WORDS) {
    report("thin-content", { wordCount: page.wordCount });
  }
  if (page.imagesMissingAlt > 0) {
    report("images-missing-alt", {
      imagesMissingAlt: page.imagesMissingAlt,
      imagesTotal: page.imagesTotal,
    });
  }

  // Structure
  if (page.isIndexable && page.links.length === 0) {
    report("no-outgoing-links");
  }

  // --- Perceev page checks ---
  // Structured data
  if (page.structuredData) {
    const invalidCount = page.structuredData.blocks.filter((b) => b.parseState === "invalid").length;
    if (invalidCount > 0) {
      report("structured-data-invalid", { blocks: invalidCount });
    }
    if (page.structuredData.missingType > 0) {
      report("structured-data-missing-type", { objects: page.structuredData.missingType });
    }
    if (page.structuredData.missingRequired.length > 0) {
      report("structured-data-missing-required", {
        items: page.structuredData.missingRequired.slice(0, 10),
      });
    }
    if (page.structuredData.claimsNotVisible.length > 0) {
      report("structured-data-not-visible", {
        claims: page.structuredData.claimsNotVisible.slice(0, 20),
      });
    }
    if (
      page.isIndexable &&
      page.wordCount >= 150 &&
      page.structuredData.blocks.length === 0
    ) {
      report("no-structured-data");
    }
  }

  // Open Graph
  if (page.isIndexable) {
    const missingOg: string[] = [];
    if (!page.ogTitle) missingOg.push("og:title");
    if (!page.ogDescription) missingOg.push("og:description");
    if (!page.ogImage) missingOg.push("og:image");
    if (missingOg.length > 0) {
      report("missing-og-tags", { missing: missingOg });
    }
  }

  // Hreflang
  const hlProblems = pageHreflangProblems({ hreflang: page.hreflang, url: page.url });
  if (hlProblems.invalid.length > 0) {
    report("hreflang-invalid", { entries: hlProblems.invalid.slice(0, 10) });
  }
  if (hlProblems.missingSelf) {
    report("hreflang-missing-self", { alternates: page.hreflang.length });
  }

  // Snippet restrictions
  const snippetSources: string[] = [];
  const nosnippetRegex = /(?:^|[,\s])(?:nosnippet|max-snippet:\s*0)(?:$|[,\s])/i;
  if (nosnippetRegex.test(page.robotsMeta ?? "")) {
    snippetSources.push("meta:robots");
  }
  if (nosnippetRegex.test(page.xRobotsTag ?? "")) {
    snippetSources.push("x-robots-tag");
  }
  if (page.dataNosnippet) {
    snippetSources.push("data-nosnippet");
  }
  if (snippetSources.length > 0) {
    report("snippet-restricted", { sources: snippetSources });
  }

  return issues;
}
