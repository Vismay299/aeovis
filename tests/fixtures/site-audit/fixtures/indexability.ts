import type { Fixture } from "../types.ts";
import { htmlResponse, renderDocument, lorem } from "./helpers.ts";

export const indexabilityFixtures: Fixture[] = [
  {
    path: "/indexability/noindex",
    name: "Noindex meta tag",
    category: "indexability",
    expectedIssues: ["noindex-page"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page with Noindex Meta Tag",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          robotsMeta: "noindex, follow",
          bodyHtml: `<h1>Noindex Page</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
];
