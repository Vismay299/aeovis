import { checkAiCrawlerAccessTool } from "../own/aiCrawlers.ts";
import { mapSitePagesTool, readPagesTool } from "../own/siteReading.ts";
import { defineRegistration, type ToolRegistration } from "../types.ts";
import { readAnnotations } from "./quote.ts";

function blockedCrawlers(output: any): number {
  const blocked = output?.blocked ?? {};
  return (
    (blocked.search?.length ?? 0) +
    (blocked.agent?.length ?? 0) +
    (blocked.training?.length ?? 0)
  );
}

export const registrations: ToolRegistration[] = [
  defineRegistration({
    def: mapSitePagesTool as never,
    area: "site",
    feature: null,
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: readAnnotations(),
    summarize: (output: any) =>
      (output?.urls?.length ?? 0) +
      " pages on " +
      String(output?.host ?? "this site") +
      ".",
    example: {
      input: { host: "acme.example" },
      output: {
        host: "acme.example",
        urls: ["https://acme.example/"],
        blocked: false,
      },
    },
  }),
  defineRegistration({
    def: readPagesTool as never,
    area: "site",
    feature: null,
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: readAnnotations(),
    summarize: (output: any) => (output?.pages?.length ?? 0) + " pages read.",
    untrustedPaths: ["pages[*].text", "pages[*].title"],
    example: {
      input: { urls: ["https://acme.example/"] },
      output: {
        pages: [
          {
            url: "https://acme.example/",
            title: "Acme Example",
            text: "Example page text.",
          },
        ],
        skipped: [],
      },
    },
  }),
  defineRegistration({
    def: checkAiCrawlerAccessTool as never,
    area: "site",
    feature: null,
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: readAnnotations(),
    summarize: (output: any) =>
      blockedCrawlers(output) + " AI crawlers blocked.",
    link: () => ({ path: "/portal/audit", label: "Site audit" }),
    example: {
      input: { path: "/" },
      output: {
        host: "acme.example",
        robots: { status: "found", httpStatus: 200 },
        bots: [],
        blocked: { search: [], agent: [], training: [] },
        llmsTxt: { status: "missing", httpStatus: 404 },
      },
    },
  }),
];
