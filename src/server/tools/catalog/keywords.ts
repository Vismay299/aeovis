import {
  listSavedKeywordsTool,
  researchKeywordsTool,
  saveKeywordsTool,
} from "../../keywords/tools.ts";
import { getSerpResultsTool } from "../own/serp.ts";
import { defineRegistration, type ToolRegistration } from "../types.ts";
import {
  actionQuoteInput,
  paidAnnotations,
  readAnnotations,
  writeAnnotations,
} from "./quote.ts";

function keywordsLink(keyword: string) {
  return "/portal/keywords?q=" + encodeURIComponent(keyword);
}

export const registrations: ToolRegistration[] = [
  defineRegistration({
    def: listSavedKeywordsTool as never,
    area: "keywords",
    feature: "keyword_research",
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: readAnnotations(),
    summarize: (output: any) =>
      (output?.rows?.length ?? 0) +
      " of " +
      (output?.totalCount ?? 0) +
      " saved keywords.",
    link: () => ({ path: "/portal/keywords/saved", label: "Saved keywords" }),
    example: {
      input: {},
      output: { rows: [], totalCount: 0 },
    },
  }),
  defineRegistration({
    def: saveKeywordsTool as never,
    area: "keywords",
    feature: "keyword_research",
    effect: "write",
    approval: () => ({ kind: "none" }),
    annotations: writeAnnotations(),
    summarize: (output: any) => "Saved " + (output?.created ?? 0) + " keywords.",
    link: () => ({ path: "/portal/keywords/saved", label: "Saved keywords" }),
    example: {
      input: { keywords: ["example keyword"] },
      output: { savedKeywordIds: [], created: 0 },
    },
  }),
  defineRegistration({
    def: researchKeywordsTool as never,
    area: "keywords",
    feature: "keyword_research",
    effect: "paid",
    approval: (_ctx, input) => ({
      kind: "price",
      action: "keywords.research.run",
      quoteInput: actionQuoteInput("keywords.research.run", input),
      label: "Research keywords for “" + String(input.keyword ?? "") + "”",
    }),
    annotations: paidAnnotations(),
    summarize: (output: any, input: any) =>
      (output?.rows?.length ?? 0) +
      " keyword ideas for “" +
      String(input?.keyword ?? "") +
      "”" +
      (output?.cached ? " (cached)" : "") +
      ".",
    link: (_output, input) => ({
      path: keywordsLink(String(input?.keyword ?? "")),
      label: "Keyword research",
    }),
    example: {
      input: { keyword: "example keyword", maxUsd: 0.5 },
      output: { rows: [], source: "cache", cached: true },
    },
  }),
  defineRegistration({
    def: getSerpResultsTool as never,
    area: "keywords",
    feature: "keyword_research",
    effect: "paid",
    approval: (_ctx, input) =>
      input.cacheOnly === true
        ? { kind: "none" }
        : {
            kind: "price",
            action: "keywords.serp.run",
            quoteInput: actionQuoteInput("keywords.serp.run", input),
            label: "SERP results for “" + String(input.keyword ?? "") + "”",
          },
    annotations: paidAnnotations(),
    summarize: (output: any, input: any) =>
      (output?.items?.length ?? 0) +
      " SERP results for “" +
      String(input?.keyword ?? "") +
      "”.",
    link: (_output, input) => ({
      path: keywordsLink(String(input?.keyword ?? "")),
      label: "SERP results",
    }),
    untrustedPaths: ["items[*].title", "items[*].description"],
    example: {
      input: { keyword: "example keyword", depth: 20, maxUsd: 0.05 },
      output: {
        items: [
          {
            rank: 1,
            title: "Example result",
            url: "https://acme.example/page",
            domain: "acme.example",
            description: "A synthetic description.",
          },
        ],
        cached: false,
        fetchedAt: "2026-10-20T10:12:04.000Z",
        depth: 20,
      },
    },
  }),
];
