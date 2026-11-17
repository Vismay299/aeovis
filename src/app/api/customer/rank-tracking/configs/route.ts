import { AppError } from "../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../server/features/flags.ts";
import { requireWorkspace } from "../../../../../server/workspace/requireWorkspace.ts";
import { z } from "zod";
import { createConfig, listTrackers } from "../../../../../shared/rank-tracking/service.ts";

export const dynamic = "force-dynamic";

const scheduleTimeSchema = z.strictObject({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  weekday: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
}).passthrough();

const createSchema = z.strictObject({
  brand_key: z.string().optional(),
  domain: z.string().trim().min(3).max(253),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(10).optional(),
  locationName: z.string().trim().min(1).max(200).optional(),
  devices: z.enum(["both", "desktop", "mobile"]).default("mobile"),
  serpDepth: z.number().int().min(10).max(100).refine((v) => v % 10 === 0).default(40),
  scheduleInterval: z.enum(["daily", "weekly", "monthly", "manual"]).default("weekly"),
  scheduleTime: scheduleTimeSchema.optional(),
});

export type ConfigsRouteDeps = {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  createConfig?: typeof createConfig;
  listTrackers?: typeof listTrackers;
};

export async function GET(request: Request, _ctx?: unknown, deps?: ConfigsRouteDeps): Promise<Response> {
  try {
    const url = new URL(request.url);
    const brandKey = url.searchParams.get("brand_key") ?? undefined;
    const ws = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey }, deps as any);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("rank_tracking", ws.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    const trackers = await (deps?.listTrackers ?? listTrackers)(ws as any);
    return Response.json({ trackers }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, _ctx?: unknown, deps?: ConfigsRouteDeps): Promise<Response> {
  try {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new AppError(400, "invalid_json", "Invalid JSON request body.");
    }
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, "invalid_request", "Check request fields and try again.");
    const input = parsed.data;
    const ws = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey: input.brand_key }, deps as any);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("rank_tracking", ws.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    const tracker = await (deps?.createConfig ?? createConfig)(ws as any, input);
    return Response.json(tracker, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
