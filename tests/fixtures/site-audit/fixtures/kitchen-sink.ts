import type { Fixture } from "../types.ts";
import { htmlResponse, renderDocument, lorem } from "./helpers.ts";

export const kitchenSinkFixtures: Fixture[] = [
  {
    path: "/kitchen-sink",
    name: "Kitchen sink test page",
    category: "general",
    expectedIssues: [],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Clean Kitchen Sink Page",
          metaDescription: "A completely clean page that satisfies every audit rule and triggers zero issues.",
          bodyHtml: `<h1>Clean Page</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
];
