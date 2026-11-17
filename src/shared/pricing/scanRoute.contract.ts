import { z } from "zod";
import { defineRouteContract } from "../http/routeContract.ts";
import type { RouteContract } from "../http/routeContract.ts";

export const scanRouteBody = z.looseObject({
  brand_key: z.string().min(1).max(200).optional(),
  panel_key: z.string().min(1).max(80).optional(),
  industry: z.string().max(200).optional(),
  competitors: z.string().max(2000).optional(),
  maxUsd: z.number().positive().max(1000).optional(),
});

export const scanRouteResponse = z.looseObject({
  job_id: z.string().uuid(),
  brand: z.string(),
  status: z.literal("pending"),
  approvedMaxUsd: z.number().positive(),
  quotedUsd: z.number().min(0),
});

export const scanRouteContractBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  panel_key: z.string().min(1).max(80).optional(),
  industry: z.string().max(200).optional(),
  competitors: z.string().max(2000).optional(),
  maxUsd: z.number().positive().max(1000).optional(),
});

export const scanRouteContract = defineRouteContract({
  id: "customer.scan.start",
  method: "POST",
  path: "/api/customer/scan",
  file: "src/app/api/customer/scan/route.js",
  auth: "workspace",
  request: scanRouteContractBody,
  response: scanRouteResponse,
  errorCodes: [
    "invalid_request",
    "invalid_json",
    "panel_not_approved",
    "no_engines",
    "over_scan_limit",
    "price_changed",
    "daily_cap",
    "workspace_cap",
    "feature_disabled",
    "scan_already_running",
    "spend_unavailable",
    "internal_error",
    "unauthenticated",
    "auth_not_configured",
    "cross_site",
    "membership_unavailable",
    "workspace_not_found",
    "storage_unavailable",
  ],
  examples: [
    {
      response: {
        job_id: "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90",
        brand: "Offcult",
        status: "pending",
        approvedMaxUsd: 24,
        quotedUsd: 24,
      },
    },
  ],
});

export const contracts: RouteContract[] = [scanRouteContract];
