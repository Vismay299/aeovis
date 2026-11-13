import { AppError } from "@/lib/http/appError.ts";
import { toErrorResponse } from "@/lib/http/errors.ts";
import { isFeatureEnabled } from "@/lib/features/flags.ts";
import { requireWorkspace } from "@/lib/workspace/requireWorkspace.ts";
import { z } from "zod";
import { setKeywordsPinned } from "@/lib/rank-tracking/service.ts";

export const dynamic = "force-dynamic";

const schema = z.strictObject({ brand_key: z.string().optional(), keywordIds: z.array(z.string().uuid()).min(1).max(1000), pinned: z.boolean() });

function parseId(raw: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist."); return raw; }

export async function POST(request: Request, ctx: { params: { configId: string } }): Promise<Response> {
  try {
    const raw = await request.json().catch(() => ({}));
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, "invalid_request", "Check request fields and try again.");
    const input = parsed.data;
    const ws = await requireWorkspace(request, { brandKey: input.brand_key });
    if (!(await isFeatureEnabled("rank_tracking", ws.brandKey))) throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    const configId = parseId(ctx.params.configId);
    const out = await setKeywordsPinned(ws as any, configId, input.keywordIds, input.pinned);
    return Response.json(out, { headers: { "cache-control": "no-store" } });
  } catch (err) { return toErrorResponse(err); }
}
