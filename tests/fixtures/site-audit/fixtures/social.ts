import type { Fixture } from "../types.ts";
import { htmlResponse, renderDocument, lorem } from "./helpers.ts";

export const socialFixtures: Fixture[] = [
  {
    path: "/social/no-og",
    name: "Missing Open Graph tags",
    category: "social",
    expectedIssues: ["missing-og-tags"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page Missing Open Graph Tags",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          ogTitle: undefined,
          ogDescription: undefined,
          ogImage: undefined,
          bodyHtml: `<h1>No Open Graph Tags</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
];
