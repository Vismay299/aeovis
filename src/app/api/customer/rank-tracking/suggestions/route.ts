import { AppError } from "../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import { requireWorkspace } from "../../../../../lib/workspace/requireWorkspace.ts";
import { z } from "zod";

export const dynamic = "force-dynamic";

const schema = z.strictObject({ brand_key: z.string().optional(), domain: z.string().trim().min(1).max(253), locationCode: z.number().int().positive(), languageCode: z.string().min(2).max(8).optional(), cacheOnly: z.boolean().default(false), maxUsd: z.number().positive().max(1000).optional(), requestId: z.string().uuid() });

export async function POST(request: Request, deps?: any): Promise<Response> {
  try {
    const raw = await request.json().catch(() => ({}));
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, "invalid_request", "Check request fields and try again.");
    const input = parsed.data;
    const ws = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey: input.brand_key }, deps as any);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("rank_tracking", ws.brandKey))) throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    if (input.cacheOnly) {
      return Response.json({ keywords: null }, { headers: { "cache-control": "no-store" } });
    }
    return Response.json({ keywords: [], cached: false, fetchedAt: new Date().toISOString() }, { headers: { "cache-control": "no-store" } });
  } catch (err) { return toErrorResponse(err); }
}

