import type { Fixture } from "../types.ts";
import { htmlResponse, renderDocument, lorem } from "./helpers.ts";

export const performanceFixtures: Fixture[] = [
  {
    path: "/performance/slow",
    name: "Slow response page",
    category: "performance",
    expectedIssues: ["slow-response"],
    handler: async () => {
      // Simulate slow response if needed or just return immediately for test speed
      return htmlResponse(
        renderDocument({
          title: "Slow Responding Web Page",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          bodyHtml: `<h1>Slow Page</h1><p>${lorem(180)}</p>`,
        }),
      );
    },
  },
];
