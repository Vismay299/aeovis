import { AppError } from "../../../../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../../../server/features/flags.ts";
import { requireWorkspace } from "../../../../../../../../server/workspace/requireWorkspace.ts";
import { getLatestRunView } from "../../../../../../../../shared/rank-tracking/runGuards.ts";

export const dynamic = "force-dynamic";

function parseId(raw: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist."); return raw; }

export async function GET(request: Request, ctx: { params: Promise<{ configId: string }> | { configId: string } }, deps?: any): Promise<Response> {
  try {
    const url = new URL(request.url);
    const brandKey = url.searchParams.get("brand_key") ?? undefined;
    const ws = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey }, deps as any);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("rank_tracking", ws.brandKey))) throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    const configId = parseId((await ctx.params).configId);
    const run = await getLatestRunView(ws.brandKey, configId, { admin: ws.admin });
    return Response.json({ run }, { headers: { "cache-control": "no-store" } });
  } catch (err) { return toErrorResponse(err); }
}
