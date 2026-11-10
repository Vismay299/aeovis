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
    "feature_disabled",
    "daily_cap",
    "workspace_cap",
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

export const questionsSetupBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  maxUsd: z.number().positive().max(1000).optional(),
});

export const questionsSetupResponse = z.looseObject({
  jobId: z.string().uuid(),
  status: z.literal("queued"),
  pollAfterSeconds: z.literal(3),
});

export const questionsSetupSaveBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  jobId: z.string().uuid(),
  expectedRevision: z.number().int().min(0),
  overview: z.string().trim().min(1).max(4000).optional(),
  competitors: z
    .array(
      z.strictObject({
        name: z.string().trim().min(1).max(120),
        domain: z.string().trim().min(1).max(255),
        notes: z.string().trim().max(500).default(""),
      }),
    )
    .max(100),
  selectedCandidateIds: z.array(z.string().regex(/^c\d{1,3}$/)).max(100),
  persona: z.string().trim().min(1).max(500),
  country: z.enum(SUPPORTED_COUNTRIES),
  language: z.string().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/),
  approve: z.boolean(),
});

export const questionsSetupSaveResponse = z.looseObject({
  saved: z.looseObject({
    questionsAdded: z.number(),
    revived: z.number(),
    competitorsSaved: z.number(),
    overviewSaved: z.boolean(),
  }),
  panel: z
    .looseObject({
      version: z.number(),
      approvedAt: z.string(),
      questionCount: z.number(),
      diagnosticCount: z.number(),
      summary: z.record(z.string(), z.number()),
    })
    .nullable(),
  state: questionsStateSchema,
  approveError: z
    .looseObject({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});

export const questionsGenerateBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  requestId: z.string().uuid(),
  topic: z.string().trim().max(100).optional(),
  excludeQuestions: z.array(z.string().trim().max(1500)).max(10).default([]),
  maxUsd: z.number().positive().max(1000).optional(),
});

export const questionsGenerateResponse = z.looseObject({
  topic: z.string(),
  questions: z.array(z.string()),
});

export const questionsResearchBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  requestId: z.string().uuid(),
  keyword: z.string().trim().min(1).max(100),
  maxUsd: z.number().positive().max(1000).optional(),
});

export const questionsResearchResponse = z.looseObject({
  keyword: z.string(),
  questions: z.array(
    z.looseObject({
      text: z.string(),
      variants: z.array(z.string()),
      sources: z.array(
        z.looseObject({
          domain: z.string(),
          url: z.string(),
          title: z.string(),
          own: z.boolean(),
        }),
      ),
      ownDomainCited: z.boolean(),
      brandMentioned: z.boolean(),
      tracked: z.boolean(),
    }),
  ),
  recent: z
    .looseObject({
      entryDate: z.string(),
      summary: z.string(),
    })
    .nullable(),
  dataset: z.literal("us-en"),
});

export const questionsResearchKeywordsResponse = z.looseObject({
  keywords: z.array(z.string()),
});

export const questionsSetupContract = defineRouteContract({
  id: "questions.setup",
  method: "POST",
  path: "/api/customer/questions/setup",
  file: "src/app/api/customer/questions/setup/route.ts",
  auth: "workspace",
  request: questionsSetupBody,
  response: questionsSetupResponse,
  errorCodes: [
    "invalid_request",
    "approval_required",
    "price_changed",
    "setup_running",
    "job_already_running",
    "question_limit",
    "feature_unavailable",
    "feature_disabled",
    "daily_cap",
    "workspace_cap",
    "questions_unavailable",
    "auth_not_configured",
    "unauthenticated",
    "membership_unavailable",
    "workspace_not_found",
    "workspace_suspended",
  ],
  examples: [
    {
      response: {
        jobId: "a0000000-0000-4000-8000-000000000002",
        status: "queued",
        pollAfterSeconds: 3,
      },
    },
  ],
});

export const questionsSetupSaveContract = defineRouteContract({
  id: "questions.setup.save",
  method: "POST",
  path: "/api/customer/questions/setup/save",
  file: "src/app/api/customer/questions/setup/save/route.ts",
  auth: "workspace",
  request: questionsSetupSaveBody,
  response: questionsSetupSaveResponse,
  errorCodes: [
    "invalid_request",
    "setup_not_found",
    "setup_not_ready",
    "setup_already_saved",
    "context_invalid",
    "feature_unavailable",
    "questions_unavailable",
    "auth_not_configured",
    "unauthenticated",
    "membership_unavailable",
    "workspace_not_found",
    "workspace_suspended",
  ],
  examples: [
    {
      response: {
        saved: {
          questionsAdded: 28,
          revived: 2,
          competitorsSaved: 4,
          overviewSaved: true,
        },
        panel: null,
        state: EXAMPLE_STATE,
      },
    },
  ],
});

export const questionsGenerateContract = defineRouteContract({
  id: "questions.generate",
  method: "POST",
  path: "/api/customer/questions/generate",
  file: "src/app/api/customer/questions/generate/route.ts",
  auth: "workspace",
  request: questionsGenerateBody,
  response: questionsGenerateResponse,
  errorCodes: [
    "invalid_request",
    "topic_limit",
    "question_limit",
    "price_changed",
    "duplicate_paid_call",
    "no_new_questions",
    "llm_bad_output",
    "llm_not_configured",
    "feature_unavailable",
    "feature_disabled",
    "daily_cap",
    "workspace_cap",
    "questions_unavailable",
    "auth_not_configured",
    "unauthenticated",
    "membership_unavailable",
    "workspace_not_found",
    "workspace_suspended",
  ],
  examples: [
    {
      response: {
        topic: "Anime t-shirts",
        questions: ["Where can I buy anime T-shirts in India that don't fade?"],
      },
    },
  ],
});

export const questionsResearchContract = defineRouteContract({
  id: "questions.research",
  method: "POST",
  path: "/api/customer/questions/research",
  file: "src/app/api/customer/questions/research/route.ts",
  auth: "workspace",
  request: questionsResearchBody,
  response: questionsResearchResponse,
  errorCodes: [
    "invalid_request",
    "price_changed",
    "duplicate_paid_call",
    "research_unavailable",
    "feature_unavailable",
    "feature_disabled",
    "daily_cap",
    "workspace_cap",
    "questions_unavailable",
    "auth_not_configured",
    "unauthenticated",
    "membership_unavailable",
    "workspace_not_found",
    "workspace_suspended",
  ],
  examples: [
    {
      response: {
        keyword: "oversized t-shirts",
        questions: [],
        recent: null,
        dataset: "us-en",
      },
    },
  ],
});

export const questionsResearchKeywordsContract = defineRouteContract({
  id: "questions.research.keywords",
  method: "GET",
  path: "/api/customer/questions/research/keywords",
  file: "src/app/api/customer/questions/research/keywords/route.ts",
  auth: "workspace",
  query: questionsGetQuery,
  response: questionsResearchKeywordsResponse,
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
  examples: [
    {
      response: {
        keywords: ["oversized t-shirts", "anime t-shirts", "streetwear"],
      },
    },
  ],
});

export const contracts: RouteContract[] = [
  questionsGetContract,
  questionsPatchContract,
  questionsApproveContract,
  questionsSetupContract,
  questionsSetupSaveContract,
  questionsGenerateContract,
  questionsResearchContract,
  questionsResearchKeywordsContract,
];
