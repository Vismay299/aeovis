// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/types/schemas/aiPromptSuggestions.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { defineRouteContract, type RouteContract } from "../http/routeContract.ts";
import { QUESTION_ORIGINS } from "./workspaceQuestions.ts";
import { questionPatchSchema } from "./applyQuestionPatch.ts";

export const SUPPORTED_COUNTRIES = ["in", "us", "uk", "sg", "ae", "ca", "au"] as const;

export const questionsGetQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

export const questionsPatchBody = z
  .strictObject({
    brand_key: z.string().min(1).max(200).optional(),
    expectedRevision: z.number().int().min(0),
    patch: questionPatchSchema.optional(),
    addOrigin: z.enum(["manual", "ai_generate", "prompt_research"]).default("manual"),
    addSourceRef: z
      .record(z.string(), z.union([z.string().max(300), z.number(), z.boolean()]))
      .optional()
      .refine(
        (v) => v === undefined || JSON.stringify(v).length <= 2048,
        "source reference too large"
      ),
    settings: z
      .strictObject({
        persona: z.string().trim().max(500).optional(),
        country: z.enum(SUPPORTED_COUNTRIES).optional(),
        language: z.string().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/).optional(),
      })
      .optional(),
  })
  .refine((b) => b.patch !== undefined || b.settings !== undefined, "Nothing to change");

export const questionsApproveBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  expectedRevision: z.number().int().min(0),
});

export const questionsStateSchema = z.looseObject({
  brandKey: z.string(),
  revision: z.number(),
  settings: z.looseObject({
    persona: z.string().nullable(),
    country: z.string(),
    language: z.string(),
    researchKeywords: z.array(z.string()),
  }),
  questions: z.array(
    z.looseObject({
      id: z.string(),
      text: z.string(),
      topic: z.string(),
      origin: z.enum(QUESTION_ORIGINS),
      status: z.enum(["active", "paused", "archived"]),
      branded: z.boolean(),
      cohort: z.literal("core"),
      replacedBy: z.string().nullable(),
      duplicateReason: z.string().nullable(),
      createdAt: z.string(),
      archivedAt: z.string().nullable(),
    })
  ),
  topics: z.array(
    z.looseObject({
      name: z.string(),
      active: z.number(),
      paused: z.number(),
    })
  ),
  approved: z
    .looseObject({
      version: z.number(),
      approvedAt: z.string(),
      questionCount: z.number(),
      diagnosticCount: z.number(),
      carriesQuestionIds: z.boolean(),
    })
    .nullable(),
  diff: z.looseObject({
    approvedVersion: z.number().nullable(),
    added: z.number(),
    removed: z.number(),
    contextChanged: z.boolean(),
    dirty: z.boolean(),
  }),
  nearDuplicates: z.array(
    z.looseObject({
      leftId: z.string(),
      rightId: z.string(),
      similarity: z.number(),
    })
  ),
  limits: z.looseObject({
    unarchived: z.number(),
    maxUnarchived: z.number(),
    topics: z.number(),
    maxTopics: z.number(),
  }),
  setup: z.looseObject({
    status: z.enum(["none", "running", "review", "failed", "saved"]),
    jobId: z.string().nullable(),
    failure: z.enum(["website_unreadable", "budget_reached", "other"]).nullable(),
  }),
});

export const questionsPatchResponse = questionsStateSchema.extend({
  created: z.number(),
  updated: z.number(),
  skipped: z.number(),
});

export const questionsApproveResponse = z.looseObject({
  panel: z.looseObject({
    version: z.number(),
    approvedAt: z.string(),
    questionCount: z.number(),
    diagnosticCount: z.number(),
    summary: z.record(z.string(), z.number()),
  }),
  state: questionsStateSchema,
});

const EXAMPLE_STATE = {
  brandKey: "offcult.in",
  revision: 14,
  settings: {
    persona: "Indian buyers aged 18–30 shopping for streetwear on their phones",
    country: "in",
    language: "en",
    researchKeywords: ["oversized t-shirts", "anime t-shirts"],
  },
  questions: [
    {
      id: "c4a1b2c3-d4e5-f6a7-b8c9-d0e1f2a3b4c5",
      text: "Which brands sell good oversized T-shirts in India?",
      topic: "Oversized tees",
      origin: "ai_setup",
      status: "active",
      branded: false,
      cohort: "core",
      replacedBy: null,
      duplicateReason: null,
      createdAt: "2026-10-21T09:40:00.000Z",
      archivedAt: null,
    },
  ],
  topics: [{ name: "Oversized tees", active: 1, paused: 0 }],
  approved: {
    version: 3,
    approvedAt: "2026-10-21T09:45:00.000Z",
    questionCount: 32,
    diagnosticCount: 2,
    carriesQuestionIds: true,
  },
  diff: {
    approvedVersion: 3,
    added: 2,
    removed: 1,
    contextChanged: false,
    dirty: true,
  },
  nearDuplicates: [
    {
      leftId: "c4a1b2c3-d4e5-f6a7-b8c9-d0e1f2a3b4c5",
      rightId: "9e0b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d",
      similarity: 0.86,
    },
  ],
  limits: {
    unarchived: 1,
    maxUnarchived: 100,
    topics: 1,
    maxTopics: 30,
  },
  setup: {
    status: "saved",
    jobId: "5b8f1c2a-3d4e-5f6a-7b8c-9d0e1f2a3b4c",
    failure: null,
  },
};

export const questionsGetContract = defineRouteContract({
  id: "questions.get",
  method: "GET",
  path: "/api/customer/questions",
  file: "src/app/api/customer/questions/route.ts",
  auth: "workspace",
  query: questionsGetQuery,
  response: questionsStateSchema,
  errorCodes: [
    "invalid_request",
    "feature_unavailable",
    "questions_unavailable",
    "auth_not_configured",
    "unauthenticated",
    "membership_unavailable",
    "workspace_not_found",
    "workspace_suspended",
  ],
  examples: [{ response: EXAMPLE_STATE }],
});

export const questionsPatchContract = defineRouteContract({
  id: "questions.patch",
  method: "PATCH",
  path: "/api/customer/questions",
  file: "src/app/api/customer/questions/route.ts",
  auth: "workspace",
  request: questionsPatchBody,
  response: questionsPatchResponse,
  errorCodes: [
    "invalid_request",
    "question_invalid",
    "question_unknown",
    "duplicate_edit",
    "revision_conflict",
    "question_duplicate",
    "question_limit",
    "topic_limit",
    "questions_unavailable",
    "feature_unavailable",
    "auth_not_configured",
    "unauthenticated",
    "membership_unavailable",
    "workspace_not_found",
    "workspace_suspended",
  ],
  examples: [
    {
      response: {
        ...EXAMPLE_STATE,
        created: 1,
        updated: 0,
        skipped: 0,
      },
    },
  ],
});

export const questionsApproveContract = defineRouteContract({
  id: "questions.approve",
  method: "POST",
  path: "/api/customer/questions/approve",
  file: "src/app/api/customer/questions/approve/route.ts",
  auth: "workspace",
  request: questionsApproveBody,
  response: questionsApproveResponse,
  errorCodes: [
    "invalid_request",
    "persona_required",
    "nothing_to_approve",
    "panel_invalid",
    "near_duplicates",
    "revision_conflict",
    "panel_conflict",
    "questions_unavailable",
    "feature_unavailable",
    "auth_not_configured",
    "unauthenticated",
    "membership_unavailable",
    "workspace_not_found",
    "workspace_suspended",
  ],
  examples: [
    {
      response: {
        panel: {
          version: 4,
          approvedAt: "2026-10-21T09:50:00.000Z",
          questionCount: 33,
          diagnosticCount: 2,
          summary: { recommendation: 21, information: 10, diagnostic: 2 },
        },
        state: EXAMPLE_STATE,
      },
    },
  ],
});

export const contracts: RouteContract[] = [
  questionsGetContract,
  questionsPatchContract,
  questionsApproveContract,
];
