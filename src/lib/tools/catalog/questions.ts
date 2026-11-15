import { addQuestionsTool, listQuestionsTool } from "../../questions/tools.ts";
import { defineRegistration, type ToolRegistration } from "../types.ts";

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
];
