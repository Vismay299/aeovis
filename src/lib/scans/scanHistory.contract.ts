// F06 phase 5 — route contract for GET /api/customer/scans/history.
import { z } from "zod";
import { defineRouteContract } from "../http/routeContract.ts";
import type { RouteContract } from "../http/routeContract.ts";
import { scanHistoryQueryShape } from "./scanHistory.ts";

export const scanHistoryRow = z.looseObject({
  id: z.string(),
  brand: z.string().nullable(),
  url: z.string().nullable(),
  scanned_at: z.string().nullable(),
  created_at: z.string().nullable(),
  visibility_pct: z.number().nullable(),
  prompts_tracked: z.number().nullable(),
  prompts_mentioned: z.number().nullable(),
  platform: z.union([z.string(), z.array(z.string())]).nullable(),
  engines: z.array(z.string()).optional(),
  collection_partial: z.boolean(),
  started_by: z.enum(["manual", "scheduled"]),
});

export const scanHistoryResponse = z.looseObject({
  brand_key: z.string(),
  scans: z.array(scanHistoryRow),
  totalCount: z.number(),
  page: z.number(),
  size: z.number(),
});

export const contracts: RouteContract[] = [
  defineRouteContract({
    id: "customer.scans.history.get",
    method: "GET",
    path: "/api/customer/scans/history",
    file: "src/app/api/customer/scans/history/route.ts",
    auth: "workspace",
    query: scanHistoryQueryShape,
    response: scanHistoryResponse,
    errorCodes: [
      "invalid_request",
      "unauthenticated",
      "cross_site",
      "workspace_not_found",
      "auth_not_configured",
      "membership_unavailable",
      "internal_error",
    ],
    examples: [
      {
        response: {
          brand_key: "acme",
          scans: [
            {
              id: "0c2a-scan-1",
              brand: "Acme",
              url: "https://acme.example",
              scanned_at: "2026-10-21T09:00:00.000Z",
              created_at: "2026-10-21T09:00:00.000Z",
              visibility_pct: 72,
              prompts_tracked: 30,
              prompts_mentioned: 22,
              platform: ["chatgpt", "gemini"],
              engines: ["chatgpt", "gemini"],
              collection_partial: false,
              started_by: "manual",
            },
          ],
          totalCount: 1,
          page: 1,
          size: 50,
        },
      },
    ],
  }),
];
