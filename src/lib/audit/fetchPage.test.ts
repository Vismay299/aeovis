// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/workflows/site-audit-workflow-helpers.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  crawlPage,
  createCachedLookup,
  parseLinkHeaderCanonical,
} from "./fetchPage.ts";
import { createCrawlThrottle } from "./crawlThrottle.ts";
import type { SafeFetchResult } from "../http/safeFetch.ts";

function createMockResponse(options: {
  url: string;
  status: number;
  bodyText?: string;
  headers?: Record<string, string>;
  truncated?: boolean;
}): SafeFetchResult {
  const text = options.bodyText ?? "";
  const bodyBytes = new TextEncoder().encode(text);
  const headers = new Headers(options.headers);
  return {
    url: options.url,
    status: options.status,
    headers,
    body: bodyBytes,
    truncated: options.truncated ?? false,
    text: () => text,
    json: () => JSON.parse(text),
  };
}

describe("fetchPage", () => {
  const publicLookup = async (_host: string) => ["93.184.216.34"];
  const fixedNow = () => 1000;

  it("crawls and analyses 200 HTML", async () => {
    const html = `
      <!DOCTYPE html>
      <html>
        <head>
          <title>Test Page</title>
          <meta name="description" content="A test page description" />
        </head>
        <body>
          <h1>Heading 1</h1>
          <p>Some body text that gives words to the page analysis test.</p>
        </body>
      </html>
    `;

    const mockFetch = async () =>
      createMockResponse({
        url: "https://example.com/page",
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        bodyText: html,
      });

    const throttle = createCrawlThrottle(Date.now() + 10_000, undefined, undefined, {
      initialIntervalMs: 1,
    });
    const result = await crawlPage("https://example.com/page", 1, true, throttle, {
      deps: {
        safeFetch: mockFetch,
        lookup: publicLookup,
        now: fixedNow,
      },
    });

    assert.ok(result);
    assert.equal(result.statusCode, 200);
    assert.equal(result.fetchClass, "ok");
    assert.equal(result.isHtml, true);
    assert.equal(result.title, "Test Page");
    assert.equal(result.metaDescription, "A test page description");
    assert.equal(result.h1Count, 1);
    assert.equal(result.crawlDepth, 1);
    assert.equal(result.inSitemap, true);
    assert.equal(result.rateLimited, false);
  });

  it("records 301 with redirectUrl and does not follow", async () => {
    const mockFetch = async () =>
      createMockResponse({
        url: "https://example.com/old",
        status: 301,
        headers: {
          location: "https://example.com/new",
        },
      });

    const throttle = createCrawlThrottle(Date.now() + 10_000, undefined, undefined, {
      initialIntervalMs: 1,
    });
    const result = await crawlPage("https://example.com/old", 0, false, throttle, {
      deps: {
        safeFetch: mockFetch,
        lookup: publicLookup,
        now: fixedNow,
      },
    });

    assert.ok(result);
    assert.equal(result.statusCode, 301);
    assert.equal(result.fetchClass, "ok");
    assert.equal(result.redirectUrl, "https://example.com/new");
  });

  it("handles 429 then 200 with Retry-After and sets rateLimited: true", async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) {
        return createMockResponse({
          url: "https://example.com/rate-limited",
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return createMockResponse({
        url: "https://example.com/rate-limited",
        status: 200,
        headers: { "content-type": "text/html" },
        bodyText: "<html><head><title>Ok</title></head><body><h1>Loaded</h1></body></html>",
      });
    };

    const throttle = createCrawlThrottle(Date.now() + 100_000, undefined, undefined, {
      initialIntervalMs: 1,
    });
    const result = await crawlPage(
      "https://example.com/rate-limited",
      0,
      false,
      throttle,
      {
        deps: {
          safeFetch: mockFetch,
          lookup: publicLookup,
          now: fixedNow,
        },
      },
    );

    assert.ok(result);
    assert.equal(callCount, 2);
    assert.equal(result.statusCode, 200);
    assert.equal(result.rateLimited, true);
  });

  it("classifies 403 as blocked", async () => {
    const mockFetch = async () =>
      createMockResponse({
        url: "https://example.com/forbidden",
        status: 403,
        headers: { "content-type": "text/html" },
        bodyText: "<html><body>Access Denied</body></html>",
      });

    const throttle = createCrawlThrottle(Date.now() + 10_000, undefined, undefined, {
      initialIntervalMs: 1,
    });
    const result = await crawlPage("https://example.com/forbidden", 0, false, throttle, {
      deps: {
        safeFetch: mockFetch,
        lookup: publicLookup,
        now: fixedNow,
      },
    });

    assert.ok(result);
    assert.equal(result.statusCode, 403);
    assert.equal(result.fetchClass, "blocked");
  });

  it("classifies 200 Cloudflare challenge title as blocked", async () => {
    const challengeHtml = "<html><head><title>Just a moment...</title></head><body>Checking your browser</body></html>";
    const mockFetch = async () =>
      createMockResponse({
        url: "https://example.com/challenge",
        status: 200,
        headers: { "content-type": "text/html" },
        bodyText: challengeHtml,
      });

    const throttle = createCrawlThrottle(Date.now() + 10_000, undefined, undefined, {
      initialIntervalMs: 1,
    });
    const result = await crawlPage("https://example.com/challenge", 0, false, throttle, {
      deps: {
        safeFetch: mockFetch,
        lookup: publicLookup,
        now: fixedNow,
      },
    });

    assert.ok(result);
    assert.equal(result.fetchClass, "blocked");
  });

  it("refuses private-address link with error and blockedReason url_blocked without calling fetch", async () => {
    let fetchCalled = false;
    const mockFetch = async () => {
      fetchCalled = true;
      throw new Error("Should not be called!");
    };

    const privateLookup = async (_host: string) => ["127.0.0.1"];
    const throttle = createCrawlThrottle(Date.now() + 10_000);

    const result = await crawlPage("http://127.0.0.1/private", 0, false, throttle, {
      deps: {
        safeFetch: mockFetch,
        lookup: privateLookup,
        now: fixedNow,
      },
    });

    assert.ok(result);
    assert.equal(fetchCalled, false);
    assert.equal(result.fetchClass, "error");
    assert.equal(result.statusCode, 0);
    assert.equal(result.blockedReason, "url_blocked");
  });

  it("handles 2 MB page truncated to 1 MiB", async () => {
    // Large 2MB string truncated
    const htmlPart = "<html><head><title>Big</title></head><body><h1>Large Page</h1>";
    const padding = "a".repeat(1024 * 1024);
    const bodyText = (htmlPart + padding).slice(0, 1024 * 1024);

    const mockFetch = async () =>
      createMockResponse({
        url: "https://example.com/big",
        status: 200,
        headers: { "content-type": "text/html" },
        bodyText,
        truncated: true,
      });

    const throttle = createCrawlThrottle(Date.now() + 10_000, undefined, undefined, {
      initialIntervalMs: 1,
    });
    const result = await crawlPage("https://example.com/big", 0, false, throttle, {
      deps: {
        safeFetch: mockFetch,
        lookup: publicLookup,
        now: fixedNow,
      },
    });

    assert.ok(result);
    assert.equal(result.fetchClass, "ok");
    assert.equal(result.title, "Big");
  });

  it("marks non-HTML response (PDF) as isHtml: false", async () => {
    const mockFetch = async () =>
      createMockResponse({
        url: "https://example.com/doc.pdf",
        status: 200,
        headers: { "content-type": "application/pdf" },
        bodyText: "%PDF-1.4...",
      });

    const throttle = createCrawlThrottle(Date.now() + 10_000, undefined, undefined, {
      initialIntervalMs: 1,
    });
    const result = await crawlPage("https://example.com/doc.pdf", 0, false, throttle, {
      deps: {
        safeFetch: mockFetch,
        lookup: publicLookup,
        now: fixedNow,
      },
    });

    assert.ok(result);
    assert.equal(result.isHtml, false);
    assert.equal(result.fetchClass, "ok");
  });

  it("lookup cache resolves host once for multiple fetches", async () => {
    let dnsResolutions = 0;
    const underlyingLookup = async (_h: string) => {
      dnsResolutions++;
      return ["93.184.216.34"];
    };

    const cachedLookup = createCachedLookup(underlyingLookup, 60_000);

    const ips1 = await cachedLookup("example.com");
    const ips2 = await cachedLookup("EXAMPLE.COM");
    const ips3 = await cachedLookup("example.com");

    assert.equal(dnsResolutions, 1);
    assert.deepEqual(ips1, ["93.184.216.34"]);
    assert.deepEqual(ips2, ["93.184.216.34"]);
    assert.deepEqual(ips3, ["93.184.216.34"]);
  });

  it("parses Link header canonical", () => {
    const header = '<https://example.com/canonical>; rel="canonical"';
    const canonical = parseLinkHeaderCanonical(header, "https://example.com/page");
    assert.equal(canonical, "https://example.com/canonical");
  });
});
