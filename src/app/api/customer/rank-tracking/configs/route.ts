import { AppError } from "@/lib/http/appError.ts";
import { toErrorResponse } from "@/lib/http/errors.ts";
import { isFeatureEnabled } from "@/lib/features/flags.ts";
import { requireWorkspace } from "@/lib/workspace/requireWorkspace.ts";
import { z } from "zod";
import { createConfig, listTrackers } from "@/lib/rank-tracking/service.ts";
import { assertTrackedLocation } from "@/lib/rank-tracking/market.ts";

export const dynamic = "force-dynamic";

const createSchema = z.strictObject({
  brand_key: z.string().optional(),
  domain: z.string().trim().min(3).max(253),
  locationCode: z.number().int().positive().optional(),
  languageCode: z.string().min(2).max(10).optional(),
  locationName: z.string().trim().min(1).max(200).optional(),
  devices: z.enum(["both", "desktop", "mobile"]).default("mobile"),
  serpDepth: z.number().int().min(10).max(100).refine((v) => v % 10 === 0).default(40),
  scheduleInterval: z.enum(["daily", "weekly", "monthly", "manual"]).default("weekly"),
});

export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const brandKey = url.searchParams.get("brand_key") ?? undefined;
    const ws = await requireWorkspace(request, { brandKey });
    if (!(await isFeatureEnabled("rank_tracking", ws.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    const trackers = await listTrackers(ws as any);
    return Response.json({ trackers }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const raw = await request.json().catch(() => ({}));
    const parsed = createSchema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, "invalid_request", "Check request fields and try again.");
    const input = parsed.data;
    const ws = await requireWorkspace(request, { brandKey: input.brand_key });
    if (!(await isFeatureEnabled("rank_tracking", ws.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    const tracker = await createConfig(ws as any, input);
    return Response.json(tracker, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}

