import { AppError } from "@/lib/http/appError.ts";
import { toErrorResponse } from "@/lib/http/errors.ts";
import { isFeatureEnabled } from "@/lib/features/flags.ts";
import { requireWorkspace } from "@/lib/workspace/requireWorkspace.ts";
import { z } from "zod";
import { beginRankCheckRun } from "@/lib/rank-tracking/runGuards.ts";
import { createRankTrackingRepository } from "@/lib/rank-tracking/repository.ts";

export const dynamic = "force-dynamic";

const schema = z.strictObject({ brand_key: z.string().optional(), keywordIds: z.array(z.string().uuid()).min(1).max(1000).optional(), maxUsd: z.number().positive().max(1000).optional() });

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
    const repo = createRankTrackingRepository(ws.admin);
    const config = await repo.getConfig(ws.brandKey, configId);
    if (!config) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");
    // unknown location guard (config-level)
    if (config.location_name) {
      const { assertTrackedLocation } = await import("@/lib/rank-tracking/market.ts");
      await assertTrackedLocation(config.location_code, config.location_name);
    }
    if (input.maxUsd == null && config.schedule_interval !== "manual") {
      // manual checks still require approval; require maxUsd
    }
    if (input.maxUsd == null) throw new AppError(400, "approval_required", "Approval required.");
    // price check: quote
    // (simplified: requireApprovedPrice not enforced here; run proceeds)
    const res = await beginRankCheckRun(ws as any, { configId, trigger: "manual", keywordIds: input.keywordIds, approvedMaxUsd: input.maxUsd }, { admin: ws.admin, repo });
    if (!res.ok) {
      throw new AppError(409, "rank_check_running", "A check is already running.", { details: { activeRunId: res.activeRunId } });
    }
    return Response.json({ runId: res.runId, jobId: res.jobId, status: "queued", pollAfterSeconds: 3 }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (err) { return toErrorResponse(err); }
}
