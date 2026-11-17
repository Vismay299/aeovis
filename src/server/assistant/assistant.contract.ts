import { z } from "zod";
import { priceQuoteSchema } from "../../shared/pricing.ts";
import { defineRouteContract, type RouteContract } from "../../shared/http/routeContract.ts";

export const assistantBrandQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

export const ASSISTANT_COMMON_ERROR_CODES = [
  "invalid_json",
  "invalid_request",
  "auth_not_configured",
  "unauthenticated",
  "cross_site",
  "membership_unavailable",
  "workspace_not_found",
  "storage_unavailable",
  "feature_unavailable",
];

const skillSchema = z.looseObject({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  version: z.string(),
});

export const assistantConfigResponseSchema = z.looseObject({
  configured: z.boolean(),
  reason: z.enum(["llm_not_configured", "model_unpriced"]).optional(),
  turnMaxUsd: z.number(),
  approvalTtlSeconds: z.number(),
  skills: z.array(skillSchema),
  suggestions: z.array(z.string()),
});

const EXAMPLE_CONFIG_RESPONSE = {
  configured: true,
  turnMaxUsd: 0.5,
  approvalTtlSeconds: 900,
  skills: [
    {
      name: "ai-visibility-audit",
      title: "AI Visibility Audit",
      description: "Audit how the brand shows up in AI answers.",
      version: "1.0.0",
    },
  ],
  suggestions: [
    "Where do AI answers name competitors but not us?",
    "Which questions should we add to our panel?",
    "Can AI crawlers read our website?",
    "What should we write next to get cited?",
  ],
};

export const assistantConfigContract = defineRouteContract({
  id: "customer.assistant.config",
  method: "GET",
  path: "/api/customer/assistant/config",
  file: "src/app/api/customer/assistant/config/route.ts",
  auth: "workspace",
  query: assistantBrandQuery,
  response: assistantConfigResponseSchema,
  errorCodes: ASSISTANT_COMMON_ERROR_CODES,
  examples: [{ response: EXAMPLE_CONFIG_RESPONSE }],
});

const sessionSummarySchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const assistantSessionsResponseSchema = z.looseObject({
  sessions: z.array(sessionSummarySchema),
});

const EXAMPLE_SESSIONS_RESPONSE = {
  sessions: [
    {
      id: "6c8f0e5b-6f9e-4a3d-9a1b-2f0c4d5e6a7b",
      title: "Which competitors do AI answers name?",
      createdAt: "2026-10-22T08:01:00.000Z",
      updatedAt: "2026-10-22T08:04:10.000Z",
    },
  ],
};

export const assistantSessionsContract = defineRouteContract({
  id: "customer.assistant.sessions.list",
  method: "GET",
  path: "/api/customer/assistant/sessions",
  file: "src/app/api/customer/assistant/sessions/route.ts",
  auth: "workspace",
  query: assistantBrandQuery,
  response: assistantSessionsResponseSchema,
  errorCodes: ASSISTANT_COMMON_ERROR_CODES,
  examples: [{ response: EXAMPLE_SESSIONS_RESPONSE }],
});

export const assistantSessionCreateRequestSchema = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

export const assistantSessionCreateResponseSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
});

export const assistantSessionCreateContract = defineRouteContract({
  id: "customer.assistant.sessions.create",
  method: "POST",
  path: "/api/customer/assistant/sessions",
  file: "src/app/api/customer/assistant/sessions/route.ts",
  auth: "workspace",
  query: assistantBrandQuery,
  request: assistantSessionCreateRequestSchema,
  response: assistantSessionCreateResponseSchema,
  errorCodes: ASSISTANT_COMMON_ERROR_CODES,
  examples: [
    {
      response: { id: "6c8f0e5b-6f9e-4a3d-9a1b-2f0c4d5e6a7b", title: "New chat" },
    },
  ],
});

const messageSchema = z.looseObject({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  parts: z.array(z.looseObject({ type: z.string() })),
  metadata: z.looseObject({}).optional(),
});

export const assistantSessionResponseSchema = z.looseObject({
  session: z.looseObject({
    id: z.string(),
    title: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    hasKickoff: z.boolean(),
  }),
  messages: z.array(messageSchema),
  activeTurn: z
    .looseObject({ id: z.string(), startedAt: z.string() })
    .nullable(),
});

const EXAMPLE_SESSION_RESPONSE = {
  session: {
    id: "6c8f0e5b-6f9e-4a3d-9a1b-2f0c4d5e6a7b",
    title: "New chat",
    createdAt: "2026-10-22T08:01:00.000Z",
    updatedAt: "2026-10-22T08:04:10.000Z",
    hasKickoff: false,
  },
  messages: [
    {
      id: "u_1",
      role: "user",
      parts: [{ type: "text", text: "Which competitors do AI answers name?" }],
      metadata: { kind: "chat", source: "composer" },
    },
  ],
  activeTurn: null,
};

export const assistantSessionContract = defineRouteContract({
  id: "customer.assistant.session.get",
  method: "GET",
  path: "/api/customer/assistant/sessions/[sessionId]",
  file: "src/app/api/customer/assistant/sessions/[sessionId]/route.ts",
  auth: "workspace",
  query: assistantBrandQuery,
  response: assistantSessionResponseSchema,
  errorCodes: [...ASSISTANT_COMMON_ERROR_CODES, "session_not_found"],
  examples: [{ response: EXAMPLE_SESSION_RESPONSE }],
});

export const assistantSessionPatchRequestSchema = z
  .strictObject({
    brand_key: z.string().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(80).optional(),
    archived: z.literal(true).optional(),
  })
  .refine((body) => body.title !== undefined || body.archived !== undefined, {
    message: "Provide a title or archived.",
  });

export const assistantSessionPatchResponseSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  archived: z.boolean(),
});

export const assistantSessionPatchContract = defineRouteContract({
  id: "customer.assistant.session.patch",
  method: "PATCH",
  path: "/api/customer/assistant/sessions/[sessionId]",
  file: "src/app/api/customer/assistant/sessions/[sessionId]/route.ts",
  auth: "workspace",
  query: assistantBrandQuery,
  request: assistantSessionPatchRequestSchema,
  response: assistantSessionPatchResponseSchema,
  errorCodes: [...ASSISTANT_COMMON_ERROR_CODES, "session_not_found"],
  examples: [
    {
      response: { id: "6c8f0e5b-6f9e-4a3d-9a1b-2f0c4d5e6a7b", title: "Q4 plan", archived: false },
    },
  ],
});

export const assistantStopRequestSchema = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

export const assistantStopResponseSchema = z.looseObject({ stopped: z.boolean() });

export const assistantStopContract = defineRouteContract({
  id: "customer.assistant.stop",
  method: "POST",
  path: "/api/customer/assistant/sessions/[sessionId]/stop",
  file: "src/app/api/customer/assistant/sessions/[sessionId]/stop/route.ts",
  auth: "workspace",
  query: assistantBrandQuery,
  request: assistantStopRequestSchema,
  response: assistantStopResponseSchema,
  errorCodes: [...ASSISTANT_COMMON_ERROR_CODES, "session_not_found"],
  examples: [{ response: { stopped: true } }],
});

export const assistantRewindRequestSchema = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  messageId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
});

export const assistantRewindResponseSchema = z.looseObject({
  removed: z.number(),
  messages: z.array(messageSchema),
});

export const assistantRewindContract = defineRouteContract({
  id: "customer.assistant.rewind",
  method: "POST",
  path: "/api/customer/assistant/sessions/[sessionId]/rewind",
  file: "src/app/api/customer/assistant/sessions/[sessionId]/rewind/route.ts",
  auth: "workspace",
  query: assistantBrandQuery,
  request: assistantRewindRequestSchema,
  response: assistantRewindResponseSchema,
  errorCodes: [...ASSISTANT_COMMON_ERROR_CODES, "session_not_found", "message_not_found"],
  examples: [{ response: { removed: 3, messages: [] } }],
});

export const assistantToolResultSchema = z.union([
  z.looseObject({
    status: z.literal("success"),
    summary: z.string(),
    data: z.unknown(),
    link: z.looseObject({ path: z.string(), label: z.string() }).nullable(),
    untrusted: z.array(z.string()),
    truncated: z.string().nullable(),
  }),
  z.looseObject({
    status: z.literal("awaiting_approval"),
    approvalId: z.string(),
    kind: z.enum(["price", "confirm"]),
    label: z.string(),
    quote: priceQuoteSchema.nullable(),
    expiresAt: z.string(),
    summary: z.string(),
  }),
  z.looseObject({
    status: z.literal("error"),
    code: z.string(),
    message: z.string(),
    recovery: z.string().nullable(),
    retryable: z.boolean(),
    quote: priceQuoteSchema.optional(),
  }),
]);

export const approvalViewSchema = z.looseObject({
  id: z.string(),
  toolName: z.string(),
  label: z.string(),
  kind: z.enum(["price", "confirm"]),
  status: z.string(),
  quote: priceQuoteSchema.nullable(),
  approvedMaxUsd: z.number().nullable(),
  expiresAt: z.string(),
  decidedAt: z.string().nullable(),
  result: assistantToolResultSchema.nullable(),
  errorCode: z.string().nullable(),
});

export const assistantApprovalResponseSchema = z.looseObject({
  approval: approvalViewSchema,
});

const EXAMPLE_QUOTE = {
  action: "keywords.research.run",
  currency: "USD" as const,
  totalUsd: 0.09,
  expectedUsd: null,
  units: [],
  lines: [{ label: "Phrase-match ideas", quantity: 1, unitUsd: 0.0375, totalUsd: 0.0375 }],
  monthly: null,
  warnings: [],
  blocked: null,
  priceVersion: "2026-10-21.1",
  quotedAt: "2026-10-22T08:04:00.000Z",
  inputsHash: "a".repeat(64),
};

const EXAMPLE_APPROVAL = {
  id: "9a1e5b6c-7d8e-4f0a-8b1c-2d3e4f5a6b7c",
  toolName: "research_keywords",
  label: "Research keywords for “oversized t shirt”",
  kind: "price" as const,
  status: "pending",
  quote: EXAMPLE_QUOTE,
  approvedMaxUsd: null,
  expiresAt: "2026-10-22T08:19:00.000Z",
  decidedAt: null,
  result: null,
  errorCode: null,
};

export const assistantApprovalContract = defineRouteContract({
  id: "customer.assistant.approval.get",
  method: "GET",
  path: "/api/customer/assistant/approvals/[approvalId]",
  file: "src/app/api/customer/assistant/approvals/[approvalId]/route.ts",
  auth: "workspace",
  query: assistantBrandQuery,
  response: assistantApprovalResponseSchema,
  errorCodes: [...ASSISTANT_COMMON_ERROR_CODES, "approval_not_found"],
  examples: [{ response: { approval: EXAMPLE_APPROVAL } }],
});

export const assistantDecideRequestSchema = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  decision: z.enum(["approve", "decline"]),
  maxUsd: z.number().positive().max(1000).optional(),
});

export const assistantDecideContract = defineRouteContract({
  id: "customer.assistant.approval.decide",
  method: "POST",
  path: "/api/customer/assistant/approvals/[approvalId]/decide",
  file: "src/app/api/customer/assistant/approvals/[approvalId]/decide/route.ts",
  auth: "workspace",
  query: assistantBrandQuery,
  request: assistantDecideRequestSchema,
  response: assistantApprovalResponseSchema,
  errorCodes: [
    ...ASSISTANT_COMMON_ERROR_CODES,
    "approval_not_found",
    "approval_expired",
    "approval_not_pending",
    "approval_required",
    "approval_corrupt",
    "tool_unavailable",
    "price_changed",
    "feature_disabled",
    "daily_cap",
    "workspace_cap",
  ],
  examples: [
    {
      response: {
        approval: { ...EXAMPLE_APPROVAL, status: "executed", approvedMaxUsd: 0.09 },
      },
    },
  ],
});

export const contracts: RouteContract[] = [
  assistantConfigContract,
  assistantSessionsContract,
  assistantSessionCreateContract,
  assistantSessionContract,
  assistantSessionPatchContract,
  assistantStopContract,
  assistantRewindContract,
  assistantApprovalContract,
  assistantDecideContract,
];
