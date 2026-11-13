import { AppError } from "../../../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../../lib/features/flags.ts";
import { requireWorkspace } from "../../../../../../../lib/workspace/requireWorkspace.ts";
import { z } from "zod";
import { addKeywords } from "../../../../../../../lib/rank-tracking/service.ts";

export const dynamic = "force-dynamic";

const schema = z.strictObject({
  brand_key: z.string().optional(),
  keywords: z.array(z.string().trim().min(1).max(200)).min(1).max(1000),
  matchCase: z.boolean().default(false),
  source: z.enum(["manual", "suggestions"]).default("manual"),
  maxUsd: z.number().positive().max(1000).optional(),
});

function parseId(raw: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");
  return raw;
}

export type AddKeywordsDeps = {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  addKeywords?: typeof addKeywords;
};

export async function POST(request: Request, ctx: { params: Promise<{ configId: string }> | { configId: string } }, deps?: AddKeywordsDeps): Promise<Response> {
  try {
    let raw: unknown;
    try {
      raw = await request.json();
    } catch {
      throw new AppError(400, "invalid_json", "Invalid JSON request body.");
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) throw new AppError(400, "invalid_request", "Check request fields and try again.");
    const input = parsed.data;
    const ws = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey: input.brand_key }, deps as any);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("rank_tracking", ws.brandKey))) throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    const configId = parseId((await ctx.params).configId);
    const out = await (deps?.addKeywords ?? addKeywords)(ws as any, configId, { keywords: input.keywords, matchCase: input.matchCase, source: input.source, maxUsd: input.maxUsd });
    return Response.json(out, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
