// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/discovery.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discoverUrls, parseRobotsTxt } from "./discovery.ts";
import type { SafeFetchResult } from "../http/safeFetch.ts";

function mockResponse(url: string, status: number, body: string, truncated = false): SafeFetchResult {
  const enc = new TextEncoder().encode(body);
  return {
    url,
    status,
    headers: new Headers({ "content-type": "application/xml" }),
    body: enc,
    truncated,
    text: () => body,
    json: () => JSON.parse(body),
  };
}

function sitemapXml(urls: string[]): string {
  const entries = urls.map((url) => `<url><loc>${url}</loc></url>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset>${entries}</urlset>`;
}

function sitemapIndexXml(nestedSitemaps: string[]): string {
  const entries = nestedSitemaps.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><sitemapindex>${entries}</sitemapindex>`;
}

describe("parseRobotsTxt", () => {
  it("extracts sitemaps and checks permissions", () => {
    const raw = `
User-agent: *
Disallow: /admin/
Allow: /admin/public/
Sitemap: https://example.com/sitemap.xml
Sitemap: /sitemap-sub.xml
`;
    const res = parseRobotsTxt("https://example.com", raw);
    assert.deepEqual(res.sitemapUrls, [
      "https://example.com/sitemap.xml",
      "https://example.com/sitemap-sub.xml",
    ]);
    assert.equal(res.isAllowed("https://example.com/"), true);
    assert.equal(res.isAllowed("https://example.com/admin/secret"), false);
    assert.equal(res.isAllowed("https://example.com/admin/public/page"), true);
  });

  it("handles empty or null robots.txt", () => {
    const res = parseRobotsTxt("https://example.com", null);
    assert.deepEqual(res.sitemapUrls, []);
    assert.equal(res.isAllowed("https://example.com/anything"), true);
  });
});

describe("discoverUrls", () => {
  it("discovers URLs from robots.txt and sitemaps via injected safeFetch", async () => {
    const mockSafeFetch = async (targetUrl: string | URL): Promise<SafeFetchResult> => {
      const u = targetUrl.toString();
      if (u === "https://example.com/robots.txt") {
        return mockResponse(
          u,
          200,
          "User-agent: *\nAllow: /\nSitemap: https://example.com/sitemap-index.xml",
        );
      }
      if (u === "https://example.com/sitemap-index.xml") {
        return mockResponse(
          u,
          200,
          sitemapIndexXml(["https://example.com/sitemap-1.xml"]),
        );
      }
      if (u === "https://example.com/sitemap-1.xml") {
        return mockResponse(
          u,
          200,
          sitemapXml([
            "https://example.com/page-1",
            "https://example.com/page-2",
          ]),
        );
      }
      if (u === "https://example.com/sitemap.xml") {
        return mockResponse(
          u,
          200,
          sitemapXml(["https://example.com/home"]),
        );
      }
      return mockResponse(u, 404, "");
    };

    const result = await discoverUrls("https://example.com", 10, null, {
      safeFetch: mockSafeFetch,
    });

    assert.ok(result.robotsText?.includes("Sitemap:"));
    assert.ok(result.urls.includes("https://example.com/page-1"));
    assert.ok(result.urls.includes("https://example.com/page-2"));
    assert.ok(result.urls.includes("https://example.com/home"));
  });

  it("skips oversized shards (truncated = true)", async () => {
    const mockSafeFetch = async (targetUrl: string | URL): Promise<SafeFetchResult> => {
      const u = targetUrl.toString();
      if (u === "https://example.com/robots.txt") {
        return mockResponse(u, 404, "");
      }
      if (u === "https://example.com/sitemap.xml") {
        // Shard marked as truncated (>10MB)
        return mockResponse(
          u,
          200,
          sitemapXml(["https://example.com/oversized-page"]),
          true,
        );
      }
      return mockResponse(u, 404, "");
    };

    const result = await discoverUrls("https://example.com", 10, null, {
      safeFetch: mockSafeFetch,
    });

    // Since the shard was truncated/skipped, oversized-page should not be discovered
    assert.equal(result.urls.includes("https://example.com/oversized-page"), false);
  });
});
