import { AppError } from "@/lib/http/appError.ts";
import { toErrorResponse } from "@/lib/http/errors.ts";
import { isFeatureEnabled } from "@/lib/features/flags.ts";
import { requireWorkspace } from "@/lib/workspace/requireWorkspace.ts";
import { z } from "zod";
import { getTracker, updateConfig } from "@/lib/rank-tracking/service.ts";

export const dynamic = "force-dynamic";

const updateSchema = z.strictObject({
  brand_key: z.string().optional(),
  domain: z.string().trim().min(3).max(253).optional(),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(10).optional(),
  locationName: z.string().min(1).max(200).nullable().optional(),
  devices: z.enum(["both", "desktop", "mobile"]).optional(),
  serpDepth: z.number().int().min(10).max(100).refine((v) => v % 10 === 0).optional(),
  scheduleInterval: z.enum(["daily", "weekly", "monthly", "manual"]).optional(),
  isActive: z.boolean().optional(),
  maxUsd: z.number().positive().max(1000).optional(),
});

function parseConfigId(raw: string): string {
  // validate uuid
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) {
    throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");
  }
  return raw;
}

export async function GET(request: Request, ctx: { params: { configId: string } }): Promise<Response> {
  try {
    const url = new URL(request.url);
    const brandKey = url.searchParams.get("brand_key") ?? undefined;
    const ws = await requireWorkspace(request, { brandKey });
    if (!(await isFeatureEnabled("rank_tracking", ws.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    const configId = parseConfigId(ctx.params.configId);
    const tracker = await getTracker(ws as any, configId);
    return Response.json(tracker, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, ctx: { params: { configId: string } }): Promise<Response> {
  try {
    const raw = await request.json().catch(() => ({}));
    const parsed = updateSchema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, "invalid_request", "Check request fields and try again.");
    const input = parsed.data;
    const ws = await requireWorkspace(request, { brandKey: input.brand_key });
    if (!(await isFeatureEnabled("rank_tracking", ws.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    const configId = parseConfigId(ctx.params.configId);
    const tracker = await updateConfig(ws as any, configId, input);
    return Response.json(tracker, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
