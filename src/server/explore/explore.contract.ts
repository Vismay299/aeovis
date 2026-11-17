import { z } from "zod";
import { defineRouteContract, type RouteContract } from "../../shared/http/routeContract.ts";
import {
  exploreModelSchema,
  EXPLORE_MAX_PROMPT_LENGTH,
  EXPLORE_MAX_HIGHLIGHT_BRAND_LENGTH,
} from "../../shared/explore.ts";

export const exploreBrandQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

export const exploreStartRequestBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  prompt: z.string().trim().min(1).max(EXPLORE_MAX_PROMPT_LENGTH),
  models: z.preprocess(
    (v) => (Array.isArray(v) ? Array.from(new Set(v)) : v),
    z.array(exploreModelSchema).min(1).max(3),
  ),
  webSearch: z.boolean().default(true),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable()
    .default(null),
  highlightBrand: z.string().trim().min(1).max(EXPLORE_MAX_HIGHLIGHT_BRAND_LENGTH).nullable().default(null),
  fresh: z.boolean().default(false),
  maxUsd: z.number().positive().max(1000).optional(),
});

export const exploreStartResponseSchema = z.looseObject({
  runId: z.string().uuid(),
  jobId: z.string().uuid().nullable(),
  status: z.enum(["queued", "completed"]),
  pollAfterSeconds: z.number().int().min(1).max(60).nullable(),
});

export const exploreListQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
});

export const exploreListResponseSchema = z.looseObject({
  runs: z.array(
    z.looseObject({
      runId: z.string(),
      prompt: z.string(),
      models: z.array(exploreModelSchema),
      status: z.string(),
      createdAt: z.string(),
      questionId: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const exploreGetQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

export const exploreCitationSchema = z.looseObject({
  url: z.string(),
  domain: z.string().nullable(),
  title: z.string().nullable(),
  matchedBrand: z.boolean(),
});

export const exploreSuccessResultSchema = z.looseObject({
  status: z.literal("success"),
  model: exploreModelSchema,
  label: z.string(),
  route: z.enum(["dataforseo", "openrouter"]),
  modelName: z.string().nullable(),
  text: z.string(),
  truncated: z.boolean(),
  citations: z.array(exploreCitationSchema),
  fanOutQueries: z.array(z.string()),
  fanOutReported: z.boolean(),
  brandMentioned: z.boolean(),
  workspaceBrandMentioned: z.boolean(),
  outputTokens: z.number().int().nonnegative().nullable(),
  webSearch: z.boolean(),
  countryHint: z.string().nullable(),
  costUsd: z.number().nonnegative(),
  costState: z.enum(["measured", "estimated", "zero", "unknown"]),
  reusedFrom: z
    .looseObject({
      observationId: z.string(),
      runId: z.string(),
      observedAt: z.string(),
    })
    .nullable(),
  observationId: z.string(),
  observedAt: z.string().nullable(),
});

export const exploreErrorResultSchema = z.looseObject({
  status: z.literal("error"),
  model: exploreModelSchema,
  label: z.string(),
  errorCode: z.enum(["UPSTREAM_ERROR", "UNSUPPORTED_COUNTRY", "NOT_AVAILABLE", "COLLECTION_PAUSED"]),
  message: z.string(),
  costUsd: z.number().nonnegative(),
});

export const exploreModelResultSchema = z.discriminatedUnion("status", [
  exploreSuccessResultSchema,
  exploreErrorResultSchema,
]);

export const exploreGetResponseSchema = z.looseObject({
  runId: z.string().uuid(),
  status: z.enum(["queued", "running", "completed", "partial", "failed", "cancelled"]),
  pollAfterSeconds: z.number().int().min(1).max(60).nullable(),
  prompt: z.string(),
  highlightBrand: z.string().nullable(),
  webSearch: z.boolean(),
  country: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable(),
  approvedMaxUsd: z.number().nonnegative(),
  cost: z.looseObject({
    knownUsd: z.number().nonnegative(),
    unknownModels: z.number().int().nonnegative(),
  }),
  questionId: z.string().nullable(),
  results: z.array(exploreModelResultSchema),
});

export const exploreTrackRequestBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

export const exploreTrackResponseSchema = z.looseObject({
  questionId: z.string(),
  created: z.boolean(),
  status: z.string(),
});

export type ExploreStartResponse = z.infer<typeof exploreStartResponseSchema>;
export type ExploreListResponse = z.infer<typeof exploreListResponseSchema>;
export type ExploreGetResponse = z.infer<typeof exploreGetResponseSchema>;
export type ExploreTrackResponse = z.infer<typeof exploreTrackResponseSchema>;
export type ExploreModelResult = z.infer<typeof exploreModelResultSchema>;
export type ExploreSuccessResult = z.infer<typeof exploreSuccessResultSchema>;
export type ExploreErrorResult = z.infer<typeof exploreErrorResultSchema>;

export const startContract: RouteContract = defineRouteContract({
  id: "explore.start",
  method: "POST",
  path: "/api/customer/explore",
  file: "src/app/api/customer/explore/route.ts",
  auth: "workspace",
  request: exploreStartRequestBody,
  response: exploreStartResponseSchema,
  errorCodes: [
    "invalid_request",
    "invalid_json",
    "approval_required",
    "auth_not_configured",
    "unauthenticated",
    "membership_unavailable",
    "workspace_not_found",
    "feature_disabled",
    "price_changed",
    "collection_paused",
    "no_models_available",
    "explore_already_running",
    "explore_rate_limited",
    "daily_cap",
    "workspace_cap",
    "spend_unavailable",
  ],
  examples: [
    {
      response: {
        runId: "8d0c3f9e-2b1a-4c5d-9e8f-1a2b3c4d5e6f",
        jobId: "5b0d6f6e-9a8b-4a45-9a51-0e7e8f1c2d3a",
        status: "queued",
        pollAfterSeconds: 3,
      },
    },
  ],
});

export const listContract: RouteContract = defineRouteContract({
  id: "explore.list",
  method: "GET",
  path: "/api/customer/explore",
  file: "src/app/api/customer/explore/route.ts",
  auth: "workspace",
  query: exploreListQuery,
  response: exploreListResponseSchema,
  errorCodes: [
    "invalid_request",
    "auth_not_configured",
    "unauthenticated",
    "membership_unavailable",
    "workspace_not_found",
  ],
  examples: [
    {
      response: {
        runs: [
          {
            runId: "8d0c3f9e-2b1a-4c5d-9e8f-1a2b3c4d5e6f",
            prompt: "best running shoes",
            models: ["chatgpt"],
            status: "completed",
            createdAt: "2026-10-22T09:30:05.000Z",
            questionId: null,
          },
        ],
        nextCursor: null,
      },
    },
  ],
});

export const getContract: RouteContract = defineRouteContract({
  id: "explore.get",
  method: "GET",
  path: "/api/customer/explore/[runId]",
  file: "src/app/api/customer/explore/[runId]/route.ts",
  auth: "workspace",
  query: exploreGetQuery,
  response: exploreGetResponseSchema,
  errorCodes: [
    "invalid_request",
    "auth_not_configured",
    "unauthenticated",
    "membership_unavailable",
    "workspace_not_found",
    "explore_run_not_found",
  ],
  examples: [
    {
      response: {
        runId: "8d0c3f9e-2b1a-4c5d-9e8f-1a2b3c4d5e6f",
        status: "completed",
        pollAfterSeconds: null,
        prompt: "best running shoes",
        highlightBrand: "BrandX",
        webSearch: true,
        country: "IN",
        createdAt: "2026-10-22T09:30:05.000Z",
        finishedAt: "2026-10-22T09:30:41.000Z",
        approvedMaxUsd: 0.27,
        cost: { knownUsd: 0.1031, unknownModels: 0 },
        questionId: null,
        results: [
          {
            status: "success",
            model: "chatgpt",
            label: "ChatGPT",
            route: "dataforseo",
            modelName: "gpt-5.6-luna",
            text: "Popular choices include ...",
            truncated: false,
            citations: [
              {
                url: "https://www.example.in/oversized",
                domain: "www.example.in",
                title: "Oversized tees",
                matchedBrand: false,
              },
            ],
            fanOutQueries: ["oversized t-shirt brands india"],
            fanOutReported: true,
            brandMentioned: false,
            workspaceBrandMentioned: false,
            outputTokens: 812,
            webSearch: true,
            countryHint: "IN",
            costUsd: 0.0611,
            costState: "measured",
            reusedFrom: null,
            observationId: "3f1e2d3c-4b5a-6f7e-8d9c-0b1a2f3e4d5c",
            observedAt: "2026-10-22T09:30:29.000Z",
          },
          {
            status: "error",
            model: "gemini",
            label: "Gemini",
            errorCode: "UNSUPPORTED_COUNTRY",
            message: "Gemini doesn’t support country selection. Select “No country preference” above, then run again to include Gemini.",
            costUsd: 0,
          },
        ],
      },
    },
  ],
});

export const trackContract: RouteContract = defineRouteContract({
  id: "explore.track",
  method: "POST",
  path: "/api/customer/explore/[runId]/track",
  file: "src/app/api/customer/explore/[runId]/track/route.ts",
  auth: "workspace",
  request: exploreTrackRequestBody,
  response: exploreTrackResponseSchema,
  errorCodes: [
    "invalid_request",
    "auth_not_configured",
    "unauthenticated",
    "membership_unavailable",
    "workspace_not_found",
    "explore_run_not_found",
    "not_available",
    "cross_site",
  ],
  examples: [
    {
      response: {
        questionId: "c4a1b2c3-d4e5-f6a7-b8c9-d0e1f2a3b4c5",
        created: true,
        status: "active",
      },
    },
  ],
});

export const contracts: RouteContract[] = [
  startContract,
  listContract,
  getContract,
  trackContract,
];
