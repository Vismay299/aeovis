import { z } from "zod";
import { defineRouteContract, type RouteContract } from "../../http/routeContract.ts";
import { brandSummarySchema, executionSchema } from "../../../shared/question-history.ts";

export const historyParams = z.strictObject({ questionId: z.uuid() });

export const historyQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  from: z.iso.datetime().optional(),
  to: z.iso.datetime().optional(),
  engines: z
    .string()
    .regex(/^[a-z_]+(,[a-z_]+)*$/)
    .max(100)
    .optional(),
});

export const historyResponse = z.looseObject({
  question: z.looseObject({
    id: z.uuid(),
    text: z.string(),
    topic: z.string().nullable(),
    status: z.string(),
    branded: z.boolean(),
    origin: z.string(),
    replacedBy: z.looseObject({ id: z.uuid(), text: z.string() }).nullable(),
    replaces: z.array(z.looseObject({ id: z.uuid(), text: z.string() })),
  }),
  range: z.looseObject({ from: z.iso.datetime().nullable(), to: z.iso.datetime().nullable() }),
  executions: z.array(executionSchema),
  summary: z.array(brandSummarySchema),
  coverage: z.looseObject({
    total: z.number().int(),
    answered: z.number().int(),
    noAnswer: z.number().int(),
    failed: z.number().int(),
    explore: z.number().int(),
    legacy: z.number().int(),
  }),
  truncated: z.boolean(),
  latestScanId: z.uuid().nullable(),
});

export const answerParams = z.strictObject({ questionId: z.uuid(), answerId: z.uuid() });

export const answerQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

export const answerResponse = z.looseObject({
  execution: executionSchema,
  text: z.string().nullable(),
  markdown: z.string().nullable(),
  truncated: z.boolean(),
  citations: z.array(
    z.looseObject({
      url: z.string(),
      domain: z.string(),
      title: z.string().nullable(),
      position: z.number().int().min(1),
      owned: z.boolean(),
      competitor: z.string().nullable(),
    }),
  ),
  brands: z.array(
    z.looseObject({
      name: z.string(),
      isSelf: z.boolean(),
      mentioned: z.boolean().nullable(),
      cited: z.boolean().nullable(),
      position: z.number().int().nullable(),
      relationship: z.string().nullable(),
      sentimentLabel: z.string().nullable(),
      spans: z.array(z.looseObject({ start: z.number().int().min(0), end: z.number().int().min(1) })),
    }),
  ),
  provenance: z.looseObject({
    method: z.string(),
    methodLabel: z.string(),
    gateway: z.string().nullable(),
    requestedModel: z.string().nullable(),
    returnedModel: z.string().nullable(),
    requestedLocation: z.string().nullable(),
    searchUsed: z.enum(["observed_used", "observed_not_used", "unknown"]),
  }),
  evidence: z.looseObject({
    state: z.enum(["stored", "expired", "withdrawn", "incomplete", "legacy_unknown", "none"]),
    captures: z.array(
      z.looseObject({
        index: z.number().int().min(0),
        state: z.string(),
        href: z.string().nullable(),
        expiresAt: z.iso.datetime().nullable(),
      }),
    ),
  }),
  error: z.string().nullable(),
});

const HISTORY_EXAMPLE = {
  question: {
    id: "0b9c2d4e-6f70-4a81-9b2c-3d4e5f607182",
    text: "best oversized t-shirt brands in india",
    topic: "Oversized tees",
    status: "active",
    branded: false,
    origin: "ai_setup",
    replacedBy: null,
    replaces: [],
  },
  range: { from: "2026-09-23T18:30:00.000Z", to: "2026-10-21T18:29:59.999Z" },
  executions: [
    {
      answerId: "6a1f0000-0000-4000-8000-000000000001",
      source: "scan",
      engine: "chatgpt",
      engineLabel: "ChatGPT",
      collectedAt: "2026-10-20T10:12:04.000Z",
      trigger: "manual",
      status: "answered",
      ownMentioned: false,
      ownCited: false,
      askedText: "best oversized t-shirt brands in india",
      scanId: "9e8d0000-0000-4000-8000-000000000001",
      exploreRunId: null,
      method: "model_api",
      quality: "measured",
    },
  ],
  summary: [{ name: "Offcult", isSelf: true, answers: 1, mentions: 0, unknown: 0, citations: 0 }],
  coverage: { total: 1, answered: 1, noAnswer: 0, failed: 0, explore: 0, legacy: 0 },
  truncated: false,
  latestScanId: "9e8d0000-0000-4000-8000-000000000001",
};

const ANSWER_EXAMPLE = {
  execution: {
    answerId: "6a1f0000-0000-4000-8000-000000000001",
    source: "scan",
    engine: "chatgpt",
    engineLabel: "ChatGPT",
    collectedAt: "2026-10-20T10:12:04.000Z",
    trigger: "manual",
    status: "answered",
    ownMentioned: false,
    ownCited: false,
    askedText: "best oversized t-shirt brands in india",
    scanId: "9e8d0000-0000-4000-8000-000000000001",
    exploreRunId: null,
    method: "model_api",
    quality: "measured",
  },
  text: "Popular oversized t-shirt brands in India include Bewakoof and the Souled Store.",
  markdown: "Popular **oversized** t-shirt brands in India include **Bewakoof** and the Souled Store.",
  truncated: false,
  citations: [
    {
      url: "https://www.bewakoof.com/oversized",
      domain: "bewakoof.com",
      title: "Oversized T-shirts",
      position: 1,
      owned: false,
      competitor: "Bewakoof",
    },
  ],
  brands: [
    {
      name: "Offcult",
      isSelf: true,
      mentioned: false,
      cited: false,
      position: null,
      relationship: null,
      sentimentLabel: null,
      spans: [],
    },
  ],
  provenance: {
    method: "model_api",
    methodLabel: "Model API",
    gateway: "openrouter",
    requestedModel: "openai/gpt-6-luna",
    returnedModel: "openai/gpt-6-luna",
    requestedLocation: "in",
    searchUsed: "observed_used",
  },
  evidence: { state: "stored", captures: [] },
  error: null,
};

export const questionHistoryContract = defineRouteContract({
  id: "questions.history.get",
  method: "GET",
  path: "/api/customer/questions/[questionId]/history",
  file: "src/app/api/customer/questions/[questionId]/history/route.ts",
  auth: "workspace",
  query: historyQuery,
  response: historyResponse,
  errorCodes: [
    "invalid_request",
    "invalid_range",
    "question_not_found",
    "history_unavailable",
    "auth_not_configured",
    "unauthenticated",
    "membership_unavailable",
    "workspace_not_found",
    "workspace_suspended",
  ],
  examples: [{ response: HISTORY_EXAMPLE }],
});

export const questionAnswerContract = defineRouteContract({
  id: "questions.answer.get",
  method: "GET",
  path: "/api/customer/questions/[questionId]/answers/[answerId]",
  file: "src/app/api/customer/questions/[questionId]/answers/[answerId]/route.ts",
  auth: "workspace",
  query: answerQuery,
  response: answerResponse,
  errorCodes: [
    "invalid_request",
    "answer_not_found",
    "history_unavailable",
    "auth_not_configured",
    "unauthenticated",
    "membership_unavailable",
    "workspace_not_found",
    "workspace_suspended",
  ],
  examples: [{ response: ANSWER_EXAMPLE }],
});

export const contracts: RouteContract[] = [questionHistoryContract, questionAnswerContract];
