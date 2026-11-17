import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  discoverSiteUrls,
  readPagesFree,
  readPageFirecrawl,
  readSiteWithWwwRetry,
  htmlToText,
  extractTitle,
  parseSitemapUrls,
  PER_PAGE_CHAR_LIMIT,
} from "./readSite.ts";

const FIXTURES_DIR = path.resolve(process.cwd(), "tests/fixtures/f08/site");

describe("readSite (P3.T2.S1)", () => {
  it("parses sitemap urls resolving against origin and skipping xml indexes", async () => {
    const xml = await fs.readFile(path.join(FIXTURES_DIR, "sitemap.xml"), "utf-8");
    const urls = parseSitemapUrls(xml, "https://offcult.in");
    assert.deepEqual(urls, [
      "https://offcult.in/",
      "https://offcult.in/about.html",
      "https://offcult.in/pricing.html",
    ]);
  });

  it("discovers site urls using sitemap and limits result", async () => {
    const sitemapXml = await fs.readFile(path.join(FIXTURES_DIR, "sitemap.xml"), "utf-8");
    const safeFetchMock: any = async (url: string) => {
      if (url === "https://offcult.in/sitemap.xml") {
        return {
          status: 200,
          ok: true,
          text: async () => sitemapXml,
        };
      }
      return { status: 404, ok: false };
    };

    const urls = await discoverSiteUrls("https://offcult.in", 3, { safeFetch: safeFetchMock });
    assert.equal(urls.length, 3);
    assert.equal(urls[0], "https://offcult.in/");
    assert.equal(urls[1], "https://offcult.in/about.html");
    assert.equal(urls[2], "https://offcult.in/pricing.html");
  });

  it("reads pages free, capping text at 4,000 characters and extracting title", async () => {
    const homeHtml = `<html><head><title>Test title</title></head><body>${"x".repeat(5000)}</body></html>`;
    let seenOptions: any;
    const safeFetchMock: any = async (_url: string, options: any) => {
      seenOptions = options;
      return {
        status: 200,
        ok: true,
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        text: () => homeHtml,
      };
    };

    const { pages, failed } = await readPagesFree(["https://offcult.in/home.html"], 1, {
      safeFetch: safeFetchMock,
    });

    assert.equal(failed.length, 0);
    assert.equal(pages.length, 1);
    assert.equal(pages[0].title, "Test title");
    assert.equal(pages[0].content.length, PER_PAGE_CHAR_LIMIT);
    assert.equal(seenOptions.timeoutMs, 10000);
    assert.equal(seenOptions.maxBytes, 2000000);
  });

  it("skips non-HTML responses and records as failed", async () => {
    const safeFetchMock: any = async () => {
      return {
        status: 200,
        ok: true,
        headers: new Headers({ "content-type": "application/pdf" }),
        text: async () => "%PDF-1.4 binary data",
      };
    };

    const { pages, failed } = await readPagesFree(["https://offcult.in/file.pdf"], 1, {
      safeFetch: safeFetchMock,
    });

    assert.equal(pages.length, 0);
    assert.equal(failed.length, 1);
    assert.equal(failed[0], "https://offcult.in/file.pdf");
  });

  it("reads through Firecrawl when metered, setting billed: true for firecrawl source", async () => {
    let meterCalled = false;
    let meterOpts: any = null;

    const meterMock: any = async (opts: any, fn: any) => {
      meterCalled = true;
      meterOpts = opts;
      const res = await fn();
      return res.value;
    };

    const scrapeMock: any = async () => {
      return {
        content: "Scraped content from Firecrawl",
        title: "Firecrawl Page",
        source: "firecrawl",
      };
    };

    const result = await readPageFirecrawl("https://blocked.example.com", meterMock, {
      scrapeSite: scrapeMock,
    });

    assert.equal(meterCalled, true);
    assert.ok(meterOpts.estimateUsd > 0);
    assert.equal(result.billed, true);
    assert.equal(result.page?.title, "Firecrawl Page");
    assert.equal(result.page?.content, "Scraped content from Firecrawl");
  });

  it("sets billed: false when fallback_fetch is returned by scrapeSite (hold released)", async () => {
    let holdReleased = false;
    const meterMock: any = async (opts: any, fn: any) => {
      const res = await fn();
      if (!res.billed) holdReleased = true;
      return res.value;
    };

    const scrapeMock: any = async () => {
      return {
        content: "Direct fetch fallback",
        title: "Fallback Title",
        source: "fallback_fetch",
      };
    };

    const result = await readPageFirecrawl("https://fallback.example.com", meterMock, {
      scrapeSite: scrapeMock,
    });

    assert.equal(result.billed, false);
    assert.equal(holdReleased, true);
    assert.equal(result.page?.content, "Direct fetch fallback");
  });

  it("retries bare domain with www. on failure", async () => {
    const homeHtml = await fs.readFile(path.join(FIXTURES_DIR, "home.html"), "utf-8");
    const blocked = JSON.parse(
      await fs.readFile(path.join(FIXTURES_DIR, "blocked-403.json"), "utf-8"),
    );
    const safeFetchMock: any = async (url: string) => {
      if (url.includes("www.offcult.in")) {
        return {
          status: 200,
          ok: true,
          headers: new Headers({ "content-type": "text/html" }),
          text: async () => homeHtml,
        };
      }
      return { status: blocked.status, ok: false };
    };

    const result = await readSiteWithWwwRetry("offcult.in", 1, {
      safeFetch: safeFetchMock,
    });

    assert.equal(result.pages.length, 1);
    assert.ok(result.pages[0].url.includes("www.offcult.in"));
  });
});
