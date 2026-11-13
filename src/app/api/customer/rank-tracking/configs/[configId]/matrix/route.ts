import { AppError } from "../../../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../../lib/features/flags.ts";
import { requireWorkspace } from "../../../../../../../lib/workspace/requireWorkspace.ts";
import { getPositionMatrix } from "../../../../../../../lib/rank-tracking/results.ts";

import { z } from "zod";

export const dynamic = "force-dynamic";

// Mirrors the query schema in rankTracking.contract.ts.
const querySchema = z.strictObject({ brand_key: z.string().optional(), device: z.enum(["desktop", "mobile"]).default("mobile"), runLimit: z.coerce.number().int().min(2).max(26).default(12) });

function parseId(raw: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist."); return raw; }

export async function GET(request: Request, ctx: { params: Promise<{ configId: string }> | { configId: string } }, deps?: any): Promise<Response> {
  try {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new AppError(400, "invalid_request", "Check request fields and try again.");
    const { device, runLimit, brand_key: brandKey } = parsed.data;
    const ws = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey }, deps as any);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("rank_tracking", ws.brandKey))) throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    const configId = parseId((await ctx.params).configId);
    const out = await getPositionMatrix(ws as any, configId, device, runLimit, { admin: ws.admin });
    return Response.json({ cells: out }, { headers: { "cache-control": "no-store" } });
  } catch (err) { return toErrorResponse(err); }
}
