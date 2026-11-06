// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/issues/multipage-checks.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  findDuplicates,
  findRedirectChainsAndLoops,
  findHreflangReturnLinks,
  type SlimPage,
} from "./multipageChecks.ts";

function createPage(partial: Partial<SlimPage> & { id: string; url: string }): SlimPage {
  return {
    statusCode: 200,
    fetchClass: "ok",
    title: "Page Title",
    metaDescription: "Meta description",
    contentHash: "hash123",
    redirectUrl: null,
    wordCount: 150,
    isIndexable: true,
    canonicalUrl: partial.url,
    headerCanonicalUrl: null,
    javascriptShell: false,
    ...partial,
  };
}

describe("multipageChecks", () => {
  describe("findDuplicates", () => {
    it("detects duplicate titles, meta descriptions, and content hashes", () => {
      const p1 = createPage({ id: "p1", url: "https://example.com/p1" });
      const p2 = createPage({ id: "p2", url: "https://example.com/p2" });
      const p3 = createPage({
        id: "p3",
        url: "https://example.com/p3",
        title: "Unique Title",
        metaDescription: "Unique desc",
        contentHash: "hash456",
      });

      const issues = findDuplicates([p1, p2, p3]);

      const titleIssues = issues.filter((i) => i.issueType === "duplicate-title");
      const descIssues = issues.filter((i) => i.issueType === "duplicate-meta-description");
      const contentIssues = issues.filter((i) => i.issueType === "duplicate-content");

      assert.equal(titleIssues.length, 2);
      assert.equal(descIssues.length, 2);
      assert.equal(contentIssues.length, 2);

      const affectedIds = new Set(issues.map((i) => i.pageId));
      assert.ok(affectedIds.has("p1"));
      assert.ok(affectedIds.has("p2"));
      assert.ok(!affectedIds.has("p3"));
    });

    it("excludes app shells (javascriptShell = true) from duplicate candidates", () => {
      const p1 = createPage({ id: "p1", url: "https://example.com/p1", javascriptShell: true });
      const p2 = createPage({ id: "p2", url: "https://example.com/p2", javascriptShell: true });
      const p3 = createPage({ id: "p3", url: "https://example.com/p3", javascriptShell: false });

      // p1 and p2 have same title/desc/hash as p3, but p1 and p2 are shells, so only p3 remains (no duplicate group >= 2)
      const issues = findDuplicates([p1, p2, p3]);
      assert.equal(issues.length, 0);
    });

    it("excludes non-indexable pages from duplicate candidates", () => {
      const p1 = createPage({ id: "p1", url: "https://example.com/p1", isIndexable: false });
      const p2 = createPage({ id: "p2", url: "https://example.com/p2", isIndexable: true });

      const issues = findDuplicates([p1, p2]);
      assert.equal(issues.length, 0);
    });

    it("excludes canonicalized pages (canonicalUrl points elsewhere)", () => {
      const p1 = createPage({
        id: "p1",
        url: "https://example.com/p1",
        canonicalUrl: "https://example.com/canonical-master",
      });
      const p2 = createPage({
        id: "p2",
        url: "https://example.com/p2",
        canonicalUrl: "https://example.com/p2",
      });

      const issues = findDuplicates([p1, p2]);
      assert.equal(issues.length, 0);
    });

    it("does not report content duplicates when wordCount <= 0", () => {
      const p1 = createPage({ id: "p1", url: "https://example.com/p1", title: "T1", metaDescription: "D1", wordCount: 0 });
      const p2 = createPage({ id: "p2", url: "https://example.com/p2", title: "T2", metaDescription: "D2", wordCount: 0 });

      const issues = findDuplicates([p1, p2]);
      assert.equal(issues.length, 0);
    });
  });

  describe("findRedirectChainsAndLoops", () => {
    it("does not report 1-hop redirects", () => {
      const p1 = createPage({
        id: "p1",
        url: "https://example.com/a",
        statusCode: 301,
        redirectUrl: "https://example.com/b",
      });
      const issues = findRedirectChainsAndLoops([p1]);
      assert.equal(issues.length, 0);
    });

    it("detects redirect chains with hops > 2", () => {
      const p1 = createPage({
        id: "p1",
        url: "https://example.com/a",
        statusCode: 301,
        redirectUrl: "https://example.com/b",
      });
      const p2 = createPage({
        id: "p2",
        url: "https://example.com/b",
        statusCode: 302,
        redirectUrl: "https://example.com/c",
      });

      const issues = findRedirectChainsAndLoops([p1, p2]);
      assert.equal(issues.length, 1);
      assert.equal(issues[0].issueType, "redirect-chain");
      assert.equal(issues[0].pageUrl, "https://example.com/a");
      assert.deepEqual(issues[0].details, {
        hops: ["https://example.com/a", "https://example.com/b", "https://example.com/c"],
        finalUrl: "https://example.com/c",
      });
    });

    it("detects redirect loops", () => {
      const p1 = createPage({
        id: "p1",
        url: "https://example.com/a",
        statusCode: 301,
        redirectUrl: "https://example.com/b",
      });
      const p2 = createPage({
        id: "p2",
        url: "https://example.com/b",
        statusCode: 301,
        redirectUrl: "https://example.com/a",
      });

      const issues = findRedirectChainsAndLoops([p1, p2]);
      assert.ok(issues.length >= 1);
      assert.equal(issues[0].issueType, "redirect-loop");
      assert.ok((issues[0].details?.hops as string[])?.includes("https://example.com/a"));
    });

    it("detects self-redirect loop", () => {
      const p1 = createPage({
        id: "p1",
        url: "https://example.com/a",
        statusCode: 301,
        redirectUrl: "https://example.com/a",
      });

      const issues = findRedirectChainsAndLoops([p1]);
      assert.equal(issues.length, 1);
      assert.equal(issues[0].issueType, "redirect-loop");
    });
  });

  describe("findHreflangReturnLinks", () => {
    it("reports hreflang-no-return-link when alternate page lacks return link", () => {
      const pages = [
        {
          id: "p-en",
          url: "https://example.com/en",
          statusCode: 200,
          fetchClass: "ok" as const,
          hreflang: [
            { lang: "fr", href: "https://example.com/fr" },
            { lang: "en", href: "https://example.com/en" },
          ],
        },
        {
          id: "p-fr",
          url: "https://example.com/fr",
          statusCode: 200,
          fetchClass: "ok" as const,
          hreflang: [{ lang: "fr", href: "https://example.com/fr" }],
        },
      ];

      const issues = findHreflangReturnLinks(pages);
      assert.equal(issues.length, 1);
      assert.equal(issues[0].issueType, "hreflang-no-return-link");
      assert.equal(issues[0].pageId, "p-en");
      assert.equal(issues[0].pageUrl, "https://example.com/en");
      assert.equal(issues[0].dedupeKey, "https://example.com/fr");
      assert.deepEqual(issues[0].details, {
        alternate: "https://example.com/fr",
        lang: "fr",
      });
    });
  });
});
