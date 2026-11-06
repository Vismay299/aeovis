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
<meta name="description" content="A valid meta description that is long enough to avoid being flagged as too short.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"No Links"}</script>
<meta property="og:title" content="Page With Zero Links">
<meta property="og:description" content="A valid meta description that is long enough to avoid being flagged as too short.">
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
    path: "/structure/deep-page",
    name: "Deep crawl depth page",
    category: "structure",
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
