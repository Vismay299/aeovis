import { z } from "zod";
import { defineRouteContract } from "../http/routeContract.ts";
import type { RouteContract } from "../http/routeContract.ts";

/**
 * Request body for `POST /api/customer/exports`.
 *
 * The spec writes this as `z.discriminatedUnion("kind", [...])`, but the route
 * contract harness (src/lib/http/routeContract.test.ts) requires a request
 * schema whose JSON Schema root is closed, and a union has no root
 * `additionalProperties`. With one registered kind, a strict object with a
 * literal `kind` accepts and refuses exactly the same bodies.
 */
export const exportRequest = z.strictObject({
  brandKey: z.string().min(1).max(120),
  kind: z.literal("workspace_answers"),
  format: z.enum(["csv", "json"]),
  params: z.strictObject({
    from: z.iso.date(),
    to: z.iso.date(),
  }),
});

export const exportResponse = z.looseObject({
  exportId: z.string(),
  url: z.string(),
  expiresAt: z.string(),
  format: z.enum(["csv", "json"]),
  rowCount: z.number(),
  filename: z.string(),
});

export const contracts: RouteContract[] = [
  defineRouteContract({
    id: "customer.exports.post",
    method: "POST",
    path: "/api/customer/exports",
    file: "src/app/api/customer/exports/route.ts",
    auth: "workspace",
    request: exportRequest,
    response: exportResponse,
    errorCodes: [
      "invalid_request",
      "invalid_range",
      "invalid_json",
      "unauthenticated",
      "cross_site",
      "feature_disabled",
      "workspace_not_found",
      "export_too_large",
      "no_rows",
      "export_rate_limited",
      "storage_unavailable",
      "auth_not_configured",
      "membership_unavailable",
      "internal_error",
    ],
    examples: [
      {
        response: {
          exportId: "3f1c8a52-7d4e-4b8a-9a3e-2c6f0d9b1e47",
          url: "https://example.supabase.co/storage/v1/object/sign/exports/acme/workspace_answers/3f1c8a52-7d4e-4b8a-9a3e-2c6f0d9b1e47.csv?token=EXAMPLE-NOT-A-REAL-TOKEN",
          expiresAt: "2026-10-21T11:00:00.000Z",
          format: "csv",
          rowCount: 1234,
          filename: "perceev-acme-answers-2026-07-23-to-2026-10-21.csv",
        },
      },
    ],
  }),
];
