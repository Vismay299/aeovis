import { z } from "zod";
import { defineRouteContract, type RouteContract } from "../../shared/http/routeContract.ts";
import { SCHEDULE_INTERVALS, scheduleTimeSchema } from "../../shared/schedule.ts";

export const getScheduleQuery = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
});

export const saveScheduleBody = z.strictObject({
  brand_key: z.string().min(1).max(200).optional(),
  enabled: z.boolean(),
  interval: z.enum(SCHEDULE_INTERVALS).optional(),
  scheduleTime: scheduleTimeSchema.optional(),
  maxUsd: z.number().positive().max(1000).optional(),
});

export const customerScheduleTimeResponse = z.looseObject({
  weekday: z.number().int().min(0).max(6).optional(),
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  timeZone: z.string().optional(),
});

export const customerScheduleWindowSchema = z.looseObject({
  windowAt: z.string(),
  disposition: z.string(),
  reason: z.string().nullable(),
  message: z.string().nullable(),
  jobId: z.string().uuid().nullable().optional(),
});

export const customerScheduleViewSchema = z.looseObject({
  brandKey: z.string(),
  status: z.enum(["off", "on", "paused", "operator"]),
  interval: z.enum(SCHEDULE_INTERVALS).nullable(),
  scheduleTime: customerScheduleTimeResponse.nullable().optional(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  lastCompletedAt: z.string().nullable(),
  lastSkip: z
    .looseObject({
      reason: z.string(),
      at: z.string(),
      message: z.string(),
    })
    .nullable(),
  approvedMaxUsd: z.number().nullable(),
  approvedAt: z.string().nullable(),
  windows: z.array(customerScheduleWindowSchema),
});

export type CustomerScheduleView = z.infer<typeof customerScheduleViewSchema>;
export type CustomerScheduleWindow = z.infer<typeof customerScheduleWindowSchema>;

const exampleSchedule = {
  brandKey: "offcult.in",
  status: "on" as const,
  interval: "weekly" as const,
  scheduleTime: { weekday: 1, hour: 9, minute: 0, timeZone: "Asia/Kolkata" },
  nextRunAt: "2026-10-27T03:30:00.000Z",
  lastRunAt: "2026-10-20T03:31:12.000Z",
  lastCompletedAt: "2026-10-20T03:58:40.000Z",
  lastSkip: {
    reason: "price_changed",
    at: "2026-10-13T03:30:40.000Z",
    message: "The scan now costs more than you approved. Review the new price to resume.",
  },
  approvedMaxUsd: 24,
  approvedAt: "2026-10-06T10:02:00.000Z",
  windows: [
    {
      windowAt: "2026-10-20T03:30:00.000Z",
      disposition: "finalized",
      reason: null,
      message: null,
      jobId: "0c2a4b1e-8d1f-4f35-9b5e-2e0c6f1a7d90",
    },
    {
      windowAt: "2026-10-13T03:30:00.000Z",
      disposition: "blocked",
      reason: "price_changed",
      message: "The scan now costs more than you approved. Review the new price to resume.",
      jobId: null,
    },
  ],
};

export const getScheduleRouteContract = defineRouteContract({
  id: "customer.schedule.get",
  method: "GET",
  path: "/api/customer/schedule",
  file: "src/app/api/customer/schedule/route.ts",
  auth: "workspace",
  query: getScheduleQuery,
  response: customerScheduleViewSchema,
  errorCodes: [
    "invalid_request",
    "feature_unavailable",
    "unauthenticated",
    "auth_not_configured",
    "cross_site",
    "membership_unavailable",
    "workspace_not_found",
    "storage_unavailable",
  ],
  examples: [{ response: exampleSchedule }],
});

export const saveScheduleRouteContract = defineRouteContract({
  id: "customer.schedule.put",
  method: "PUT",
  path: "/api/customer/schedule",
  file: "src/app/api/customer/schedule/route.ts",
  auth: "workspace",
  request: saveScheduleBody,
  response: customerScheduleViewSchema,
  errorCodes: [
    "invalid_request",
    "invalid_json",
    "feature_unavailable",
    "owner_required",
    "approval_required",
    "price_changed",
    "panel_not_approved",
    "no_engines",
    "over_scan_limit",
    "operator_schedule_active",
    "schedule_unavailable",
    "unauthenticated",
    "auth_not_configured",
    "cross_site",
    "membership_unavailable",
    "workspace_not_found",
    "storage_unavailable",
  ],
  examples: [{ response: exampleSchedule }],
});

export const contracts: RouteContract[] = [
  getScheduleRouteContract,
  saveScheduleRouteContract,
];
