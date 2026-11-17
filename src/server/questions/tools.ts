// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityConfiguration.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * F08 §6.2.11 — Tools for F22 in-app assistant.
 *
 * `list_questions`: read working set questions, approved version and dirty status.
 * `add_questions`: adds questions with origin "ai_generate", never approves.
 */

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { repairWorkflowStore } from "../db/repairWorkflow.js";
import { diffAgainstApproved, type PanelArtifact } from "./panel.ts";
import {
  QUESTION_ORIGINS,
  addWorkspaceQuestion,
  listWorkspaceQuestions,
  readQuestionSettings,
  type QuestionStatus,
  type WorkspaceQuestion,
} from "./workspaceQuestions.ts";

export type QuestionToolBrand = {
  brandKey: string;
  display_name?: string;
  website?: string;
  aliases?: string[];
};

export type QuestionToolContext = {
  admin: SupabaseClient;
  brand: QuestionToolBrand;
  userId: string;
  deps?: {
    listWorkspaceQuestions?: typeof listWorkspaceQuestions;
    addWorkspaceQuestion?: typeof addWorkspaceQuestion;
    readQuestionSettings?: typeof readQuestionSettings;
    repairWorkflowStore?: typeof repairWorkflowStore;
  };
};

const listInput = z.strictObject({
  status: z.enum(["active", "paused", "archived", "all"]).default("active"),
});

const questionItemSchema = z.looseObject({
  id: z.string(),
  text: z.string(),
  topic: z.string(),
  origin: z.enum(QUESTION_ORIGINS),
  status: z.enum(["active", "paused", "archived"]),
  branded: z.boolean(),
  cohort: z.literal("core"),
  duplicateReason: z.string().nullable(),
  createdAt: z.string(),
  archivedAt: z.string().nullable(),
});

const listOutput = z.looseObject({
  questions: z.array(questionItemSchema),
  approvedVersion: z.number().nullable(),
  dirty: z.boolean(),
});

const addInput = z.strictObject({
  questions: z
    .array(
      z.strictObject({
        text: z.string().min(8).max(1500),
        topic: z.string().max(120).optional(),
      })
    )
    .min(1)
    .max(20),
});

const addOutput = z.looseObject({
  added: z.number(),
  revived: z.number(),
  skipped: z.number(),
});

export const listQuestionsTool = {
  name: "list_questions",
  description:
    "List the buyer questions tracked for this workspace, filtered by status. Shows the approved panel version and whether unapproved changes exist.",
  input: listInput,
  output: listOutput,
  handler: async (ctx: QuestionToolContext, rawInput?: unknown) => {
    const input = listInput.parse(rawInput ?? {});
    const listFn = ctx.deps?.listWorkspaceQuestions ?? listWorkspaceQuestions;
    const settingsFn = ctx.deps?.readQuestionSettings ?? readQuestionSettings;
    const storeFn = ctx.deps?.repairWorkflowStore ?? repairWorkflowStore;

    const brandKey = ctx.brand.brandKey;
    const allQuestions = await listFn(ctx.admin, brandKey);
    const settings = await settingsFn(ctx.admin, brandKey);

    const filteredQuestions =
      input.status === "all"
        ? allQuestions
        : allQuestions.filter((q) => q.status === input.status);

    const heads: any = await storeFn(ctx.admin).list(brandKey, "panel");
    const defaultHead: any = (heads || []).find((h: any) => h?.artifact_key === "default");
    const approvedVersion = defaultHead?.state === "approved" ? defaultHead.version : null;

    const diff = diffAgainstApproved((defaultHead as PanelArtifact) ?? null, allQuestions, settings);

    return listOutput.parse({
      questions: filteredQuestions.map((q) => ({
        id: q.id,
        text: q.text,
        topic: q.topic,
        origin: q.origin,
        status: q.status,
        branded: q.branded,
        cohort: "core",
        duplicateReason: q.duplicateReason,
        createdAt: q.createdAt,
        archivedAt: q.archivedAt,
      })),
      approvedVersion,
      dirty: diff.dirty,
    });
  },
};

export const addQuestionsTool = {
  name: "add_questions",
  description:
    "Add 1 to 20 new buyer questions to this workspace's working set. Existing active questions are skipped; archived questions are revived. Never approves the panel.",
  input: addInput,
  output: addOutput,
  handler: async (ctx: QuestionToolContext, rawInput?: unknown) => {
    const input = addInput.parse(rawInput ?? {});
    const addFn = ctx.deps?.addWorkspaceQuestion ?? addWorkspaceQuestion;
    const brandKey = ctx.brand.brandKey;

    let added = 0;
    let revived = 0;
    let skipped = 0;

    for (const item of input.questions) {
      const res = await addFn(ctx.admin, {
        brandKey,
        text: item.text,
        topic: item.topic,
        origin: "ai_generate",
        createdBy: ctx.userId,
      });

      if (res.created) added++;
      else if (res.revived) revived++;
      else skipped++;
    }

    return addOutput.parse({
      added,
      revived,
      skipped,
    });
  },
};

export const questionTools = [listQuestionsTool, addQuestionsTool];
