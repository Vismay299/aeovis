import { z } from "zod";
import { defineRouteContract } from "../http/routeContract.ts";

export const spendControlSchema = z.looseObject({
  feature: z.string(),
  enabled: z.boolean(),
  mode: z.enum(["all", "allowlist"]),
  brandAllowlist: z.array(z.string()),
  dailyCapUsd: z.number().nullable(),
  maxCallUsd: z.number().nullable(),
  note: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});

export const spendLimitSchema = z.looseObject({
  brandKey: z.string(),
  dailyCapUsd: z.number().nullable(),
  monthlyCapUsd: z.number().nullable(),
  updatedAt: z.iso.datetime(),
});

export const spendLimitsQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

/**
 * The path brand key of `PUT /api/ops/spend/limits/[brandKey]`. Bounded because
 * it is a URL segment, not a body field: an unbounded key would reach the
 * database as an arbitrary-length parameter.
 */
export const brandKeyParamSchema = z.string().min(1).max(200);

export function spendControlPutSchema(feature: string) {
  return z.strictObject({
    enabled: z.boolean(),
    mode: z.enum(["all", "allowlist"]),
    brandAllowlist: z.array(z.string().min(1)).max(50),
    dailyCapUsd: z.number().min(0).max(10000).nullable(),
    maxCallUsd: z.number().positive().max(1000).nullable(),
    note: z.string().max(500).nullable(),
    confirm: z.literal(feature),
  });
}

/**
 * Both caps are optional so one can be set without restating the other. A null
 * column means "no cap", not "fall back to the env default", so an omitted cap
 * keeps whatever ceiling the workspace already had; the route resolves that.
 * At least one cap must be named — the route rejects `{}` as invalid_request.
 */
export const spendLimitsPutSchema = z.strictObject({
  dailyCapUsd: z.number().min(0).max(10000).nullable().optional(),
  monthlyCapUsd: z.number().min(0).max(100000).nullable().optional(),
});

export const spendControlsListResponse = z.looseObject({
  controls: z.array(spendControlSchema),
});

export const spendLimitsListResponse = z.looseObject({
  limits: z.array(spendLimitSchema),
});

export type SpendControlInput = {
  enabled: boolean;
  mode: "all" | "allowlist";
  brandAllowlist: string[];
  dailyCapUsd: number | null;
  maxCallUsd: number | null;
  note: string | null;
};

export type SpendLimitInput = { dailyCapUsd?: number | null; monthlyCapUsd?: number | null };

export const contracts = [
  defineRouteContract({
    id: "ops.spend.controls.list",
    method: "GET",
    path: "/api/ops/spend/controls",
    file: "src/app/api/ops/spend/controls/route.ts",
    auth: "operator",
    response: spendControlsListResponse,
    errorCodes: ["storage_unavailable", "spend_unavailable"],
    examples: [
      {
        response: {
          controls: [
            {
              feature: "platform.selftest",
              enabled: false,
              mode: "allowlist",
              brandAllowlist: [],
              dailyCapUsd: null,
              maxCallUsd: null,
              note: "Owner-run LLM helper live check.",
              updatedAt: "2026-10-21T09:00:00.000Z",
            },
          ],
        },
      },
    ],
  }),
  defineRouteContract({
    id: "ops.spend.controls.put",
    method: "PUT",
    path: "/api/ops/spend/controls/[feature]",
    file: "src/app/api/ops/spend/controls/[feature]/route.ts",
    auth: "operator",
    request: spendControlPutSchema("platform.selftest"),
    response: spendControlSchema,
    errorCodes: ["invalid_request", "unknown_spend_feature", "storage_unavailable", "spend_unavailable"],
    examples: [
      {
        response: {
          feature: "platform.selftest",
          enabled: false,
          mode: "allowlist",
          brandAllowlist: [],
          dailyCapUsd: null,
          maxCallUsd: null,
          note: "Owner-run LLM helper live check.",
          updatedAt: "2026-10-21T09:00:00.000Z",
        },
      },
    ],
  }),
  defineRouteContract({
    id: "ops.spend.limits.list",
    method: "GET",
    path: "/api/ops/spend/limits",
    file: "src/app/api/ops/spend/limits/route.ts",
    auth: "operator",
    query: spendLimitsQuery,
    response: spendLimitsListResponse,
    errorCodes: ["invalid_request", "storage_unavailable", "spend_unavailable"],
    examples: [
      {
        response: {
          limits: [
            {
              brandKey: "example-workspace",
              dailyCapUsd: 25,
              monthlyCapUsd: null,
              updatedAt: "2026-10-21T09:00:00.000Z",
            },
          ],
        },
      },
    ],
  }),
  defineRouteContract({
    id: "ops.spend.limits.put",
    method: "PUT",
    path: "/api/ops/spend/limits/[brandKey]",
    file: "src/app/api/ops/spend/limits/[brandKey]/route.ts",
    auth: "operator",
    request: spendLimitsPutSchema,
    response: spendLimitSchema,
    errorCodes: [
      "invalid_request",
      "workspace_not_found",
      "storage_unavailable",
      "spend_unavailable",
    ],
    examples: [
      {
        response: {
          brandKey: "example-workspace",
          dailyCapUsd: 25,
          monthlyCapUsd: null,
          updatedAt: "2026-10-21T09:00:00.000Z",
        },
      },
    ],
  }),
];
