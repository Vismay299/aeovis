import {
  getBacklinkHistoryTool,
  getBacklinksOverviewTool,
  listBacklinksTool,
  listReferringDomainsTool,
} from "../../backlinks/tools.ts";
import { defineRegistration, type ToolRegistration } from "../types.ts";
import {
  actionQuoteInput,
  paidAnnotations,
  readAnnotations,
} from "./quote.ts";

const link = () => ({ path: "/portal/backlinks", label: "Backlinks" });

export const registrations: ToolRegistration[] = [
  defineRegistration({
    def: getBacklinksOverviewTool as never,
    area: "backlinks",
    feature: "backlinks",
    effect: "paid",
    approval: (_ctx, input) =>
      input.cacheOnly === true
        ? { kind: "none" }
        : {
            kind: "price",
            action: "backlinks.lookup.run",
            quoteInput: actionQuoteInput("backlinks.lookup.run", input, {
              tab: "backlinks",
              pageSize: 50,
            }),
            label: "Backlink overview for " + String(input.target ?? ""),
          },
    annotations: paidAnnotations(),
    summarize: (_output: any, input: any) =>
      "Backlink overview for " + String(input?.target ?? "") + ".",
    link,
    example: {
      input: { target: "acme.example", maxUsd: 0.1 },
      output: { status: "ok", target: "acme.example" },
    },
  }),
  defineRegistration({
    def: listBacklinksTool as never,
    area: "backlinks",
    feature: "backlinks",
    effect: "paid",
    approval: (_ctx, input) =>
      input.cacheOnly === true
        ? { kind: "none" }
        : {
            kind: "price",
            action: "backlinks.page",
            quoteInput: actionQuoteInput("backlinks.page", input, {
              tab: "backlinks",
              pageSize: input.pageSize ?? 50,
            }),
            label: "List backlinks for " + String(input.target ?? ""),
          },
    annotations: paidAnnotations(),
    summarize: (output: any) => (output?.rows?.length ?? 0) + " backlinks.",
    link,
    example: {
      input: { target: "acme.example", maxUsd: 0.1 },
      output: { status: "ok", target: "acme.example", rows: [] },
    },
  }),
  defineRegistration({
    def: listReferringDomainsTool as never,
    area: "backlinks",
    feature: "backlinks",
    effect: "paid",
    approval: (_ctx, input) =>
      input.cacheOnly === true
        ? { kind: "none" }
        : {
            kind: "price",
            action: "backlinks.page",
            quoteInput: actionQuoteInput("backlinks.page", input, {
              tab: "domains",
              pageSize: input.pageSize ?? 50,
            }),
            label: "List referring domains for " + String(input.target ?? ""),
          },
    annotations: paidAnnotations(),
    summarize: (output: any) =>
      (output?.rows?.length ?? 0) + " referring domains.",
    link,
    example: {
      input: { target: "acme.example", maxUsd: 0.1 },
      output: { status: "ok", target: "acme.example", rows: [] },
    },
  }),
  defineRegistration({
    def: getBacklinkHistoryTool as never,
    area: "backlinks",
    feature: "backlink_snapshots",
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: readAnnotations(),
    summarize: (output: any) =>
      (output?.snapshots?.length ?? 0) + " stored snapshots.",
    link,
    example: {
      input: { target: "acme.example", scope: "domain" },
      output: { snapshots: [] },
    },
  }),
];
