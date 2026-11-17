import { AppError } from "../../../../../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../../../../server/features/flags.ts";
import { requireWorkspace } from "../../../../../../../../../server/workspace/requireWorkspace.ts";
import { getKeywordHistory } from "../../../../../../../../../shared/rank-tracking/results.ts";

import { z } from "zod";

export const dynamic = "force-dynamic";

// Mirrors the query schema in rankTracking.contract.ts.
const querySchema = z.strictObject({ brand_key: z.string().optional(), sinceDays: z.coerce.number().int().positive().max(730).default(90) });

function parseId(raw: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist."); return raw; }

function parseKeywordId(raw: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) throw new AppError(404, "keyword_not_found", "This keyword is not tracked."); return raw; }

export async function GET(request: Request, ctx: { params: Promise<{ configId: string; keywordId: string }> | { configId: string; keywordId: string } }, deps?: any): Promise<Response> {
  try {
    const url = new URL(request.url);
    const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
    if (!parsed.success) throw new AppError(400, "invalid_request", "Check request fields and try again.");
    const { sinceDays, brand_key: brandKey } = parsed.data;
    const ws = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey }, deps as any);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("rank_tracking", ws.brandKey))) throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    const configId = parseId((await ctx.params).configId);
    const out = await getKeywordHistory(ws as any, configId, parseKeywordId((await ctx.params).keywordId), sinceDays, { admin: ws.admin });
    return Response.json({ points: out }, { headers: { "cache-control": "no-store" } });
  } catch (err) { return toErrorResponse(err); }
}
