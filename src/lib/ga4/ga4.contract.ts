import { z } from "zod";
import { defineRouteContract } from "../http/routeContract.ts";

export const ga4StatusQuery = z.strictObject({
  brand_key: z.string().optional(),
});

export const ga4PropertySchema = z.looseObject({
  id: z.string(),
  displayName: z.string(),
  timeZone: z.string(),
  currencyCode: z.string(),
  accountDisplayName: z.string(),
});

export const ga4StatusResponse = z.looseObject({
  connected: z.boolean(),
  configured: z.boolean(),
  canManage: z.boolean(),
  currentUserHasGrant: z.boolean(),
  connectorIsMember: z.boolean(),
  grantStatus: z.enum(["active", "error"]).nullable(),
  property: ga4PropertySchema.nullable(),
  connectedByEmail: z.string().nullable(),
  connectedAt: z.string().nullable(),
});

export const ga4ConnectRequest = z.strictObject({
  brand_key: z.string().optional(),
  returnTo: z
    .enum(["/portal/settings/integrations", "/portal/analytics", "/onboarding"])
    .default("/portal/settings/integrations"),
});

export const ga4ConnectResponse = z.looseObject({
  authorizationUrl: z.string(),
});

export const ga4AccountsQuery = z.strictObject({
  brand_key: z.string().optional(),
});

export const ga4AccountItemSchema = z.looseObject({
  grantId: z.string(),
  email: z.string().nullable(),
  status: z.enum(["active", "error"]),
  linkedAt: z.string(),
  workspaces: z.number(),
});

export const ga4AccountsResponse = z.looseObject({
  accounts: z.array(ga4AccountItemSchema),
});

export const ga4AccountDeleteRequest = z.strictObject({
  brand_key: z.string().optional(),
  confirmed: z.literal(true),
});

export const ga4AccountDeleteResponse = z.looseObject({
  removed: z.boolean(),
  workspacesDisconnected: z.number(),
});

export const contracts = [
  defineRouteContract({
    id: "customer.ga4.status.get",
    method: "GET",
    path: "/api/customer/ga4",
    file: "src/app/api/customer/ga4/route.ts",
    auth: "workspace",
    query: ga4StatusQuery,
    response: ga4StatusResponse,
    errorCodes: ["unauthenticated", "feature_unavailable", "ga4_unavailable"],
    examples: [
      {
        response: {
          connected: false,
          configured: true,
          canManage: true,
          currentUserHasGrant: false,
          connectorIsMember: false,
          grantStatus: null,
          property: null,
          connectedByEmail: null,
          connectedAt: null,
        },
      },
      {
        response: {
          connected: true,
          configured: true,
          canManage: true,
          currentUserHasGrant: true,
          connectorIsMember: true,
          grantStatus: "active",
          property: {
            id: "properties/123456789",
            displayName: "Offcult India",
            timeZone: "Asia/Kolkata",
            currencyCode: "INR",
            accountDisplayName: "Offcult",
          },
          connectedByEmail: "owner@example.com",
          connectedAt: "2026-10-22T09:00:00.000Z",
        },
      },
    ],
  }),
  defineRouteContract({
    id: "customer.ga4.connect.post",
    method: "POST",
    path: "/api/customer/ga4/connect",
    file: "src/app/api/customer/ga4/connect/route.ts",
    auth: "workspace",
    request: ga4ConnectRequest,
    response: ga4ConnectResponse,
    errorCodes: [
      "invalid_request",
      "unauthenticated",
      "owner_required",
      "session_expired",
      "ga4_not_configured",
      "feature_unavailable",
    ],
    examples: [
      {
        response: {
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=example",
        },
      },
    ],
  }),
  defineRouteContract({
    id: "customer.ga4.accounts.get",
    method: "GET",
    path: "/api/customer/ga4/accounts",
    file: "src/app/api/customer/ga4/accounts/route.ts",
    auth: "workspace",
    query: ga4AccountsQuery,
    response: ga4AccountsResponse,
    errorCodes: ["unauthenticated", "feature_unavailable", "ga4_unavailable"],
    examples: [
      {
        response: {
          accounts: [
            {
              grantId: "f0000000-0000-0000-0000-000000000001",
              email: "owner@example.com",
              status: "active",
              linkedAt: "2026-10-22T09:00:00.000Z",
              workspaces: 2,
            },
          ],
        },
      },
    ],
  }),
  defineRouteContract({
    id: "customer.ga4.accounts.delete",
    method: "DELETE",
    path: "/api/customer/ga4/accounts/[grantId]",
    file: "src/app/api/customer/ga4/accounts/[grantId]/route.ts",
    auth: "workspace",
    request: ga4AccountDeleteRequest,
    response: ga4AccountDeleteResponse,
    errorCodes: [
      "invalid_request",
      "unauthenticated",
      "ga4_grant_not_found",
      "feature_unavailable",
      "ga4_unavailable",
    ],
    examples: [
      {
        response: {
          removed: true,
          workspacesDisconnected: 2,
        },
      },
    ],
  }),
];
