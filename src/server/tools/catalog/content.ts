import {
  listContentItemsTool,
  startContentDraftTool,
} from "../own/content.ts";
import { defineRegistration, type ToolRegistration } from "../types.ts";
import {
  actionQuoteInput,
  paidAnnotations,
  readAnnotations,
} from "./quote.ts";

export const registrations: ToolRegistration[] = [
  defineRegistration({
    def: startContentDraftTool as never,
    area: "content",
    feature: "assistant_content_drafts",
    effect: "paid",
    approval: (_ctx, input) => ({
      kind: "price",
      action: "content.draft.run",
      quoteInput: actionQuoteInput("content.draft.run", input),
      label: "Start a content draft for “" + String(input.topic ?? "") + "”",
    }),
    annotations: paidAnnotations(),
    summarize: (_output: any, input: any) =>
      "Content draft started for “" + String(input?.topic ?? "") + "”.",
    link: () => ({ path: "/portal/content", label: "Content Studio" }),
    example: {
      input: { topic: "Example topic", maxUsd: 0.15 },
      output: { jobId: "job-example", status: "pending" },
    },
  }),
  defineRegistration({
    def: listContentItemsTool as never,
    area: "content",
    feature: null,
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: readAnnotations(),
    summarize: (output: any) =>
      (output?.items?.length ?? 0) + " content items.",
    link: () => ({ path: "/portal/content", label: "Content Studio" }),
    example: {
      input: {},
      output: { items: [] },
    },
  }),
];
