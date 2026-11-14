import { AppError } from "../../../../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../../../lib/features/flags.ts";
import { requireWorkspace } from "../../../../../../../../lib/workspace/requireWorkspace.ts";
import { z } from "zod";
import { refreshKeywordMetrics } from "../../../../../../../../lib/rank-tracking/metrics.ts";
import { createRankTrackingRepository } from "../../../../../../../../lib/rank-tracking/repository.ts";
import { requireApprovedPrice } from "../../../../../../../../lib/pricing/pricedActions.ts";
import { toResearchError } from "../../../../../../../../lib/research/providerErrors.ts";
import "../../../../../../../../lib/pricing/actions/index.ts";

export const dynamic = "force-dynamic";

const schema = z.strictObject({
  brand_key: z.string().optional(),
  maxUsd: z.number().positive().max(1000).optional(),
  requestId: z.string().uuid(),
});

function parseId(raw: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist."); return raw; }

export type MetricsRefreshRouteDeps = {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  repo?: any;
  requireApprovedPrice?: typeof requireApprovedPrice;
  refreshKeywordMetrics?: typeof refreshKeywordMetrics;
};

export async function POST(request: Request, ctx: { params: Promise<{ configId: string }> | { configId: string } }, deps?: MetricsRefreshRouteDeps): Promise<Response> {
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
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("rank_tracking", ws.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    const configId = parseId((await ctx.params).configId);
    const repo = deps?.repo ?? createRankTrackingRepository(ws.admin);
    const config = await repo.getConfig(ws.brandKey, configId);
    if (!config) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");
    const pricingCtx = { brandKey: ws.brandKey, admin: ws.admin, env: process.env, now: new Date() };
    const approved = await (deps?.requireApprovedPrice ?? requireApprovedPrice)(
      "rank_tracking.metrics.run",
      pricingCtx as any,
      { configId },
      input.maxUsd,
    );
    const out = await (deps?.refreshKeywordMetrics ?? refreshKeywordMetrics)(
      ws as any,
      configId,
      { maxUsd: approved.approvedMaxUsd, requestId: input.requestId },
      { repo },
    );
    return Response.json(out, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return toErrorResponse(
      toResearchError(err, {
        unavailableCode: "rank_metrics_unavailable",
        unavailableMessage: "Keyword stats could not be loaded. Please retry.",
      }),
    );
  }
}
