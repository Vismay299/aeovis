import type { Fixture } from "../types.ts";
import { htmlResponse, renderDocument, lorem } from "./helpers.ts";

export const structuredDataFixtures: Fixture[] = [
  {
    path: "/data/invalid-json",
    name: "Invalid JSON-LD syntax",
    category: "structured-data",
    expectedIssues: ["structured-data-invalid"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page with Broken JSON-LD Syntax",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          jsonLd: `{"@context": "https://schema.org", "@type": "Article", "headline": "Unclosed string}`,
          bodyHtml: `<h1>Invalid JSON-LD</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/data/no-type",
    name: "JSON-LD missing @type",
    category: "structured-data",
    expectedIssues: ["structured-data-missing-type"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page with JSON-LD Missing Type",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          jsonLd: `{"@context": "https://schema.org", "name": "Nameless Object Without Type"}`,
          bodyHtml: `<h1>Missing @type</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/data/missing-required",
    name: "JSON-LD missing required fields",
    category: "structured-data",
    expectedIssues: ["structured-data-missing-required"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page with Article Missing Headline",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          jsonLd: `{"@context": "https://schema.org", "@type": "Article", "author": "John Doe"}`,
          bodyHtml: `<h1>Missing Required Article Fields</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/data/not-visible",
    name: "JSON-LD claim not visible on page",
    category: "structured-data",
    expectedIssues: ["structured-data-not-visible"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page with Invisible Claim in JSON-LD",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          jsonLd: `{"@context": "https://schema.org", "@type": "Product", "name": "Quantum Widget Invisible Product"}`,
          bodyHtml: `<h1>Visible Page</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/data/none",
    name: "No structured data on indexable content page",
    category: "structured-data",
    expectedIssues: ["no-structured-data"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page with Zero Structured Data",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          jsonLd: null,
          bodyHtml: `<h1>No Structured Data</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
];
