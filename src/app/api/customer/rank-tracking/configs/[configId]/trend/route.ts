import { AppError } from "../../../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../../lib/features/flags.ts";
import { requireWorkspace } from "../../../../../../../lib/workspace/requireWorkspace.ts";
import { z } from "zod";
import { getConfigTrend } from "../../../../../../../lib/rank-tracking/results.ts";

export const dynamic = "force-dynamic";

function parseId(raw: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist."); return raw; }

export async function GET(request: Request, ctx: { params: { configId: string } }, deps?: any): Promise<Response> {
  try {
    const url = new URL(request.url);
    const device = (url.searchParams.get("device") ?? "mobile") as "desktop" | "mobile";
    const sinceDays = Number(url.searchParams.get("sinceDays") ?? 730);
    const brandKey = url.searchParams.get("brand_key") ?? undefined;
    const ws = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey }, deps as any);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("rank_tracking", ws.brandKey))) throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    const configId = parseId(ctx.params.configId);
    const out = await getConfigTrend(ws as any, configId, device, sinceDays, { admin: ws.admin });
    return Response.json({ points: out }, { headers: { "cache-control": "no-store" } });
  } catch (err) { return toErrorResponse(err); }
}
