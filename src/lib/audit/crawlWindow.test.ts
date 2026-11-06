// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/crawl-window.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { adjustCrawlWindow, clampCrawlWindow, CRAWL_WINDOW } from "./crawlWindow.ts";
import type { CrawledPageResult } from "./types.ts";
import type { PageFetchClass } from "../../shared/audit-fetch-class.ts";

function page(
  fetchClass: PageFetchClass,
  responseTimeMs: number,
  htmlBytes = 10_000,
): CrawledPageResult {
  return {
    id: "",
    url: "https://example.com/",
    statusCode: fetchClass === "ok" ? 200 : 0,
    fetchClass,
    redirectUrl: null,
    title: "",
    metaDescription: "",
    canonicalUrl: null,
    robotsMeta: null,
    xRobotsTag: null,
    headerCanonicalUrl: null,
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
    isHtml: true,
    htmlBytes,
    rateLimited: false,
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
    isIndexable: true,
    responseTimeMs,
    crawlDepth: 0,
    inSitemap: false,
  };
}

describe("adjustCrawlWindow", () => {
  it("keeps the window on an empty batch", () => {
    assert.equal(adjustCrawlWindow(2, []), 2);
  });

  it("reduces concurrency on a failed fetch", () => {
    const troubled = page("error", 300);
    const recent = Array.from({ length: 10 }, () => troubled);
    assert.equal(adjustCrawlWindow(2, recent), 1);
  });

  it("reduces concurrency on a recovered 429", () => {
    const troubled = { ...page("ok", 300), rateLimited: true };
    const recent = Array.from({ length: 10 }, () => troubled);
    assert.equal(adjustCrawlWindow(2, recent), 1);
  });

  it("never shrinks below one request", () => {
    assert.equal(adjustCrawlWindow(1, [page("error", 15_000)]), 1);
  });

  it("never grows beyond max concurrent requests, even on a fast site", () => {
    const recent = Array.from({ length: 25 }, () => page("ok", 400));
    assert.equal(adjustCrawlWindow(2, recent), 2);
    assert.equal(adjustCrawlWindow(1, recent), 2);
  });

  it("preserves the byte budget if page sizes increase", () => {
    const recent = Array.from({ length: 25 }, () =>
      page("ok", 300, 5 * 1024 * 1024),
    );
    assert.equal(adjustCrawlWindow(2, recent), 1);
  });

  it("clamps crawl window within bounds", () => {
    assert.equal(clampCrawlWindow(0, CRAWL_WINDOW), 1);
    assert.equal(clampCrawlWindow(5, CRAWL_WINDOW), 2);
    assert.equal(clampCrawlWindow(2, CRAWL_WINDOW), 2);
  });
});
