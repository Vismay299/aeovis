import { AppError } from "../../../../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../../../server/features/flags.ts";
import { requireWorkspace } from "../../../../../../../../server/workspace/requireWorkspace.ts";
import { z } from "zod";
import { setKeywordsPinned } from "../../../../../../../../shared/rank-tracking/service.ts";

export const dynamic = "force-dynamic";

const schema = z.strictObject({ brand_key: z.string().optional(), keywordIds: z.array(z.string().uuid()).min(1).max(1000), pinned: z.boolean() });

function parseId(raw: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist."); return raw; }

export async function POST(request: Request, ctx: { params: Promise<{ configId: string }> | { configId: string } }, deps?: any): Promise<Response> {
  try {
    const raw = await request.json().catch(() => ({}));
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, "invalid_request", "Check request fields and try again.");
    const input = parsed.data;
    const ws = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey: input.brand_key }, deps as any);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("rank_tracking", ws.brandKey))) throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    const configId = parseId((await ctx.params).configId);
    const out = await setKeywordsPinned(ws as any, configId, input.keywordIds, input.pinned);
    return Response.json(out, { headers: { "cache-control": "no-store" } });
  } catch (err) { return toErrorResponse(err); }
}
