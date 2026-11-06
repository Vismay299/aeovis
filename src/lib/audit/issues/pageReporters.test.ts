import test from "node:test";
import assert from "node:assert/strict";
import { runPageReporters } from "./pageReporters.ts";
import { parseAuditRobots } from "../robotsFile.ts";
import type { CrawledPageResult, PageLink } from "../types.ts";

const HEALTHY_LINK: PageLink = {
  targetUrl: "https://example.com/catalog",
  anchor: "Catalog",
  isInternal: true,
  isNofollow: false,
};

function makePage(overrides: Partial<CrawledPageResult> = {}): CrawledPageResult {
  return {
    id: "page-1",
    url: "https://example.com/a",
    statusCode: 200,
    fetchClass: "ok",
    redirectUrl: null,
    title: "A perfectly reasonable page title",
    metaDescription:
      "A reasonable meta description that says something useful about the page.",
    canonicalUrl: null,
    robotsMeta: null,
    xRobotsTag: null,
    headerCanonicalUrl: null,
    ogTitle: "Valid OG Title",
    ogDescription: "Valid OG Description",
    ogImage: "https://example.com/og.png",
    h1Count: 1,
    h2Count: 0,
    h3Count: 0,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    headingOrder: [1, 2, 3],
    wordCount: 500,
    contentHash: "abc123",
    isHtml: true,
    htmlBytes: 10_000,
    rateLimited: false,
    imagesTotal: 0,
    imagesMissingAlt: 0,
    images: [],
    links: [HEALTHY_LINK],
    hasStructuredData: true,
    hreflangTags: [],
    hreflang: [],
    structuredData: {
      blocks: [{ parseState: "valid", types: ["Article"] }],
      missingType: 0,
      missingRequired: [],
      claimsNotVisible: [],
    },
    structuredDataTypes: ["Article"],
    dataNosnippet: false,
    rendered: false,
    isIndexable: true,
    responseTimeMs: 200,
    crawlDepth: 1,
    inSitemap: true,
    ...overrides,
  };
}

function issueTypes(
  page: CrawledPageResult,
  ctx?: { robots: ReturnType<typeof parseAuditRobots> | null; robotsUsable: boolean },
): string[] {
  return runPageReporters(page, ctx).map((issue) => issue.issueType);
}

test("runPageReporters reports nothing for a healthy page", () => {
  assert.deepEqual(issueTypes(makePage()), []);
});

test("runPageReporters handles fetch-level short circuits", () => {
  assert.deepEqual(
    issueTypes(makePage({ fetchClass: "blocked", statusCode: 403 })),
    ["blocked-page"],
  );
  assert.deepEqual(
    issueTypes(makePage({ fetchClass: "rate_limited", statusCode: 429 })),
    ["rate-limited-page"],
  );
  assert.deepEqual(
    issueTypes(makePage({ fetchClass: "error", statusCode: 0 })),
    [],
  );
});

test("runPageReporters classifies HTTP error statuses", () => {
  assert.deepEqual(issueTypes(makePage({ statusCode: 500 })), ["server-error"]);
  assert.deepEqual(issueTypes(makePage({ statusCode: 404 })), ["broken-page"]);
  assert.deepEqual(
    issueTypes(makePage({ statusCode: 301, redirectUrl: "https://example.com/b" })),
    [],
  );
});

test("runPageReporters flags OpenSEO on-page issues", () => {
  assert.ok(issueTypes(makePage({ title: "" })).includes("missing-title"));
  assert.ok(issueTypes(makePage({ title: "x".repeat(70) })).includes("title-too-long"));
  assert.ok(issueTypes(makePage({ title: "Tiny" })).includes("title-too-short"));
  assert.ok(issueTypes(makePage({ metaDescription: "" })).includes("missing-meta-description"));
  assert.ok(issueTypes(makePage({ metaDescription: "x".repeat(200) })).includes("meta-description-too-long"));
  assert.ok(issueTypes(makePage({ metaDescription: "x".repeat(69) })).includes("meta-description-too-short"));
  assert.ok(issueTypes(makePage({ h1Count: 0 })).includes("missing-h1"));
  assert.ok(issueTypes(makePage({ h1Count: 3 })).includes("multiple-h1"));
  assert.ok(issueTypes(makePage({ headingOrder: [1, 2, 4] })).includes("heading-order-skip"));
  assert.ok(issueTypes(makePage({ wordCount: 50 })).includes("thin-content"));
  assert.ok(issueTypes(makePage({ responseTimeMs: 3000 })).includes("slow-response"));
  assert.ok(issueTypes(makePage({ crawlDepth: 6 })).includes("deep-page"));
  assert.ok(issueTypes(makePage({ links: [] })).includes("no-outgoing-links"));
  assert.ok(
    issueTypes(makePage({ imagesTotal: 2, imagesMissingAlt: 1 })).includes("images-missing-alt"),
  );
});

test("runPageReporters respects indexability and canonical flags", () => {
  assert.ok(
    issueTypes(makePage({ isIndexable: false, robotsMeta: "noindex" })).includes("noindex-page"),
  );

  const conflicted = issueTypes(
    makePage({
      canonicalUrl: "https://example.com/canonical-a",
      headerCanonicalUrl: "https://example.com/canonical-b",
    }),
  );
  assert.ok(conflicted.includes("canonical-conflict"));
  assert.ok(conflicted.includes("canonicalized-page"));

  // Canonical matching url itself is not canonicalized
  assert.ok(!issueTypes(makePage({ canonicalUrl: "https://example.com/a" })).includes("canonicalized-page"));
});

test("runPageReporters skips content checks for non-html pages", () => {
  const pdfPage = makePage({
    isHtml: false,
    title: "",
    metaDescription: "",
    h1Count: 0,
    wordCount: 0,
  });
  assert.deepEqual(issueTypes(pdfPage), []);
});

test("runPageReporters flags app shell and skips content checks", () => {
  const shell = makePage({
    javascriptShell: true,
    title: "",
    metaDescription: "",
    h1Count: 0,
    wordCount: 1,
    links: [],
    isIndexable: false,
    robotsMeta: "noindex",
    canonicalUrl: "https://example.com/canonical",
    headerCanonicalUrl: "https://example.com/header-canonical",
    responseTimeMs: 2000,
    crawlDepth: 5,
  });

  const types = issueTypes(shell);
  assert.deepEqual(types, [
    "slow-response",
    "noindex-page",
    "canonical-conflict",
    "canonicalized-page",
    "deep-page",
    "javascript-rendering-suspected",
  ]);
});

test("runPageReporters flags Perceev AI search and agent crawler blocks", () => {
  const robots = parseAuditRobots(`
User-agent: OAI-SearchBot
Disallow: /a

User-agent: Claude-User
Disallow: /a
  `);

  const types = issueTypes(makePage(), { robots, robotsUsable: true });
  assert.ok(types.includes("ai-search-crawler-blocked"));
  assert.ok(types.includes("ai-agent-crawler-blocked"));
});

test("runPageReporters produces no bot issues when robots is unusable", () => {
  const robots = parseAuditRobots(`User-agent: *\nDisallow: /`);
  const types = issueTypes(makePage(), { robots, robotsUsable: false });
  assert.ok(!types.includes("ai-search-crawler-blocked"));
  assert.ok(!types.includes("ai-agent-crawler-blocked"));
});

test("runPageReporters checks AI bot access on app shells", () => {
  const robots = parseAuditRobots(`User-agent: OAI-SearchBot\nDisallow: /a`);
  const shell = makePage({ javascriptShell: true });
  const types = issueTypes(shell, { robots, robotsUsable: true });
  assert.ok(types.includes("ai-search-crawler-blocked"));
  assert.ok(types.includes("javascript-rendering-suspected"));
});

test("runPageReporters checks structured data issues", () => {
  const invalidJsonPage = makePage({
    structuredData: {
      blocks: [{ parseState: "invalid", types: [] }],
      missingType: 0,
      missingRequired: [],
      claimsNotVisible: [],
    },
  });
  assert.ok(issueTypes(invalidJsonPage).includes("structured-data-invalid"));

  const missingTypePage = makePage({
    structuredData: {
      blocks: [{ parseState: "valid", types: [] }],
      missingType: 1,
      missingRequired: [],
      claimsNotVisible: [],
    },
  });
  assert.ok(issueTypes(missingTypePage).includes("structured-data-missing-type"));

  const missingReqPage = makePage({
    structuredData: {
      blocks: [{ parseState: "valid", types: ["Product"] }],
      missingType: 0,
      missingRequired: [{ type: "Product", missing: ["offers"] }],
      claimsNotVisible: [],
    },
  });
  assert.ok(issueTypes(missingReqPage).includes("structured-data-missing-required"));

  const notVisiblePage = makePage({
    structuredData: {
      blocks: [{ parseState: "valid", types: ["Product"] }],
      missingType: 0,
      missingRequired: [],
      claimsNotVisible: [{ path: "$.name", value: "Invisible" }],
    },
  });
  assert.ok(issueTypes(notVisiblePage).includes("structured-data-not-visible"));

  const noSdPage = makePage({
    isIndexable: true,
    wordCount: 200,
    structuredData: {
      blocks: [],
      missingType: 0,
      missingRequired: [],
      claimsNotVisible: [],
    },
  });
  assert.ok(issueTypes(noSdPage).includes("no-structured-data"));
});

test("runPageReporters checks Open Graph missing tags", () => {
  const missingOgPage = makePage({
    ogTitle: null,
    ogDescription: "Desc",
    ogImage: null,
  });
  const issues = runPageReporters(missingOgPage);
  const ogIssue = issues.find((i) => i.issueType === "missing-og-tags");
  assert.ok(ogIssue);
  assert.deepEqual(ogIssue.details?.missing, ["og:title", "og:image"]);
});

test("runPageReporters checks hreflang invalid and missing self", () => {
  const invalidHlPage = makePage({
    hreflang: [
      { lang: "english", href: "https://example.com/en" },
      { lang: "es", href: "/relative" },
    ],
  });
  const types = issueTypes(invalidHlPage);
  assert.ok(types.includes("hreflang-invalid"));
  assert.ok(types.includes("hreflang-missing-self"));
});

test("runPageReporters checks snippet restrictions across meta, header, and data-nosnippet", () => {
  assert.ok(
    issueTypes(makePage({ robotsMeta: "nosnippet" })).includes("snippet-restricted"),
  );
  assert.ok(
    issueTypes(makePage({ xRobotsTag: "max-snippet: 0" })).includes("snippet-restricted"),
  );
  assert.ok(
    issueTypes(makePage({ dataNosnippet: true })).includes("snippet-restricted"),
  );
});
