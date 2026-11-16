import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  researchQuestions,
  type ResearchResult,
} from "../../questions/promptResearch.ts";
import { generateQuestions } from "../../questions/generate.ts";
import type { ToolDefinition } from "../types.ts";
import { toWorkspace } from "./workspace.ts";

const researchInput = z.strictObject({
  keyword: z.string().trim().min(1).max(100),
  maxUsd: z.number().positive().max(1000),
});

const researchOutput = z.looseObject({
  keyword: z.string(),
  questions: z.array(z.looseObject({ text: z.string() })),
});

const generateInput = z.strictObject({
  topic: z.string().trim().max(100).optional(),
  excludeQuestions: z.array(z.string().max(1500)).max(10).default([]),
  maxUsd: z.number().positive().max(1000),
});

const generateOutput = z.looseObject({
  topic: z.string(),
  questions: z.array(z.string()),
});

export type QuestionsResearchDeps = {
  researchQuestions?: typeof researchQuestions;
  generateQuestions?: typeof generateQuestions;
};

export function createResearchQuestionsTool(
  deps: QuestionsResearchDeps = {},
): ToolDefinition {
  return {
    name: "research_questions",
    description:
      "Research real buyer questions that mention a keyword, with their sources.",
    input: researchInput,
    output: researchOutput,
    handler: async (ctx, raw) => {
      const input = researchInput.parse(raw);
      const ws = toWorkspace(ctx);
      const researchFn = deps.researchQuestions ?? researchQuestions;

      const result: ResearchResult = await researchFn(ctx.admin, ws, {
        keyword: input.keyword,
        requestId: randomUUID(),
        maxUsd: input.maxUsd,
      });

      return researchOutput.parse(result);
    },
  };
}

export function createGenerateQuestionsTool(
  deps: QuestionsResearchDeps = {},
): ToolDefinition {
  return {
    name: "generate_questions",
    description:
      "Draft new buyer questions for a topic. Nothing is saved until the user adds them.",
    input: generateInput,
    output: generateOutput,
    handler: async (ctx, raw) => {
      const input = generateInput.parse(raw);
      const ws = toWorkspace(ctx);
      const generateFn = deps.generateQuestions ?? generateQuestions;

      return generateFn(ctx.admin, ws, {
        topic: input.topic,
        excludeQuestions: input.excludeQuestions,
        requestId: randomUUID(),
        maxUsd: input.maxUsd,
      });
    },
  };
}

export const researchQuestionsTool = createResearchQuestionsTool();
export const generateQuestionsTool = createGenerateQuestionsTool();
