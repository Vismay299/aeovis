import type { Fixture } from "../types.ts";
import { htmlResponse, renderDocument, lorem } from "./helpers.ts";

export const javascriptFixtures: Fixture[] = [
  {
    path: "/js/app-shell",
    name: "JavaScript app container shell",
    category: "javascript",
    expectedIssues: ["javascript-rendering-suspected"],
    handler: () =>
      htmlResponse(
        `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Loading Application...</title>
<meta name="description" content="A valid meta description that is long enough to avoid being flagged as too short.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebPage","name":"App Shell"}</script>
<meta property="og:title" content="Loading Application...">
<meta property="og:description" content="A valid meta description that is long enough to avoid being flagged as too short.">
<meta property="og:image" content="https://main.audit.test/og-image.jpg">
</head>
<body>
<div id="root"></div>
<script src="/bundle.js"></script>
</body>
</html>`,
      ),
  },
  {
    path: "/snippet/nosnippet",
    name: "Snippet restriction directive",
    category: "javascript",
    expectedIssues: ["snippet-restricted"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page with Snippet Restriction",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          dataNosnippet: true,
          bodyHtml: `<h1>Snippet Restricted</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
];
