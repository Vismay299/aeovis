import type { Fixture } from "../types.ts";
import { htmlResponse, renderDocument, lorem } from "./helpers.ts";

export const structureFixtures: Fixture[] = [
  {
    path: "/structure/heading-skip",
    name: "Heading order skip",
    category: "structure",
    expectedIssues: ["heading-order-skip"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page with Heading Order Skip",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          bodyHtml: `<h1>Main Title</h1><h3>Skipped H2 Directly to H3</h3><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/structure/missing-alt",
    name: "Images missing alt text",
    category: "structure",
    expectedIssues: ["images-missing-alt"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page with Images Missing Alt Attribute",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          bodyHtml: `<h1>Images Without Alt</h1><img src="/img/placeholder.png"><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/structure/broken-internal",
    name: "Broken internal link",
    category: "structure",
    expectedIssues: ["broken-internal-link"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page Containing Broken Internal Link",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          bodyHtml: `<h1>Broken Link Source</h1><p><a href="/status/404">Dead Link</a></p><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/structure/no-links",
    name: "No outgoing links",
    category: "structure",
    expectedIssues: ["no-outgoing-links"],
    handler: () =>
      htmlResponse(
        `<!doctype html>
<html lang="en">
<head>
<title>Page With Zero Links</title>
<meta name="description" content="A valid meta description for the page with absolutely zero outgoing links.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage"}</script>
<meta property="og:title" content="Page With Zero Links">
<meta property="og:description" content="A valid meta description for the page with absolutely zero outgoing links.">
<meta property="og:image" content="https://main.audit.test/og-image.jpg">
</head>
<body>
<h1>Page with Absolutely No Outgoing Links</h1>
<p>${lorem(180)}</p>
</body>
</html>`,
      ),
  },
  {
    path: "/structure/orphan",
    name: "Orphan page",
    category: "structure",
    linkedFromCatalog: false,
    inSitemap: true,
    expectedIssues: ["orphan-page"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Orphan Page In Sitemap But Not Linked",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          bodyHtml: `<h1>Orphan Page</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/structure/depth-1",
    name: "Crawl depth step 1",
    category: "structure",
    support: true,
    inSitemap: false,
    linkedFromCatalog: true,
    expectedIssues: [],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Crawl Depth Step 1",
          metaDescription: "The first step in a deep link chain demonstrating nested crawl depth safely.",
          bodyHtml: `<h1>Depth 1</h1><p><a href="/structure/depth-2">Go to depth 2</a></p><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/structure/depth-2",
    name: "Crawl depth step 2",
    category: "structure",
    support: true,
    inSitemap: false,
    linkedFromCatalog: false,
    expectedIssues: [],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Crawl Depth Step 2",
          metaDescription: "The second step in a deep link chain demonstrating nested crawl depth safely.",
          bodyHtml: `<h1>Depth 2</h1><p><a href="/structure/depth-3">Go to depth 3</a></p><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/structure/depth-3",
    name: "Crawl depth step 3",
    category: "structure",
    support: true,
    inSitemap: false,
    linkedFromCatalog: false,
    expectedIssues: [],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Crawl Depth Step 3",
          metaDescription: "The third step in a deep link chain demonstrating nested crawl depth safely.",
          bodyHtml: `<h1>Depth 3</h1><p><a href="/structure/depth-4">Go to depth 4</a></p><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/structure/depth-4",
    name: "Crawl depth step 4",
    category: "structure",
    support: true,
    inSitemap: false,
    linkedFromCatalog: false,
    expectedIssues: [],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Crawl Depth Step 4",
          metaDescription: "The fourth step in a deep link chain demonstrating nested crawl depth safely.",
          bodyHtml: `<h1>Depth 4</h1><p><a href="/structure/deep-page">Go to deep page</a></p><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/structure/deep-page",
    name: "Deep crawl depth page",
    category: "structure",
    inSitemap: false,
    linkedFromCatalog: false,
    expectedIssues: ["deep-page"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Deeply Nested Web Page",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          bodyHtml: `<h1>Deep Page</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
];
