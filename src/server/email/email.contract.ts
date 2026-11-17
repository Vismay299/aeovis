import { z } from "zod";
import { defineRouteContract } from "../../shared/http/routeContract.ts";

export const emailPreferencesQuery = z.strictObject({});

export const emailPreferencesPutRequest = z.strictObject({
  productUpdates: z.boolean().optional(),
  scanResults: z.boolean().optional(),
  scheduleAlerts: z.boolean().optional(),
  spendAlerts: z.boolean().optional(),
  source: z.enum(["onboarding", "settings"]).default("settings"),
}).refine((b) => Object.keys(b).some((k) => k !== "source"), "Nothing to change");

export const emailPreferencesResponse = z.looseObject({
  productUpdates: z.boolean(),
  scanResults: z.boolean(),
  scheduleAlerts: z.boolean(),
  spendAlerts: z.boolean(),
  productUpdatesChangedAt: z.string().nullable(),
  loopsConfigured: z.boolean(),
});

export const emailPreferencesPutResponse = z.looseObject({
  productUpdates: z.boolean(),
  scanResults: z.boolean(),
  scheduleAlerts: z.boolean(),
  spendAlerts: z.boolean(),
  productUpdatesChangedAt: z.string().nullable(),
  loopsConfigured: z.boolean(),
  loopsSynced: z.boolean(),
});

export const emailUnsubscribeRequest = z.strictObject({
  u: z.uuid(),
  c: z.enum(["scan_results", "schedule_alerts", "spend_alerts", "product_updates"]),
  t: z.string().min(20).max(64),
});

export const emailUnsubscribeResponse = z.looseObject({
  unsubscribed: z.boolean(),
  category: z.enum(["scan_results", "schedule_alerts", "spend_alerts", "product_updates"]),
  loopsSynced: z.boolean(),
});

export const contracts = [
  defineRouteContract({
    id: "customer.email.preferences.get",
    method: "GET",
    path: "/api/customer/email/preferences",
    file: "src/app/api/customer/email/preferences/route.ts",
    auth: "user",
    query: emailPreferencesQuery,
    response: emailPreferencesResponse,
    errorCodes: [
      "invalid_request",
      "unauthenticated",
      "auth_not_configured",
      "feature_unavailable",
      "preferences_unavailable",
    ],
    examples: [
      {
        response: {
          productUpdates: false,
          scanResults: true,
          scheduleAlerts: true,
          spendAlerts: true,
          productUpdatesChangedAt: null,
          loopsConfigured: true,
        },
      },
    ],
  }),
  defineRouteContract({
    id: "customer.email.preferences.put",
    method: "PUT",
    path: "/api/customer/email/preferences",
    file: "src/app/api/customer/email/preferences/route.ts",
    auth: "user",
    request: emailPreferencesPutRequest,
    response: emailPreferencesPutResponse,
    errorCodes: [
      "invalid_request",
      "unauthenticated",
      "auth_not_configured",
      "feature_unavailable",
      "email_provider_unavailable",
      "preferences_unavailable",
    ],
    examples: [
      {
        response: {
          productUpdates: true,
          scanResults: true,
          scheduleAlerts: true,
          spendAlerts: true,
          productUpdatesChangedAt: "2026-10-22T10:00:00.000Z",
          loopsConfigured: true,
          loopsSynced: true,
        },
      },
    ],
  }),
  defineRouteContract({
    id: "customer.email.unsubscribe.post",
    method: "POST",
    path: "/api/customer/email/unsubscribe",
    file: "src/app/api/customer/email/unsubscribe/route.ts",
    auth: "user",
    request: emailUnsubscribeRequest,
    response: emailUnsubscribeResponse,
    errorCodes: ["invalid_request", "invalid_link", "preferences_unavailable"],
    examples: [
      {
        response: {
          unsubscribed: true,
          category: "scan_results",
          loopsSynced: true,
        },
      },
    ],
  }),
];
