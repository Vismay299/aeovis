import { z } from "zod";
import { answerResponse, historyResponse } from "../../questions/history/history.contract.ts";
import { getQuestionAnswer } from "../../questions/history/answer.ts";
import { getQuestionHistory, type HistoryQuery } from "../../questions/history/history.ts";
import type { Workspace } from "../../workspace/requireWorkspace.ts";
import type { ToolDefinition, ToolHandlerContext } from "../types.ts";

const historyInput = z.strictObject({
  questionId: z.uuid(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  engines: z.array(z.string().max(40)).max(10).optional(),
});

const historyOutput = historyResponse.extend({
  range: z.looseObject({
    from: z.string().nullable(),
    to: z.string().nullable(),
  }),
});

const answerInput = z.strictObject({
  questionId: z.uuid(),
  answerId: z.uuid(),
});

function workspace(ctx: ToolHandlerContext): Workspace {
  return {
    user: ctx.user,
    brandKey: ctx.brand.brandKey,
    brand: ctx.brand,
    role: ctx.role,
    admin: ctx.admin,
  };
}

export const getQuestionHistoryTool: ToolDefinition = {
  name: "get_question_history",
  description: "Read measurement history for a tracked question.",
  input: historyInput,
  output: historyOutput,
  handler: async (ctx, raw) => {
    const input = historyInput.parse(raw);

    return getQuestionHistory(workspace(ctx), input.questionId, {
      from: input.from,
      to: input.to,
      engines: input.engines,
    } as HistoryQuery);
  },
};

export const getQuestionAnswerTool: ToolDefinition = {
  name: "get_question_answer",
  description: "Read one stored answer for a tracked question.",
  input: answerInput,
  output: answerResponse,
  handler: async (ctx, raw) => {
    const input = answerInput.parse(raw);

    return getQuestionAnswer(workspace(ctx), input.questionId, input.answerId);
  },
};
