import { z } from "zod";
import { defineRouteContract } from "../http/routeContract.ts";
import { POLICY_VERSION } from "./events.ts";

export const privacySourceSchema = z.enum(["onboarding", "settings", "banner"]);

export const privacyPutRequest = z.strictObject({
  analytics: z.boolean(),
  source: privacySourceSchema,
});

export const privacyResponse = z.looseObject({
  analytics: z.boolean().nullable(),
  decidedAt: z.string().nullable(),
  source: privacySourceSchema.nullable(),
  policyVersion: z.string(),
  telemetryAvailable: z.boolean(),
});

export const contracts = [
  defineRouteContract({
    id: "customer.privacy.get",
    method: "GET",
    path: "/api/customer/privacy",
    file: "src/app/api/customer/privacy/route.ts",
    auth: "user",
    response: privacyResponse,
    errorCodes: ["unauthenticated", "auth_not_configured", "privacy_unavailable"],
    examples: [
      {
        response: {
          analytics: null,
          decidedAt: null,
          source: null,
          policyVersion: POLICY_VERSION,
          telemetryAvailable: true,
        },
      },
    ],
  }),
  defineRouteContract({
    id: "customer.privacy.put",
    method: "PUT",
    path: "/api/customer/privacy",
    file: "src/app/api/customer/privacy/route.ts",
    auth: "user",
    request: privacyPutRequest,
    response: privacyResponse,
    errorCodes: ["invalid_request", "unauthenticated", "auth_not_configured", "privacy_unavailable"],
    examples: [
      {
        response: {
          analytics: true,
          decidedAt: "2026-10-22T10:00:00.000Z",
          source: "banner",
          policyVersion: POLICY_VERSION,
          telemetryAvailable: true,
        },
      },
    ],
  }),
];
