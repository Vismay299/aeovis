// F23 §6.5 — wire contracts for the customer report routes. Own code.

import { z } from "zod";
import { defineRouteContract, type RouteContract } from "../../shared/http/routeContract.ts";

const COMMON_ERROR_CODES = [
  "invalid_json",
  "invalid_request",
  "auth_not_configured",
  "unauthenticated",
  "cross_site",
  "membership_unavailable",
  "workspace_not_found",
  "storage_unavailable",
  "feature_unavailable",
];

export const reportsBrandQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

export const reportsListQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

const reportListItemSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  skill: z.string().nullable(),
  skillTitle: z.string().nullable(),
  templateId: z.string().nullable(),
  templateName: z.string().nullable(),
  createdBy: z.string(),
  createdByYou: z.boolean(),
  htmlBytes: z.number(),
  shared: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const reportsListResponseSchema = z.looseObject({
  reports: z.array(reportListItemSchema),
});

const reportDetailSchema = z.looseObject({
  id: z.string(),
  title: z.string(),
  skill: z.string().nullable(),
  skillTitle: z.string().nullable(),
  templateId: z.string().nullable(),
  templateName: z.string().nullable(),
  createdBy: z.string(),
  createdByYou: z.boolean(),
  htmlBytes: z.number(),
  shared: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  shareToken: z.string().nullable(),
  sharedAt: z.string().nullable(),
  views30d: z.number().nullable(),
  chatPath: z.string().nullable(),
});

export const reportDetailResponseSchema = z.looseObject({
  report: reportDetailSchema,
});

export const reportDeleteBodySchema = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

export const reportDeleteResponseSchema = z.looseObject({
  reportId: z.string(),
  deleted: z.literal(true),
});

export const reportShareBodySchema = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  public: z.boolean(),
});

export const reportShareResponseSchema = z.looseObject({
  shareToken: z.string().nullable(),
  sharedAt: z.string().nullable(),
});

const templateItemSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  instructions: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const templatesListResponseSchema = z.looseObject({
  templates: z.array(templateItemSchema),
  remaining: z.number(),
});

export const templateSaveBodySchema = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  name: z.string().max(200),
  description: z.string().max(400),
  instructions: z.string().max(6000),
});

export const templateCreateResponseSchema = z.looseObject({
  templateId: z.string(),
  created: z.literal(true),
});

export const templateUpdateResponseSchema = z.looseObject({
  templateId: z.string(),
  created: z.literal(false),
});

export const templateDeleteResponseSchema = z.looseObject({
  templateId: z.string(),
  deleted: z.literal(true),
});

export const generateBodySchema = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  templateId: z.uuid(),
});

export const generateResponseSchema = z.looseObject({
  sessionId: z.string(),
  path: z.string(),
});

const EXAMPLE_LIST_ITEM = {
  id: "1f0c9a2b-3d4e-4f5a-9a1b-2f0c4d5e6a7b",
  title: "AI Visibility Audit — Oct 22, 2026",
  skill: "ai-visibility-audit",
  skillTitle: "AI Visibility Audit",
  templateId: null,
  templateName: null,
  createdBy: "assistant",
  createdByYou: true,
  htmlBytes: 21480,
  shared: false,
  createdAt: "2026-10-22T09:00:00.000Z",
  updatedAt: "2026-10-22T09:00:00.000Z",
};

const EXAMPLE_DETAIL = {
  ...EXAMPLE_LIST_ITEM,
  shareToken: null,
  sharedAt: null,
  views30d: null,
  chatPath: null,
};

const EXAMPLE_TEMPLATE = {
  id: "2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
  name: "Monthly client check-in",
  description: "The monthly update we send retainer clients.",
  instructions: "Audience: the client's marketing lead.",
  createdAt: "2026-10-22T09:00:00.000Z",
  updatedAt: "2026-10-22T09:00:00.000Z",
};

export const reportsListContract = defineRouteContract({
  id: "customer.reports.list",
  method: "GET",
  path: "/api/customer/reports",
  file: "src/app/api/customer/reports/route.ts",
  auth: "workspace",
  query: reportsListQuery,
  response: reportsListResponseSchema,
  errorCodes: COMMON_ERROR_CODES,
  examples: [{ response: { reports: [EXAMPLE_LIST_ITEM] } }],
});

export const reportDetailContract = defineRouteContract({
  id: "customer.reports.detail",
  method: "GET",
  path: "/api/customer/reports/[reportId]",
  file: "src/app/api/customer/reports/[reportId]/route.ts",
  auth: "workspace",
  query: reportsBrandQuery,
  response: reportDetailResponseSchema,
  errorCodes: [...COMMON_ERROR_CODES, "report_not_found"],
  examples: [{ response: { report: EXAMPLE_DETAIL } }],
});

export const reportDeleteContract = defineRouteContract({
  id: "customer.reports.delete",
  method: "DELETE",
  path: "/api/customer/reports/[reportId]",
  file: "src/app/api/customer/reports/[reportId]/route.ts",
  auth: "workspace",
  query: reportsBrandQuery,
  request: reportDeleteBodySchema,
  response: reportDeleteResponseSchema,
  errorCodes: [...COMMON_ERROR_CODES, "report_not_found"],
  examples: [
    { response: { reportId: "1f0c9a2b-3d4e-4f5a-9a1b-2f0c4d5e6a7b", deleted: true } },
  ],
});

export const reportShareContract = defineRouteContract({
  id: "customer.reports.share",
  method: "POST",
  path: "/api/customer/reports/[reportId]/share",
  file: "src/app/api/customer/reports/[reportId]/share/route.ts",
  auth: "workspace",
  query: reportsBrandQuery,
  request: reportShareBodySchema,
  response: reportShareResponseSchema,
  errorCodes: [...COMMON_ERROR_CODES, "report_not_found"],
  examples: [{ response: { shareToken: null, sharedAt: null } }],
});

export const templatesListContract = defineRouteContract({
  id: "customer.reports.templates.list",
  method: "GET",
  path: "/api/customer/reports/templates",
  file: "src/app/api/customer/reports/templates/route.ts",
  auth: "workspace",
  query: reportsBrandQuery,
  response: templatesListResponseSchema,
  errorCodes: COMMON_ERROR_CODES,
  examples: [{ response: { templates: [EXAMPLE_TEMPLATE], remaining: 9 } }],
});

export const templateCreateContract = defineRouteContract({
  id: "customer.reports.templates.create",
  method: "POST",
  path: "/api/customer/reports/templates",
  file: "src/app/api/customer/reports/templates/route.ts",
  auth: "workspace",
  query: reportsBrandQuery,
  request: templateSaveBodySchema,
  response: templateCreateResponseSchema,
  errorCodes: [
    ...COMMON_ERROR_CODES,
    "template_name_required",
    "template_name_too_long",
    "template_description_required",
    "template_description_too_long",
    "template_instructions_required",
    "template_instructions_too_long",
    "template_name_taken",
    "template_limit",
  ],
  examples: [
    {
      response: {
        templateId: "2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        created: true,
      },
    },
  ],
});

export const templateUpdateContract = defineRouteContract({
  id: "customer.reports.templates.update",
  method: "PUT",
  path: "/api/customer/reports/templates/[templateId]",
  file: "src/app/api/customer/reports/templates/[templateId]/route.ts",
  auth: "workspace",
  query: reportsBrandQuery,
  request: templateSaveBodySchema,
  response: templateUpdateResponseSchema,
  errorCodes: [
    ...COMMON_ERROR_CODES,
    "template_not_found",
    "template_name_required",
    "template_name_too_long",
    "template_description_required",
    "template_description_too_long",
    "template_instructions_required",
    "template_instructions_too_long",
    "template_name_taken",
    "template_limit",
  ],
  examples: [
    {
      response: {
        templateId: "2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        created: false,
      },
    },
  ],
});

export const templateDeleteContract = defineRouteContract({
  id: "customer.reports.templates.delete",
  method: "DELETE",
  path: "/api/customer/reports/templates/[templateId]",
  file: "src/app/api/customer/reports/templates/[templateId]/route.ts",
  auth: "workspace",
  query: reportsBrandQuery,
  request: reportDeleteBodySchema,
  response: templateDeleteResponseSchema,
  errorCodes: [...COMMON_ERROR_CODES, "template_not_found"],
  examples: [
    {
      response: {
        templateId: "2a1b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d",
        deleted: true,
      },
    },
  ],
});

export const generateContract = defineRouteContract({
  id: "customer.reports.generate",
  method: "POST",
  path: "/api/customer/reports/generate",
  file: "src/app/api/customer/reports/generate/route.ts",
  auth: "workspace",
  query: reportsBrandQuery,
  request: generateBodySchema,
  response: generateResponseSchema,
  errorCodes: [...COMMON_ERROR_CODES, "template_not_found"],
  examples: [
    {
      response: {
        sessionId: "6c8f0e5b-6f9e-4a3d-9a1b-2f0c4d5e6a7b",
        path: "/portal/assistant?s=6c8f0e5b-6f9e-4a3d-9a1b-2f0c4d5e6a7b",
      },
    },
  ],
});

export const contracts: RouteContract[] = [
  reportsListContract,
  reportDetailContract,
  reportDeleteContract,
  reportShareContract,
  templatesListContract,
  templateCreateContract,
  templateUpdateContract,
  templateDeleteContract,
  generateContract,
];
