import { z } from "zod";
import { defineRouteContract } from "../../shared/http/routeContract.ts";
import type { RouteContract } from "../../shared/http/routeContract.ts";
import { KEY_FILE_STATUSES } from "../../shared/indexnow.ts";

export const getIndexNowQuery = z.strictObject({
  brand_key: z.string().min(1).max(120).optional(),
});

export const hostCheckSchema = z.looseObject({
  host: z.string(),
  status: z.enum(KEY_FILE_STATUSES),
});

export const indexNowSetupResponse = z.looseObject({
  domain: z.string(),
  key: z.string().nullable(),
  hosts: z.array(hostCheckSchema).nullable(),
  checkedAt: z.string().nullable(),
  ready: z.boolean(),
  limits: z.looseObject({
    requestsLastHour: z.number(),
    maxRequestsPerHour: z.number(),
    urlsToday: z.number(),
    maxUrlsPerDay: z.number(),
  }),
});

export const setupIndexNowRequest = z.strictObject({
  brand_key: z.string().min(1).max(120).optional(),
});

export const setupIndexNowResponse = z.looseObject({
  domain: z.string(),
  key: z.string(),
  created: z.boolean(),
});

export const checkIndexNowRequest = z.strictObject({
  brand_key: z.string().min(1).max(120).optional(),
  force: z.boolean().default(false),
});

export const checkIndexNowResponse = z.looseObject({
  hosts: z.array(hostCheckSchema),
  checkedAt: z.string(),
  cached: z.boolean(),
});

export const submitIndexNowRequest = z.strictObject({
  brand_key: z.string().min(1).max(120).optional(),
  urls: z.array(z.string().trim().min(1).max(2048)).min(1).max(10000),
  source: z.enum(["settings", "audit", "content"]),
  sourceRef: z.string().max(100).optional(),
  requestId: z.string().uuid(),
});

export const hostResultSchema = z.looseObject({
  host: z.string(),
  urlCount: z.number(),
  status: z.enum(["submitted", "failed"]),
  engine: z.enum(["bing", "yandex", "yep"]).nullable(),
  httpStatus: z.number().nullable(),
  reason: z.string().nullable(),
  message: z.string(),
});

export const skippedUrlSchema = z.looseObject({
  url: z.string(),
  reason: z.enum(["off_site", "invalid", "recently_submitted"]),
});

export const submitIndexNowResponse = z.looseObject({
  key: z.string(),
  keyCreated: z.boolean(),
  hosts: z.array(hostResultSchema),
  skipped: z.array(skippedUrlSchema),
});

export const submissionsQuery = z.strictObject({
  brand_key: z.string().min(1).max(120).optional(),
  source: z.enum(["settings", "audit", "content", "tool"]).optional(),
  sourceRef: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20).optional(),
});

export const submissionItemSchema = z.looseObject({
  id: z.string(),
  createdAt: z.string(),
  source: z.enum(["settings", "audit", "content", "tool"]),
  sourceRef: z.string().nullable(),
  host: z.string(),
  urlCount: z.number(),
  urls: z.array(z.string()),
  status: z.enum(["submitted", "failed"]),
  engine: z.enum(["bing", "yandex", "yep"]).nullable(),
  httpStatus: z.number().nullable(),
  message: z.string(),
});

export const submissionsResponse = z.looseObject({
  submissions: z.array(submissionItemSchema),
});

export const contracts: RouteContract[] = [
  defineRouteContract({
    id: "customer.indexnow.get",
    method: "GET",
    path: "/api/customer/indexnow",
    file: "src/app/api/customer/indexnow/route.ts",
    auth: "workspace",
    query: getIndexNowQuery,
    response: indexNowSetupResponse,
    errorCodes: [
      "feature_unavailable",
      "invalid_request",
      "unauthenticated",
      "membership_unavailable",
      "workspace_not_found",
      "indexnow_unavailable",
    ],
    examples: [
      {
        response: {
          domain: "offcult.in",
          key: "3f2a9c1e5b7d4f60a8c2e1b3d5f7a9c1",
          hosts: [
            { host: "offcult.in", status: "found" },
            { host: "www.offcult.in", status: "moved" },
          ],
          checkedAt: "2026-10-22T09:00:00.000Z",
          ready: true,
          limits: {
            requestsLastHour: 2,
            maxRequestsPerHour: 30,
            urlsToday: 14,
            maxUrlsPerDay: 10000,
          },
        },
      },
      {
        response: {
          domain: "offcult.in",
          key: null,
          hosts: null,
          checkedAt: null,
          ready: false,
          limits: {
            requestsLastHour: 0,
            maxRequestsPerHour: 30,
            urlsToday: 0,
            maxUrlsPerDay: 10000,
          },
        },
      },
    ],
  }),
  defineRouteContract({
    id: "customer.indexnow.setup.post",
    method: "POST",
    path: "/api/customer/indexnow/setup",
    file: "src/app/api/customer/indexnow/setup/route.ts",
    auth: "workspace",
    request: setupIndexNowRequest,
    response: setupIndexNowResponse,
    errorCodes: [
      "feature_unavailable",
      "invalid_request",
      "invalid_json",
      "cross_site",
      "unauthenticated",
      "membership_unavailable",
      "workspace_not_found",
      "indexnow_unavailable",
    ],
    examples: [
      {
        response: {
          domain: "offcult.in",
          key: "3f2a9c1e5b7d4f60a8c2e1b3d5f7a9c1",
          created: true,
        },
      },
    ],
  }),
  defineRouteContract({
    id: "customer.indexnow.check.post",
    method: "POST",
    path: "/api/customer/indexnow/check",
    file: "src/app/api/customer/indexnow/check/route.ts",
    auth: "workspace",
    request: checkIndexNowRequest,
    response: checkIndexNowResponse,
    errorCodes: [
      "feature_unavailable",
      "invalid_request",
      "invalid_json",
      "cross_site",
      "indexnow_not_set_up",
      "indexnow_rate_limited",
      "unauthenticated",
      "membership_unavailable",
      "workspace_not_found",
      "indexnow_unavailable",
    ],
    examples: [
      {
        response: {
          hosts: [
            { host: "offcult.in", status: "missing" },
            { host: "www.offcult.in", status: "missing" },
          ],
          checkedAt: "2026-10-22T09:00:00.000Z",
          cached: false,
        },
      },
    ],
  }),
  defineRouteContract({
    id: "customer.indexnow.submit.post",
    method: "POST",
    path: "/api/customer/indexnow/submit",
    file: "src/app/api/customer/indexnow/submit/route.ts",
    auth: "workspace",
    request: submitIndexNowRequest,
    response: submitIndexNowResponse,
    errorCodes: [
      "feature_unavailable",
      "invalid_request",
      "invalid_json",
      "cross_site",
      "indexnow_rate_limited",
      "unauthenticated",
      "membership_unavailable",
      "workspace_not_found",
      "indexnow_unavailable",
    ],
    examples: [
      {
        response: {
          key: "3f2a9c1e5b7d4f60a8c2e1b3d5f7a9c1",
          keyCreated: false,
          hosts: [
            {
              host: "offcult.in",
              urlCount: 1,
              status: "submitted",
              engine: "bing",
              httpStatus: 202,
              reason: null,
              message:
                "Submitted 1 URL. Search engines will verify the key file on https://offcult.in first.",
            },
          ],
          skipped: [{ url: "https://other.com/x", reason: "off_site" }],
        },
      },
    ],
  }),
  defineRouteContract({
    id: "customer.indexnow.submissions.get",
    method: "GET",
    path: "/api/customer/indexnow/submissions",
    file: "src/app/api/customer/indexnow/submissions/route.ts",
    auth: "workspace",
    query: submissionsQuery,
    response: submissionsResponse,
    errorCodes: [
      "feature_unavailable",
      "invalid_request",
      "unauthenticated",
      "membership_unavailable",
      "workspace_not_found",
      "indexnow_unavailable",
    ],
    examples: [
      {
        response: {
          submissions: [
            {
              id: "7f8c1e2d-3a4b-5c6d-7e8f-9a0b1c2d3e4f",
              createdAt: "2026-10-22T09:00:00.000Z",
              source: "content",
              sourceRef: "8c1d2e3f",
              host: "offcult.in",
              urlCount: 1,
              urls: ["https://offcult.in/blog/oversized-guide"],
              status: "submitted",
              engine: "bing",
              httpStatus: 202,
              message:
                "Submitted 1 URL. Search engines will verify the key file on https://offcult.in first.",
            },
          ],
        },
      },
    ],
  }),
];
