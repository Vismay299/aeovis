import { z } from "zod";
import { defineRouteContract } from "../http/routeContract.ts";
import { ONBOARDING_STEPS, type OnboardingStep } from "../../shared/onboarding.ts";
import { SETUP_STEPS } from "../../shared/setup-steps.ts";
import { SUPPORTED_COUNTRIES } from "../questions/questions.contract.ts";

export { SUPPORTED_COUNTRIES };

export const SETUP_STEP_IDS = [
  "questions",
  "scan",
  "gsc",
  "audit",
  "schedule",
  "ga4",
  "draft",
  "team",
] as const;

export const websiteStepBodySchema = z.strictObject({
  website: z.string().trim().min(3).max(255),
  brandName: z.string().trim().min(1).max(120),
  country: z.enum(SUPPORTED_COUNTRIES),
  language: z.string().regex(/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/),
  handoff: z
    .strictObject({
      domain: z.string().max(253).nullable(),
      scanId: z.string().max(64).nullable(),
    })
    .optional(),
  idempotencyKey: z.string().uuid(),
});

export const onboardingStepBodySchema = z.strictObject({
  step: z.enum(ONBOARDING_STEPS),
  status: z.enum(["done", "skipped"]),
});

export const onboardingCompleteBodySchema = z.strictObject({
  via: z.enum(["wizard", "first_scan", "skipped"]),
});

export const onboardingGetQuerySchema = z.strictObject({
  scan: z.string().optional(),
  domain: z.string().optional(),
});

export const onboardingStateResponseSchema = z.looseObject({
  enabled: z.boolean(),
  needsOnboarding: z.boolean(),
  completedAt: z.string().nullable(),
  workspace: z
    .looseObject({
      brandKey: z.string(),
      displayName: z.string(),
      website: z.string(),
      websiteHost: z.string(),
      role: z.enum(["owner", "member"]),
      telemetryId: z.string(),
      hasScans: z.boolean(),
    })
    .nullable(),
  visibleSteps: z.array(z.enum(ONBOARDING_STEPS)),
  steps: z.record(z.string(), z.enum(["todo", "done", "skipped"])),
  market: z
    .looseObject({
      country: z.string(),
      language: z.string(),
    })
    .nullable(),
  prefill: z
    .looseObject({
      website: z.string(),
      brandName: z.string().nullable(),
      questionCount: z.number(),
    })
    .nullable(),
  handoff: z
    .looseObject({
      domain: z.string().nullable(),
      scanId: z.string().nullable(),
      importedQuestions: z.number().optional(),
      importedAt: z.string().nullable().optional(),
    })
    .nullable(),
  audit: z
    .looseObject({
      available: z.boolean(),
      auditId: z.string().nullable(),
      status: z.string(),
      pagesCrawled: z.number(),
      pagesTotal: z.number(),
    })
    .nullable(),
  research: z
    .looseObject({
      available: z.boolean(),
      status: z.string(),
      jobId: z.string().nullable(),
    })
    .nullable(),
  questions: z
    .looseObject({
      curation: z.boolean(),
      approvedVersion: z.number().nullable(),
      active: z.number(),
      paused: z.number(),
    })
    .nullable(),
  gsc: z
    .looseObject({
      connected: z.boolean(),
      property: z.string().nullable(),
    })
    .nullable(),
  ga4: z
    .looseObject({
      available: z.boolean(),
      connected: z.boolean(),
    })
    .nullable(),
  preferences: z
    .looseObject({
      productUpdatesAvailable: z.boolean(),
      analyticsAvailable: z.boolean(),
    })
    .nullable(),
  domainOverview: z.boolean(),
  pollAfterSeconds: z.number().nullable(),
});

export const onboardingStepResponseSchema = z.looseObject({
  steps: z.record(z.string(), z.any()),
});

export const onboardingCompleteResponseSchema = z.looseObject({
  completedAt: z.string(),
  via: z.enum(["wizard", "first_scan", "skipped"]),
  destination: z.string(),
});

export const setupGetQuerySchema = z.strictObject({
  brand_key: z.string().optional(),
});

export const setupResponseSchema = z.looseObject({
  brandKey: z.string(),
  steps: z.array(
    z.looseObject({
      id: z.enum(SETUP_STEP_IDS),
      status: z.enum(["todo", "done", "skipped"]),
    }),
  ),
});

export const setupDismissBodySchema = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  step: z.enum(SETUP_STEP_IDS),
  dismissed: z.boolean(),
});

export const contracts = [
  defineRouteContract({
    id: "customer.onboarding.get",
    method: "GET",
    path: "/api/customer/onboarding",
    file: "src/app/api/customer/onboarding/route.ts",
    auth: "user",
    query: onboardingGetQuerySchema,
    response: onboardingStateResponseSchema,
    errorCodes: ["unauthenticated", "auth_not_configured", "onboarding_unavailable"],
    examples: [
      {
        response: {
          enabled: true,
          needsOnboarding: true,
          completedAt: null,
          workspace: {
            brandKey: "6d1f0e2a-1111-4000-8000-000000000001",
            displayName: "Acme",
            website: "https://acme.example",
            websiteHost: "acme.example",
            role: "owner",
            telemetryId: "9a7c0000-0000-0000-0000-000000000001",
            hasScans: false,
          },
          visibleSteps: ["website", "search_console", "analytics", "preferences", "first_scan"],
          steps: {
            website: "done",
            search_console: "todo",
            analytics: "todo",
            preferences: "todo",
            first_scan: "todo",
          },
          market: { country: "in", language: "en" },
          prefill: { website: "https://acme.example", brandName: "Acme", questionCount: 24 },
          handoff: { domain: "acme.example", scanId: "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90", importedQuestions: 24 },
          audit: { available: true, auditId: "5b8f0000-0000-0000-0000-000000000001", status: "running", pagesCrawled: 12, pagesTotal: 50 },
          research: { available: true, status: "running", jobId: "77e10000-0000-0000-0000-000000000001" },
          questions: { curation: true, approvedVersion: null, active: 0, paused: 24 },
          gsc: { connected: false, property: null },
          ga4: { available: true, connected: false },
          preferences: { productUpdatesAvailable: true, analyticsAvailable: true },
          domainOverview: true,
          pollAfterSeconds: 5,
        },
      },
    ],
  }),
  defineRouteContract({
    id: "customer.onboarding.website.post",
    method: "POST",
    path: "/api/customer/onboarding/website",
    file: "src/app/api/customer/onboarding/website/route.ts",
    auth: "user",
    request: websiteStepBodySchema,
    response: onboardingStateResponseSchema,
    errorCodes: [
      "invalid_request",
      "unauthenticated",
      "auth_not_configured",
      "email_unverified",
      "website_invalid",
      "brand_name_invalid",
      "website_locked",
      "already_has_workspace",
      "workspace_exists",
      "internal_error",
      "onboarding_unavailable",
    ],
    examples: [
      {
        response: {
          enabled: true,
          needsOnboarding: true,
          completedAt: null,
          workspace: {
            brandKey: "6d1f0e2a-1111-4000-8000-000000000001",
            displayName: "Acme",
            website: "https://acme.example",
            websiteHost: "acme.example",
            role: "owner",
            telemetryId: "9a7c0000-0000-0000-0000-000000000001",
            hasScans: false,
          },
          visibleSteps: ["website", "search_console", "analytics", "preferences", "first_scan"],
          steps: {
            website: "done",
            search_console: "todo",
            analytics: "todo",
            preferences: "todo",
            first_scan: "todo",
          },
          market: { country: "in", language: "en" },
          prefill: null,
          handoff: { domain: "acme.example", scanId: "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90" },
          audit: { available: true, auditId: null, status: "not_started", pagesCrawled: 0, pagesTotal: 50 },
          research: { available: true, status: "none", jobId: null },
          questions: { curation: true, approvedVersion: null, active: 0, paused: 0 },
          gsc: { connected: false, property: null },
          ga4: { available: true, connected: false },
          preferences: { productUpdatesAvailable: true, analyticsAvailable: true },
          domainOverview: true,
          pollAfterSeconds: null,
        },
      },
    ],
  }),
  defineRouteContract({
    id: "customer.onboarding.step.post",
    method: "POST",
    path: "/api/customer/onboarding/step",
    file: "src/app/api/customer/onboarding/step/route.ts",
    auth: "user",
    request: onboardingStepBodySchema,
    response: onboardingStepResponseSchema,
    errorCodes: ["invalid_request", "unauthenticated", "auth_not_configured", "step_hidden"],
    examples: [
      {
        response: {
          steps: {
            website: { status: "done", at: "2026-10-23T09:12:00.000Z" },
          },
        },
      },
    ],
  }),
  defineRouteContract({
    id: "customer.onboarding.complete.post",
    method: "POST",
    path: "/api/customer/onboarding/complete",
    file: "src/app/api/customer/onboarding/complete/route.ts",
    auth: "user",
    request: onboardingCompleteBodySchema,
    response: onboardingCompleteResponseSchema,
    errorCodes: ["invalid_request", "unauthenticated", "auth_not_configured"],
    examples: [
      {
        response: {
          completedAt: "2026-10-23T09:12:00.000Z",
          via: "wizard",
          destination: "/portal",
        },
      },
    ],
  }),
  defineRouteContract({
    id: "customer.setup.get",
    method: "GET",
    path: "/api/customer/setup",
    file: "src/app/api/customer/setup/route.ts",
    auth: "workspace",
    query: setupGetQuerySchema,
    response: setupResponseSchema,
    errorCodes: [
      "unauthenticated",
      "workspace_not_found",
      "feature_unavailable",
      "setup_unavailable",
    ],
    examples: [
      {
        response: {
          brandKey: "6d1f0e2a-1111-4000-8000-000000000001",
          steps: [
            { id: "questions", status: "todo" },
            { id: "scan", status: "todo" },
            { id: "gsc", status: "done" },
            { id: "audit", status: "done" },
            { id: "draft", status: "skipped" },
            { id: "team", status: "todo" },
          ],
        },
      },
    ],
  }),
  defineRouteContract({
    id: "customer.setup.dismiss.post",
    method: "POST",
    path: "/api/customer/setup/dismiss",
    file: "src/app/api/customer/setup/dismiss/route.ts",
    auth: "workspace",
    request: setupDismissBodySchema,
    response: setupResponseSchema,
    errorCodes: [
      "invalid_request",
      "unauthenticated",
      "workspace_not_found",
      "feature_unavailable",
      "setup_unavailable",
    ],
    examples: [
      {
        response: {
          brandKey: "6d1f0e2a-1111-4000-8000-000000000001",
          steps: [
            { id: "questions", status: "todo" },
            { id: "scan", status: "todo" },
            { id: "gsc", status: "done" },
            { id: "audit", status: "done" },
            { id: "draft", status: "skipped" },
            { id: "team", status: "todo" },
          ],
        },
      },
    ],
  }),
];
