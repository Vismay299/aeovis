import { z } from "zod";
import { defineRouteContract } from "../http/routeContract.ts";
import type { RouteContract } from "../http/routeContract.ts";
import { priceQuoteSchema } from "../../shared/pricing.ts";

export const priceEstimateBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  action: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
  input: z.unknown(),
});

export const estimateRouteContract = defineRouteContract({
  id: "pricing.estimate",
  method: "POST",
  path: "/api/customer/price/estimate",
  file: "src/app/api/customer/price/estimate/route.ts",
  auth: "workspace",
  request: priceEstimateBody,
  response: priceQuoteSchema,
  errorCodes: [
    "invalid_request",
    "invalid_json",
    "unknown_price_action",
    "pricing_unavailable",
    "brand_not_found",
    "membership_required",
    "workspace_inactive",
    "auth_unavailable",
  ],
  examples: [
    {
      response: {
        action: "ai_visibility.scan.run",
        currency: "USD",
        totalUsd: 24,
        expectedUsd: 7.2,
        units: [
          { key: "questions", label: "questions", count: 30 },
          { key: "engines", label: "engines", count: 4 },
          { key: "answers", label: "answers", count: 120 },
        ],
        lines: [
          {
            label: "Answers reserved at $0.20 each",
            quantity: 120,
            unitUsd: 0.2,
            totalUsd: 24,
          },
        ],
        monthly: null,
        warnings: [
          {
            code: "retry_note",
            message:
              "Each question is asked once per engine. A failed answer may be retried within this amount.",
          },
          {
            code: "typical_cost",
            message: "Typical cost for this scan is about $7.20, based on recent answers.",
          },
        ],
        blocked: null,
        priceVersion: "2026-10-21.1",
        quotedAt: "2026-10-21T09:30:00.000Z",
        inputsHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      },
    },
  ],
});

export const contracts: RouteContract[] = [estimateRouteContract];
