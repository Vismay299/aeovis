import { AppError } from "../../../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../../lib/features/flags.ts";
import { requireWorkspace } from "../../../../../../../lib/workspace/requireWorkspace.ts";
import { z } from "zod";
import { beginRankCheckRun } from "../../../../../../../lib/rank-tracking/runGuards.ts";
import { createRankTrackingRepository } from "../../../../../../../lib/rank-tracking/repository.ts";
import { assertTrackedLocation } from "../../../../../../../lib/rank-tracking/market.ts";
import { quote as quoteAction, requireApprovedPrice } from "../../../../../../../lib/pricing/pricedActions.ts";
import "../../../../../../../lib/pricing/actions/index.ts";

export const dynamic = "force-dynamic";

const schema = z.strictObject({ brand_key: z.string().optional(), keywordIds: z.array(z.string().uuid()).min(1).max(1000).optional(), maxUsd: z.number().positive().max(1000).optional() });

function parseId(raw: string) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist."); return raw; }

export type CheckRouteDeps = {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  repo?: any;
  quote?: typeof quoteAction;
  requireApprovedPrice?: typeof requireApprovedPrice;
  beginRankCheckRun?: typeof beginRankCheckRun;
  assertTrackedLocation?: typeof assertTrackedLocation;
};

export async function POST(request: Request, ctx: { params: Promise<{ configId: string }> | { configId: string } }, deps?: CheckRouteDeps): Promise<Response> {
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
    const repo = deps?.repo ?? createRankTrackingRepository(ws.admin);
    const config = await repo.getConfig(ws.brandKey, configId);
    if (!config) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");
    if ((config as any).is_active === false) throw new AppError(409, "tracker_archived", "This domain was archived.");
    if ((config as any).location_name) {
      await (deps?.assertTrackedLocation ?? assertTrackedLocation)((config as any).location_code, (config as any).location_name);
    }
    const keywords = await repo.listKeywords(ws.brandKey, configId);
    const chosen = input.keywordIds ? keywords.filter((k: any) => input.keywordIds!.includes(k.id)) : keywords;
    if (chosen.length === 0) throw new AppError(409, "no_keywords", "Add keywords before checking rankings.");
    const q = await (deps?.quote ?? quoteAction)("rank_tracking.check.run", { brandKey: ws.brandKey, admin: ws.admin } as any, {
      configId,
      keywordIds: input.keywordIds,
      method: "live",
    } as any);
    const approved = await (deps?.requireApprovedPrice ?? requireApprovedPrice)("rank_tracking.check.run", { brandKey: ws.brandKey, admin: ws.admin } as any, {
      configId,
      keywordIds: input.keywordIds,
      method: "live",
    } as any, input.maxUsd);
    const res = await (deps?.beginRankCheckRun ?? beginRankCheckRun)(ws as any, { configId, trigger: "manual", keywordIds: input.keywordIds, approvedMaxUsd: approved.approvedMaxUsd }, { admin: ws.admin, repo });
    if (!res.ok) {
      throw new AppError(409, "rank_check_running", "A check is already running.", { details: { activeRunId: res.activeRunId } });
    }
    return Response.json({ runId: res.runId, jobId: res.jobId, status: "queued", pollAfterSeconds: 3 }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (err) { return toErrorResponse(err); }
}
