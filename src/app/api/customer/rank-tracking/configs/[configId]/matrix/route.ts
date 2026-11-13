import { AppError } from "@/lib/http/appError.ts";
import { toErrorResponse } from "@/lib/http/errors.ts";
import { isFeatureEnabled } from "@/lib/features/flags.ts";
import { requireWorkspace } from "@/lib/workspace/requireWorkspace.ts";
import { getPositionMatrix } from "@/lib/rank-tracking/results.ts";

export const dynamic = "force-dynamic";

function parseId(raw: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist."); return raw; }

export async function GET(request: Request, ctx: { params: { configId: string } }): Promise<Response> {
  try {
    const url = new URL(request.url);
    const device = (url.searchParams.get("device") ?? "mobile") as "desktop" | "mobile";
    const runLimit = Number(url.searchParams.get("runLimit") ?? 12);
    const brandKey = url.searchParams.get("brand_key") ?? undefined;
    const ws = await requireWorkspace(request, { brandKey });
    if (!(await isFeatureEnabled("rank_tracking", ws.brandKey))) throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    const configId = parseId(ctx.params.configId);
    const out = await getPositionMatrix(ws as any, configId, device, runLimit, { admin: ws.admin });
    return Response.json({ cells: out }, { headers: { "cache-control": "no-store" } });
  } catch (err) { return toErrorResponse(err); }
}
