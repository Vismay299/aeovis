import { getSearchConsolePerformanceTool } from "../own/searchConsole.ts";
import { defineRegistration, type ToolRegistration } from "../types.ts";
import { readAnnotations } from "./quote.ts";

export const registrations: ToolRegistration[] = [
  defineRegistration({
    def: getSearchConsolePerformanceTool as never,
    area: "search_console",
    feature: null,
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: readAnnotations(),
    summarize: (output: any, input: any) =>
      (output?.rows?.length ?? 0) +
      " Search Console queries for the last " +
      String(input?.days ?? 28) +
      " days.",
    link: () => ({ path: "/portal/search-console", label: "Search Console" }),
    example: {
      input: { days: 28 },
      output: { connected: false, rows: [], dataThrough: null },
    },
  }),
];
