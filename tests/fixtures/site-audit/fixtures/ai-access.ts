import type { Fixture } from "../types.ts";
import { htmlResponse, renderDocument, lorem } from "./helpers.ts";

export const aiAccessFixtures: Fixture[] = [
  {
    path: "/ai/search-blocked",
    name: "AI search crawler blocked",
    category: "ai-access",
    expectedIssues: ["ai-search-crawler-blocked"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page Blocked for AI Search Bots",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          bodyHtml: `<h1>AI Search Blocked</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
  {
    path: "/ai/agent-blocked",
    name: "AI agent crawler blocked",
    category: "ai-access",
    expectedIssues: ["ai-agent-crawler-blocked"],
    handler: () =>
      htmlResponse(
        renderDocument({
          title: "Page Blocked for AI Agent Bots",
          metaDescription: "A valid meta description that is long enough to avoid being flagged as too short.",
          bodyHtml: `<h1>AI Agent Blocked</h1><p>${lorem(180)}</p>`,
        }),
      ),
  },
];
