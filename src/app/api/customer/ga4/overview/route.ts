import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../server/workspace/requireWorkspace.ts";
import { AppError } from "../../../../../shared/http/appError.ts";
import { toGa4ErrorResponse } from "../../../../../server/ga4/errors.ts";
import { isFeatureEnabled } from "../../../../../server/features/flags.ts";
import { getOrganicOverview } from "../../../../../server/ga4/overview.ts";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const overviewQuery = z.strictObject({
  brand_key: z.string().optional(),
  range: z.enum(["last_7_days", "last_28_days", "last_90_days"]).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  trend: z.enum(["daily", "weekly"]).optional(),
});

export type Ga4OverviewRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  getOrganicOverview?: typeof getOrganicOverview;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}


export async function GET(request: Request, _ctx?: unknown, deps?: Ga4OverviewRouteDeps): Promise<Response> {
  try {
    const url = new URL(request.url);
    const raw: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) raw[k] = v;
    const parsed = overviewQuery.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Invalid query parameters.");
    }
    const q = parsed.data;
    const workspace = await requireWorkspace(request, { brandKey: q.brand_key }, deps);
    const featureCheck = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await featureCheck("ga4", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    const fn = deps?.getOrganicOverview ?? getOrganicOverview;
    const result = await fn(workspace.admin, { brandKey: workspace.brandKey, user: workspace.user, role: workspace.role }, {
      range: q.range,
      startDate: q.startDate,
      endDate: q.endDate,
      trend: q.trend,
    });
    return json(result);
  } catch (err) {
    return toGa4ErrorResponse(err);
  }
}