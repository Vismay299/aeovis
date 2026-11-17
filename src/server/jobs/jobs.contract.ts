import { z } from "zod";
import { defineRouteContract } from "../../shared/http/routeContract.ts";

export const JOB_STATUSES = ["queued", "running", "completed", "partial", "failed", "cancelled"] as const;
export const JOB_TRIGGERS = ["manual", "scheduled", "baseline", "system"] as const;
export const CANCEL_STATUSES = ["cancelled", "cancel_requested", "completed", "partial", "failed"] as const;

export const jobProgressSchema = z.looseObject({
  done: z.int().min(0),
  total: z.int().min(0),
  label: z.string().optional(),
});

export const jobErrorSchema = z.looseObject({ code: z.string(), message: z.string() });

export const jobStatusQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

export const jobIdParams = z.strictObject({ jobId: z.uuid() });

/** §6.5: identity fields composed by the route, then `getJobStatus()`'s own shape. */
export const jobStatusResponse = z.looseObject({
  jobId: z.uuid(),
  kind: z.string(),
  trigger: z.enum(JOB_TRIGGERS),
  status: z.enum(JOB_STATUSES),
  progress: jobProgressSchema.nullable(),
  pollAfterSeconds: z.int().min(5).max(60).nullable(),
  result: z.unknown().nullable(),
  error: jobErrorSchema.nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});

export const jobCancelBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

export const jobCancelResponse = z.looseObject({
  jobId: z.uuid(),
  status: z.enum(CANCEL_STATUSES),
});

export const tickQuery = z.strictObject({ job_id: z.uuid().optional() });

export const tickAcceptedResponse = z.looseObject({ accepted: z.literal(true) });
export const tickDisabledResponse = z.looseObject({ skipped: z.literal("disabled") });
export const tickUnauthorizedResponse = z.looseObject({
  error: z.string(),
  code: z.literal("unauthorized"),
});

export const tickResponse = z.union([
  tickAcceptedResponse,
  tickDisabledResponse,
  tickUnauthorizedResponse,
]);

export const jobsListQuery = z.strictObject({
  status: z.enum(JOB_STATUSES).optional(),
  kind: z.string().min(1).max(200).optional(),
  brand_key: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const jobsListItemSchema = z.looseObject({
  jobId: z.uuid(),
  kind: z.string(),
  brandKey: z.string().nullable(),
  trigger: z.enum(JOB_TRIGGERS),
  status: z.enum(JOB_STATUSES),
  progress: jobProgressSchema.nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  payloadKeys: z.array(z.string()),
});

export const jobsListResponse = z.looseObject({ jobs: z.array(jobsListItemSchema) });

const EXAMPLE_JOB_ID = "5b0d6f6e-9a8b-4a45-9a51-0e7e8f1c2d3a";

export const contracts = [
  defineRouteContract({
    id: "jobs.tick.get",
    method: "GET",
    path: "/api/jobs/tick",
    file: "src/app/api/jobs/tick/route.ts",
    auth: "cron",
    query: tickQuery,
    response: tickResponse,
    errorCodes: ["invalid_request", "unauthorized"],
    examples: [
      { response: { accepted: true } },
      { response: { skipped: "disabled" } },
      { response: { error: "Unauthorized", code: "unauthorized" } },
    ],
  }),
  defineRouteContract({
    id: "jobs.tick.post",
    method: "POST",
    path: "/api/jobs/tick",
    file: "src/app/api/jobs/tick/route.ts",
    auth: "cron",
    query: tickQuery,
    response: tickResponse,
    errorCodes: ["invalid_request", "unauthorized"],
    examples: [
      { response: { accepted: true } },
      { response: { skipped: "disabled" } },
      { response: { error: "Unauthorized", code: "unauthorized" } },
    ],
  }),
  defineRouteContract({
    id: "customer.jobs.status",
    method: "GET",
    path: "/api/customer/jobs/[jobId]",
    file: "src/app/api/customer/jobs/[jobId]/route.ts",
    auth: "workspace",
    query: jobStatusQuery,
    response: jobStatusResponse,
    errorCodes: ["invalid_request", "unauthenticated", "workspace_not_found", "job_not_found", "storage_unavailable"],
    examples: [
      {
        response: {
          jobId: EXAMPLE_JOB_ID,
          kind: "keywords.research",
          trigger: "manual",
          status: "running",
          progress: { done: 3, total: 10, label: "Fetching keyword ideas" },
          pollAfterSeconds: 5,
          result: null,
          error: null,
          createdAt: "2026-10-21T09:00:00.000Z",
          finishedAt: null,
        },
      },
    ],
  }),
  defineRouteContract({
    id: "customer.jobs.cancel",
    method: "POST",
    path: "/api/customer/jobs/[jobId]/cancel",
    file: "src/app/api/customer/jobs/[jobId]/cancel/route.ts",
    auth: "workspace",
    request: jobCancelBody,
    response: jobCancelResponse,
    errorCodes: [
      "invalid_request",
      "invalid_json",
      "unauthenticated",
      "cross_site",
      "workspace_not_found",
      "job_not_found",
      "storage_unavailable",
    ],
    examples: [{ response: { jobId: EXAMPLE_JOB_ID, status: "cancel_requested" } }],
  }),
  defineRouteContract({
    id: "ops.jobs.list",
    method: "GET",
    path: "/api/ops/jobs",
    file: "src/app/api/ops/jobs/route.ts",
    auth: "operator",
    query: jobsListQuery,
    response: jobsListResponse,
    errorCodes: ["invalid_request", "storage_unavailable"],
    examples: [
      {
        response: {
          jobs: [
            {
              jobId: EXAMPLE_JOB_ID,
              kind: "jobs.retention",
              brandKey: null,
              trigger: "system",
              status: "running",
              progress: null,
              createdAt: "2026-10-21T09:00:00.000Z",
              finishedAt: null,
              payloadKeys: [],
            },
          ],
        },
      },
    ],
  }),
];
