import { AppError } from "../../../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../../server/features/flags.ts";
import { requireWorkspace } from "../../../../../../../server/workspace/requireWorkspace.ts";
import { z } from "zod";
import { getLatestResults } from "../../../../../../../shared/rank-tracking/results.ts";

export const dynamic = "force-dynamic";

const querySchema = z.strictObject({ compare: z.enum(["1d", "7d", "30d", "90d"]).optional(), brand_key: z.string().optional() });

function parseId(raw: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist."); return raw; }

export async function GET(request: Request, ctx: { params: Promise<{ configId: string }> | { configId: string } }, deps?: any): Promise<Response> {
  try {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse({ compare: url.searchParams.get("compare") ?? undefined, brand_key: url.searchParams.get("brand_key") ?? undefined });
    if (!parsed.success) throw new AppError(400, "invalid_request", "Check request fields and try again.");
    const ws = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey: parsed.data.brand_key }, deps as any);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("rank_tracking", ws.brandKey))) throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    const configId = parseId((await ctx.params).configId);
    const out = await getLatestResults(ws as any, configId, parsed.data.compare ?? "7d", { admin: ws.admin });
    return Response.json(out, { headers: { "cache-control": "no-store" } });
  } catch (err) { return toErrorResponse(err); }
}
