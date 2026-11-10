// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiPromptSuggestions.ts:26-146
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../http/appError.ts";
import type { Workspace } from "../workspace/requireWorkspace.ts";
import { createProjectContextRepository } from "../projectContext/repository.ts";
import {
  canonicalQuestionText,
  normalizeQuestionText,
  listWorkspaceQuestions,
  readQuestionSettings,
} from "./workspaceQuestions.ts";
import {
  fitJsonPrompt,
  GENERATE_SYSTEM,
  QUESTIONS_LLM_BOUNDS,
} from "./setup/prompts.ts";
import { suggestedTopicSchema } from "./setup/schemas.ts";
import { llmObject } from "../llm/index.ts";

export const generateBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  requestId: z.string().uuid(),
  topic: z.string().trim().max(100).optional(),
  excludeQuestions: z.array(z.string().trim().max(1500)).max(10).default([]),
  maxUsd: z.number().positive().max(1000).optional(),
});

export type GenerateBody = z.infer<typeof generateBody>;

export type GenerateDeps = {
  repo?: ReturnType<typeof createProjectContextRepository>;
  listWorkspaceQuestions?: typeof listWorkspaceQuestions;
  readQuestionSettings?: typeof readQuestionSettings;
  llmObject?: typeof llmObject;
};

export async function generateQuestions(
  admin: SupabaseClient,
  ws: Workspace,
  input: GenerateBody,
  deps?: GenerateDeps,
): Promise<{ topic: string; questions: string[] }> {
  const listQuestionsFn = deps?.listWorkspaceQuestions ?? listWorkspaceQuestions;
  const current = await listQuestionsFn(admin, ws.brandKey);
  const unarchived = current.filter((q) => q.status !== "archived");

  const topics = Array.from(new Set(unarchived.map((q) => q.topic)));
  const sameTopic = (name: string) =>
    topics.find(
      (t) => normalizeQuestionText(t) === normalizeQuestionText(name),
    );

  const requested = input.topic?.trim();
  const topicName = requested ? (sameTopic(requested) ?? requested) : undefined;

  if (!(topicName && sameTopic(topicName)) && topics.length >= 30) {
    throw new AppError(
      409,
      "topic_limit",
      "Archive the questions of an unused topic before generating a new one.",
    );
  }

  if (unarchived.length >= 100) {
    throw new AppError(
      409,
      "question_limit",
      "Archive unused questions before generating more.",
    );
  }

  const repo = deps?.repo ?? createProjectContextRepository(admin);
  const [sections, competitors, settings] = await Promise.all([
    repo.listSections(ws.brandKey),
    repo.listCompetitors(ws.brandKey),
    (deps?.readQuestionSettings ?? readQuestionSettings)(admin, ws.brandKey),
  ]);

  const outputSchema = topicName
    ? suggestedTopicSchema.extend({ name: z.string().trim().min(1).max(120) })
    : suggestedTopicSchema;

  const promptObj = {
    workspace: {
      name: ws.brand.display_name,
      website: ws.brand.website,
    },
    market: {
      country: settings.country,
      language: settings.language,
    },
    sections: sections.map(({ key, content }) => ({
      key,
      content: content.slice(0, 3500),
    })),
    competitors: competitors.map(({ name, domain }) => ({
      name,
      domain,
    })),
    requestedTopic: topicName ?? null,
    existingTopics: topics,
    existingQuestions: unarchived.map((q) => q.text).slice(0, 50),
    excludedQuestions: (input.excludeQuestions || []).filter(Boolean),
  };
  const prompt = fitJsonPrompt(
    promptObj,
    QUESTIONS_LLM_BOUNDS.generate.inputChars - GENERATE_SYSTEM.length,
  );

  const llmCaller = deps?.llmObject ?? llmObject;
  const { object } = await llmCaller<{ name: string; questions: string[] }>({
    brandKey: ws.brandKey,
    feature: "questions.generate",
    schema: outputSchema,
    system: GENERATE_SYSTEM,
    prompt,
    maxOutputTokens: QUESTIONS_LLM_BOUNDS.generate.outputTokens,
    timeoutMs: 60_000,
    idempotencyKey: `questions.generate:${input.requestId}`,
    maxUsd: input.maxUsd,
  });

  const generated = outputSchema.parse(object);
  const resolvedTopicName = topicName || (sameTopic(generated.name) ?? generated.name);

  // Read again to protect against concurrent saves
  const latest = await listQuestionsFn(admin, ws.brandKey);
  const latestUnarchived = latest.filter((q) => q.status !== "archived");

  const excluded = new Set([
    ...latest.map((q) => q.textNormalized),
    ...(input.excludeQuestions || []).map(normalizeQuestionText),
  ]);

  const questions = generated.questions
    .map(canonicalQuestionText)
    .filter((text) => {
      const normalized = normalizeQuestionText(text);
      if (excluded.has(normalized)) return false;
      excluded.add(normalized);
      return true;
    })
    .slice(0, Math.max(0, 100 - latestUnarchived.length));

  if (questions.length === 0) {
    throw new AppError(
      422,
      "no_new_questions",
      "No new questions were generated. Try a different topic.",
    );
  }

  return { topic: resolvedTopicName, questions };
}
