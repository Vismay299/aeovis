import {
  generateQuestionsTool,
  researchQuestionsTool,
} from "../own/questionsResearch.ts";
import { addQuestionsTool, listQuestionsTool } from "../../questions/tools.ts";
import { defineRegistration, type ToolRegistration } from "../types.ts";
import { actionQuoteInput, paidAnnotations } from "./quote.ts";

export const registrations: ToolRegistration[] = [
  defineRegistration({
    def: listQuestionsTool as never,
    area: "questions",
    feature: "question_curation",
    effect: "read",
    approval: () => ({ kind: "none" }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    },
    summarize: (output: any, input: any) =>
      (output?.questions?.length ?? 0) +
      " questions (" +
      (input?.status ?? "active") +
      "); panel version " +
      (output?.approvedVersion ?? "none") +
      (output?.dirty ? ", unapproved changes" : "") +
      ".",
    link: () => ({ path: "/portal/measurement", label: "Questions" }),
    example: {
      input: { status: "active" },
      output: { questions: [], approvedVersion: null, dirty: false },
    },
  }),
  defineRegistration({
    def: addQuestionsTool as never,
    area: "questions",
    feature: "question_curation",
    effect: "write",
    approval: () => ({ kind: "none" }),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: false,
    },
    summarize: (output: any) =>
      "Added " +
      (output?.added ?? 0) +
      ", revived " +
      (output?.revived ?? 0) +
      ", skipped " +
      (output?.skipped ?? 0) +
      ". Not approved yet.",
    link: () => ({ path: "/portal/measurement", label: "Questions" }),
    example: {
      input: { questions: [{ text: "Which products fit this need?" }] },
      output: { added: 0, revived: 0, skipped: 1 },
    },
  }),
  defineRegistration({
    def: researchQuestionsTool as never,
    area: "questions",
    feature: "prompt_research",
    effect: "paid",
    approval: (_ctx, input) => ({
      kind: "price",
      action: "questions.research.run",
      quoteInput: actionQuoteInput("questions.research.run", input),
      label: "Research questions for “" + String(input.keyword ?? "") + "”",
    }),
    annotations: paidAnnotations(),
    summarize: (output: any, input: any) =>
      (output?.questions?.length ?? 0) +
      " questions for “" +
      String(input?.keyword ?? "") +
      "”.",
    link: () => ({ path: "/portal/measurement", label: "Questions" }),
    untrustedPaths: [
      "questions[*].text",
      "questions[*].sources[*].title",
    ],
    example: {
      input: { keyword: "example keyword", maxUsd: 0.2 },
      output: {
        keyword: "example keyword",
        questions: [{ text: "Which example product fits this need?" }],
        recent: null,
        dataset: "us-en",
      },
    },
  }),
  defineRegistration({
    def: generateQuestionsTool as never,
    area: "questions",
    feature: "question_setup",
    effect: "paid",
    approval: (_ctx, input) => ({
      kind: "price",
      action: "questions.generate.run",
      quoteInput: actionQuoteInput("questions.generate.run", input),
      label: "Draft buyer questions",
    }),
    annotations: paidAnnotations(),
    summarize: (output: any) =>
      (output?.questions?.length ?? 0) + " questions drafted.",
    link: () => ({ path: "/portal/measurement", label: "Questions" }),
    example: {
      input: { topic: "example topic", maxUsd: 0.2 },
      output: { topic: "example topic", questions: [] },
    },
  }),
];
