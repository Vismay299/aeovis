import type { Fixture } from "../types.ts";
import { htmlResponse, renderDocument, lorem } from "./helpers.ts";

export const headTagsFixtures: Fixture[] = [
  {
    path: "/head/missing-title",
    name: "Missing <title> tag",
    category: "head",
    expectedIssues: ["missing-title"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: undefined,
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          bodyHtml: `<h1>Page with Missing Title</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/head/title-short",
    name: "Title too short",
    category: "head",
    expectedIssues: ["title-too-short"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Short",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          bodyHtml: `<h1>Page with Short Title</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/head/title-long",
    name: "Title too long",
    category: "head",
    expectedIssues: ["title-too-long"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "This page title is far too long and search engines will truncate it in results because it exceeds seventy characters",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          bodyHtml: `<h1>Page with Long Title</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/head/missing-meta",
    name: "Missing meta description",
    category: "head",
    expectedIssues: ["missing-meta-description"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Valid Title for Missing Meta",
          metaDescription: undefined,
          bodyHtml: `<h1>Page with Missing Meta Description</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/head/meta-short",
    name: "Meta description too short",
    category: "head",
    expectedIssues: ["meta-description-too-short"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Valid Title for Short Meta",
          metaDescription: "Too short desc",
          bodyHtml: `<h1>Page with Short Meta</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/head/meta-long",
    name: "Meta description too long",
    category: "head",
    expectedIssues: ["meta-description-too-long"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Valid Title for Long Meta",
          metaDescription: "This meta description is intentionally engineered to be extremely long and verbose, comfortably exceeding the one hundred and sixty character threshold so that crawlers flag it as excessively long.",
          bodyHtml: `<h1>Page with Long Meta</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/head/canonical-conflict",
    name: "Canonical conflict",
    category: "head",
    expectedIssues: ["canonical-conflict", "canonicalized-page"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Canonical Conflict Page",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          canonicalUrl: "https://main.audit.test/head/canonical-html",
          bodyHtml: `<h1>Page with Conflict Canonical</h1><p>${lorem(180)}</p>`,
        }),
        200,
        {
          Link: '<https://main.audit.test/head/canonical-header>; rel="canonical"',
        },
      ),
  },
  {
    path: "/head/canonicalized",
    name: "Canonicalized page",
    category: "head",
    expectedIssues: ["canonicalized-page"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Canonicalized Page",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          canonicalUrl: "https://main.audit.test/head/master-canonical",
          bodyHtml: `<h1>Canonicalized Page</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
];
