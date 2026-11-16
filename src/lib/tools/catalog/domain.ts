import { buildDomainResearchHref } from "../../../shared/domain.ts";
import {
  getDomainOverviewTool,
  getRankedKeywordsTool,
} from "../../domain/tools.ts";
import { findSerpCompetitorsTool } from "../own/serp.ts";
import { defineRegistration, type ToolRegistration } from "../types.ts";
import {
  actionQuoteInput,
  paidAnnotations,
  readAnnotations,
} from "./quote.ts";

function domainLink(domain: unknown) {
  return {
    path: buildDomainResearchHref({ domain: String(domain ?? "") }),
    label: "Domain research",
  };
}

export const registrations: ToolRegistration[] = [
  defineRegistration({
    def: getDomainOverviewTool as never,
    area: "domain",
    feature: "domain_research",
    effect: "paid",
    approval: (_ctx, input) =>
      input.cacheOnly === true
        ? { kind: "none" }
        : {
            kind: "price",
            action: "domain.lookup.run",
            quoteInput: actionQuoteInput("domain.lookup.run", input, {
              tab: "keywords",
              pageSize: 50,
            }),
            label: "Domain overview for " + String(input.domain ?? ""),
          },
    annotations: paidAnnotations(),
    summarize: (_output: any, input: any) =>
      "Domain overview for " + String(input?.domain ?? "") + ".",
    link: (_output, input) => domainLink(input?.domain),
    example: {
      input: { domain: "acme.example", maxUsd: 0.1 },
      output: { status: "ok", domain: "acme.example" },
    },
  }),
  defineRegistration({
    def: getRankedKeywordsTool as never,
    area: "domain",
    feature: "domain_research",
    effect: "paid",
    approval: (_ctx, input) =>
      input.cacheOnly === true
        ? { kind: "none" }
        : {
            kind: "price",
            action: "domain.keywords.page",
            quoteInput: actionQuoteInput("domain.keywords.page", input, {
              pageSize: input.pageSize ?? 50,
            }),
            label: "Ranked keywords for " + String(input.domain ?? ""),
          },
    annotations: paidAnnotations(),
    summarize: (output: any, input: any) =>
      (output?.keywords?.length ?? 0) +
      " ranking keywords for " +
      String(input?.domain ?? "") +
      ".",
    link: (_output, input) => domainLink(input?.domain),
    example: {
      input: { domain: "acme.example", maxUsd: 0.1 },
      output: { status: "ok", domain: "acme.example", keywords: [] },
    },
  }),
  defineRegistration({
    def: findSerpCompetitorsTool as never,
    area: "domain",
    feature: "domain_research",
    effect: "paid",
    approval: (_ctx, input) => ({
      kind: "price",
      action: "domain.competitors.run",
      quoteInput: actionQuoteInput("domain.competitors.run", input, {
        keywordCount: Array.isArray(input.keywords) ? input.keywords.length : 0,
        limit: input.limit ?? 50,
      }),
      label: "Find SERP competitors for " + String(input.domain ?? ""),
    }),
    annotations: paidAnnotations(),
    summarize: (output: any, input: any) =>
      (output?.competitors?.length ?? 0) +
      " competitor domains for " +
      String(input?.domain ?? "") +
      ".",
    link: (_output, input) => domainLink(input?.domain),
    example: {
      input: {
        domain: "acme.example",
        keywords: ["example keyword", "another keyword"],
        maxUsd: 0.2,
      },
      output: { competitors: [{ domain: "rival.example" }], totalCount: 1 },
    },
  }),
];
