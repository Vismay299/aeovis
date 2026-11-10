import type { Fixture } from "../types.ts";
import { htmlResponse, renderDocument, lorem } from "./helpers.ts";

export const contentFixtures: Fixture[] = [
  {
    path: "/content/missing-h1",
    name: "Missing H1 heading",
    category: "content",
    expectedIssues: ["missing-h1"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page Without H1 Heading",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          bodyHtml: `<h2>Subtitle Only</h2><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/content/multiple-h1",
    name: "Multiple H1 headings",
    category: "content",
    expectedIssues: ["multiple-h1"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page With Multiple H1 Headings",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          bodyHtml: `<h1>First Main Heading</h1><h1>Second Main Heading</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/content/thin-content",
    name: "Thin content",
    category: "content",
    expectedIssues: ["thin-content"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page With Very Thin Content",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          bodyHtml: `<h1>Thin Page</h1><p>Just a few brief words here.</p>`,
        }),
      ),
  },
  {
    path: "/content/dup-title-1",
    name: "Duplicate title 1",
    category: "content",
    expectedIssues: ["duplicate-title"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Identical Shared Title Across Pages",
          metaDescription: "This is a valid meta description specifically written for the first duplicate title page.",
          bodyHtml: `<h1>First Duplicate Title Page</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/content/dup-title-2",
    name: "Duplicate title 2",
    category: "content",
    expectedIssues: ["duplicate-title"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Identical Shared Title Across Pages",
          metaDescription: "This is a valid meta description specifically written for the second duplicate title page.",
          bodyHtml: `<h1>Second Duplicate Title Page</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/content/dup-desc-1",
    name: "Duplicate meta description 1",
    category: "content",
    expectedIssues: ["duplicate-meta-description"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "First Duplicate Description Page",
          metaDescription: "This exact meta description is copied word for word across multiple distinct pages on the site.",
          bodyHtml: `<h1>First Duplicate Desc Page</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/content/dup-desc-2",
    name: "Duplicate meta description 2",
    category: "content",
    expectedIssues: ["duplicate-meta-description"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Second Duplicate Description Page",
          metaDescription: "This exact meta description is copied word for word across multiple distinct pages on the site.",
          bodyHtml: `<h1>Second Duplicate Desc Page</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/content/dup-content-1",
    name: "Duplicate content 1",
    category: "content",
    expectedIssues: ["duplicate-content"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "First Duplicate Content Page Title",
          metaDescription: "First unique and valid meta description written specifically for the duplicate content test.",
          bodyHtml: `<h1>Shared Article Body</h1><p>This exact body text paragraph repeats completely identically across both pages to produce matching contentHash values. ${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/content/dup-content-2",
    name: "Duplicate content 2",
    category: "content",
    expectedIssues: ["duplicate-content"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Second Duplicate Content Page Title",
          metaDescription: "Second unique and valid meta description written specifically for the duplicate content test.",
          bodyHtml: `<h1>Shared Article Body</h1><p>This exact body text paragraph repeats completely identically across both pages to produce matching contentHash values. ${lorem(180)}</p>`,
        }),
      ),
  },
];
