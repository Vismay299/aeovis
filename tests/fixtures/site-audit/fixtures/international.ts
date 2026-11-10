import type { Fixture } from "../types.ts";
import { htmlResponse, renderDocument, lorem } from "./helpers.ts";

export const internationalFixtures: Fixture[] = [
  {
    path: "/intl/invalid",
    name: "Invalid hreflang attribute",
    category: "international",
    expectedIssues: ["hreflang-invalid"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page with Invalid Hreflang Tag",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          headExtra: `
            <link rel="alternate" hreflang="en" href="http://main.audit.test/intl/invalid">
            <link rel="alternate" hreflang="invalid-country-code-12345" href="http://main.audit.test/intl/other">
          `,
          bodyHtml: `<h1>Invalid Hreflang</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/intl/no-self",
    name: "Hreflang missing self reference",
    category: "international",
    expectedIssues: ["hreflang-missing-self"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page with Hreflang Missing Self",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          headExtra: '<link rel="alternate" hreflang="fr" href="http://main.audit.test/intl/french">',
          bodyHtml: `<h1>Hreflang Missing Self</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/intl/one-way-a",
    name: "Hreflang return link missing source",
    category: "international",
    expectedIssues: ["hreflang-no-return-link"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Hreflang One Way Link Source",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          headExtra: `
            <link rel="alternate" hreflang="en" href="http://main.audit.test/intl/one-way-a">
            <link rel="alternate" hreflang="fr" href="http://main.audit.test/intl/one-way-b">
          `,
          bodyHtml: `<h1>One Way Hreflang Source</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/intl/one-way-b",
    name: "Hreflang return link missing target",
    category: "international",
    support: true,
    expectedIssues: [],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Hreflang One Way Link Target",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          headExtra: `
            <link rel="alternate" hreflang="fr" href="http://main.audit.test/intl/one-way-b">
          `,
          bodyHtml: `<h1>One Way Hreflang Target</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
];
