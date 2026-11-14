import test from "node:test";
import assert from "node:assert/strict";
import { inspectPage as inspectPageRaw } from "../repairs/technicalAudit.js";
const inspectPage = inspectPageRaw as unknown as (args: any) => any;
import { parseRobotsTxt } from "../crawlers/robots.js";
import { analyzeHtml } from "./pageAnalyzer.ts";
import { inspectJsonLd } from "./structuredData.ts";
import { runPageReporters } from "./issues/pageReporters.ts";
import { classifyFetch } from "./classifyFetch.ts";
import { normalizeUrl } from "./urlUtils.ts";
import { blockedAiBots } from "./aiAccess.ts";
import { pathAndQuery } from "./robotsFile.ts";
import { isIndexableFromDirectives } from "./fetchPage.ts";
import { R15_TO_F18, expectedF18ForR15 } from "./r15Parity.ts";
import type { CrawledPageResult } from "./types.ts";

function buildF18Page(input: {
  url: string;
  html: string;
  status?: number;
  headers?: Record<string, string>;
  robotsText?: string | null;
}): { page: CrawledPageResult; robots: ReturnType<typeof parseRobotsTxt> | null; robotsUsable: boolean } {
  const url = input.url;
  const html = input.html;
  const status = input.status ?? 200;
  const headers = input.headers ?? {};
  const xRobotsTag =
    headers["x-robots-tag"] ?? headers["X-Robots-Tag"] ?? headers["x-robots-Tag"] ?? null;
  const analysis = analyzeHtml(html, url, status, 200);
  const fetchClass = classifyFetch(status, false, html.slice(0, 4000));
  const robots = input.robotsText == null ? null : parseRobotsTxt(input.robotsText);
  // robotsUsable is true only for found/missing (spec §6.2.5). For parity we treat
  // an explicitly supplied robots text as found, and absent text as unusable
  // unless the caller says otherwise.
  const robotsUsable = robots != null;
  const isIndexable = isIndexableFromDirectives(analysis.robotsMeta, xRobotsTag);
  const canonicalUrl = analysis.canonical ? (normalizeUrl(analysis.canonical, url) ?? analysis.canonical) : null;
  const headingCount = (level: number): number => analysis.headingOrder.filter((h) => h === level).length;
  const structuredData = analysis.javascriptShell
    ? { blocks: [], missingType: 0, missingRequired: [], claimsNotVisible: [] }
    : inspectJsonLd(analysis.jsonLdBlocks, analysis.bodyText);
  const structuredDataTypes = Array.from(new Set(structuredData.blocks.flatMap((b) => b.types))).slice(0, 20);
  const page: CrawledPageResult = {
    id: "parity-page",
    url,
    statusCode: status,
    fetchClass,
    redirectUrl: null,
    title: analysis.title,
    metaDescription: analysis.metaDescription,
    canonicalUrl,
    robotsMeta: analysis.robotsMeta,
    xRobotsTag,
    headerCanonicalUrl: null,
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
    contentHash: null,
    isHtml: true,
    javascriptShell: analysis.javascriptShell === true,
    htmlBytes: Buffer.byteLength(html),
    rateLimited: false,
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
    rendered: false,
    isIndexable,
    responseTimeMs: 200,
    crawlDepth: 1,
    inSitemap: false,
  };
  return { page, robots, robotsUsable };
}

function f18Types(
  page: CrawledPageResult,
  ctx?: { robots: ReturnType<typeof parseRobotsTxt> | null; robotsUsable: boolean },
): string[] {
  return runPageReporters(page, ctx).map((i) => i.issueType);
}

test("R15_TO_F18 covers every R15 code from §6.2.11", () => {
  const keys = Object.keys(R15_TO_F18).sort();
  assert.deepEqual(keys, [
    "access_denied",
    "canonical_other_url",
    "data_nosnippet",
    "http_status",
    "insufficient_source_text",
    "restrictive_directive",
    "structured_data_requires_review",
  ]);
});

test("R15 fixture 1 (combined restrictions, canonical, data-nosnippet) maps to F18", () => {
  const url = "https://example.com/page";
  const html =
    '<meta name="robots" content="index,follow"><meta content="noindex,nosnippet" name="googlebot"><link href="/canonical" rel="canonical"><main data-nosnippet>Product facts</main>';
  const headers = { "x-robots-tag": "max-snippet:0" };
  const robotsText = "User-agent: GPTBot\nDisallow: /\nUser-agent: OAI-SearchBot\nAllow: /";
  const robots = parseRobotsTxt(robotsText);
  const r15 = inspectPage({ url, html, headers, robots, robotsState: "found" });
  // R15 fixture asserts (mirrors r15-technical-evidence.test.mjs)
  assert.ok(r15.issues.some((i: any) => i.code === "restrictive_directive"));
  assert.ok(r15.issues.some((i: any) => i.code === "data_nosnippet"));
  const { page, robots: f18Robots, robotsUsable } = buildF18Page({ url, html, headers, robotsText });
  const types = f18Types(page, { robots: f18Robots, robotsUsable });
  // data_nosnippet → snippet-restricted
  assert.ok(types.includes("snippet-restricted"), `expected snippet-restricted in ${types.join(",")}`);
  // canonical_other_url → canonicalized-page
  assert.ok(r15.issues.some((i: any) => i.code === "canonical_other_url"));
  assert.ok(types.includes("canonicalized-page"), `expected canonicalized-page in ${types.join(",")}`);
  // restrictive_directive: googlebot "noindex,nosnippet" and x-robots "max-snippet:0".
  // Every R15 positive must be an F18 positive (§6.2.11), including the
  // googlebot-only noindex.
  const restrictive = r15.issues.filter((i: any) => i.code === "restrictive_directive");
  assert.equal(restrictive.length, 2);
  for (const r of restrictive) {
    const value = String((r.evidence as { value?: string })?.value ?? "");
    for (const t of expectedF18ForR15("restrictive_directive", { value })) {
      assert.ok(types.includes(t), `restrictive ${value} expected ${t} in ${types.join(",")}`);
    }
  }
  assert.ok(types.includes("noindex-page"), `expected noindex-page in ${types.join(",")}`);
  // insufficient_source_text (< 150 chars) → thin-content (< 150 words). F18
  // (like the upstream port) only reports thin content on indexable pages; this page is
  // noindex for Googlebot, so F18 reports noindex-page instead.
  assert.ok(r15.issues.some((i: any) => i.code === "insufficient_source_text"));
  assert.equal(page.isIndexable, false);
  assert.ok(!types.includes("thin-content"));
  // Per-bot verdicts agree: R15 GPTBot blocked, OAI-SearchBot open
  assert.equal(r15.robots.find((b: any) => b.name === "GPTBot")?.status, "blocked");
  assert.equal(r15.robots.find((b: any) => b.name === "OAI-SearchBot")?.status, "open");
  const blocked = blockedAiBots(robots, pathAndQuery(url));
  assert.ok(blocked.training.includes("GPTBot"));
  assert.ok(!blocked.search.includes("OAI-SearchBot"));
  // F18 page reporters emit no search/agent blocks for this robots.txt
  assert.ok(!types.includes("ai-search-crawler-blocked"));
  assert.ok(!types.includes("ai-agent-crawler-blocked"));
});

test("R15 fixture 2 (unobserved JSON-LD claims) maps to F18 structured-data checks", () => {
  const url = "https://example.com";
  const html =
    '<main>A simple page</main><script type="application/ld+json">{"@type":"Product","name":"Unobserved product","price":"100"}</script>';
  const r15 = inspectPage({ url, html });
  assert.equal(r15.structured_data[0]?.parse_state, "valid_json");
  assert.ok(r15.issues.some((i: any) => i.code === "structured_data_requires_review"));
  const { page } = buildF18Page({ url, html });
  const types = f18Types(page);
  // Claim "Unobserved product" is not in visible text → not-visible
  assert.ok(types.includes("structured-data-not-visible"), `expected structured-data-not-visible in ${types.join(",")}`);
  // R15 positive (short source) is also an F18 thin-content positive
  assert.ok(r15.issues.some((i: any) => i.code === "insufficient_source_text"));
  assert.ok(types.includes("thin-content"));
});

test("R15 status codes map to F18 fetch outcomes", () => {
  for (const status of [403, 404, 500]) {
    const url = "https://example.com/gone";
    const html = "<main>gone</main>";
    const r15 = inspectPage({ url, html, status });
    const { page } = buildF18Page({ url, html, status });
    const types = f18Types(page);
    if (status === 403) {
      assert.ok(r15.issues.some((i: any) => i.code === "access_denied"));
      for (const t of expectedF18ForR15("access_denied")) {
        assert.ok(types.includes(t), `403 expected ${t} in ${types.join(",")}`);
      }
    } else {
      assert.ok(r15.issues.some((i: any) => i.code === "http_status"));
      for (const t of expectedF18ForR15("http_status", { status })) {
        assert.ok(types.includes(t), `${status} expected ${t} in ${types.join(",")}`);
      }
    }
  }
});

test("R15 structured-data invalid JSON maps to F18 invalid", () => {
  const url = "https://example.com/bad";
  const html = '<main>Bad json</main><script type="application/ld+json">{ not json }</script>';
  const r15 = inspectPage({ url, html });
  assert.ok(r15.issues.some((i: any) => i.code === "structured_data_requires_review"));
  const { page } = buildF18Page({ url, html });
  const types = f18Types(page);
  assert.ok(types.includes("structured-data-invalid"));
});

test("F18 honours googlebot/bingbot metas and the none directive like R15", () => {
  for (const html of [
    '<meta name="googlebot" content="noindex"><main>x</main>',
    '<meta name="bingbot" content="noindex"><main>x</main>',
    '<meta name="robots" content="none"><main>x</main>',
  ]) {
    const url = "https://example.com/p";
    const r15 = inspectPage({ url, html });
    assert.ok(r15.issues.some((i: any) => i.code === "restrictive_directive"), html);
    const { page } = buildF18Page({ url, html });
    assert.ok(f18Types(page).includes("noindex-page"), html);
  }
  // max-image-preview:none is not a noindex.
  assert.equal(isIndexableFromDirectives("max-image-preview:none", null), true);
  assert.equal(isIndexableFromDirectives("index, follow", "googlebot: none"), false);
  assert.equal(isIndexableFromDirectives(null, null), true);
});
