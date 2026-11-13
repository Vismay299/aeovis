import { AppError } from "../../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../lib/features/flags.ts";
import { requireWorkspace } from "../../../../../../lib/workspace/requireWorkspace.ts";
import { z } from "zod";
import { getTracker, updateConfig } from "../../../../../../lib/rank-tracking/service.ts";

export const dynamic = "force-dynamic";

const scheduleTimeSchema = z.strictObject({
  hour: z.number().int().min(0).max(23),
  minute: z.number().int().min(0).max(59),
  weekday: z.number().int().min(0).max(6).optional(),
  dayOfMonth: z.number().int().min(1).max(31).optional(),
}).passthrough();

const updateSchema = z.strictObject({
  brand_key: z.string().optional(),
  domain: z.string().trim().min(3).max(253).optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(10).optional(),
  locationName: z.string().min(1).max(200).nullable().optional(),
  devices: z.enum(["both", "desktop", "mobile"]).optional(),
  serpDepth: z.number().int().min(10).max(100).refine((v) => v % 10 === 0).optional(),
  scheduleInterval: z.enum(["daily", "weekly", "monthly", "manual"]).optional(),
  scheduleTime: scheduleTimeSchema.optional(),
  isActive: z.boolean().optional(),
  maxUsd: z.number().positive().max(1000).optional(),
});

function parseConfigId(raw: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");
  }
  return raw;
}

export type ConfigRouteDeps = {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  getTracker?: typeof getTracker;
  updateConfig?: typeof updateConfig;
};

export async function GET(request: Request, ctx: { params: { configId: string } }, deps?: ConfigRouteDeps): Promise<Response> {
  try {
    const url = new URL(request.url);
    const brandKey = url.searchParams.get("brand_key") ?? undefined;
    const ws = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey }, deps as any);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("rank_tracking", ws.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    const configId = parseConfigId(ctx.params.configId);
    const tracker = await (deps?.getTracker ?? getTracker)(ws as any, configId);
    return Response.json(tracker, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, ctx: { params: { configId: string } }, deps?: ConfigRouteDeps): Promise<Response> {
  try {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new AppError(400, "invalid_json", "Invalid JSON request body.");
    }
    const parsed = updateSchema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, "invalid_request", "Check request fields and try again.");
    const input = parsed.data;
    const ws = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey: input.brand_key }, deps as any);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("rank_tracking", ws.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    const configId = parseConfigId(ctx.params.configId);
    const tracker = await (deps?.updateConfig ?? updateConfig)(ws as any, configId, input);
    return Response.json(tracker, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
