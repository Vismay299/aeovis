import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../lib/workspace/requireWorkspace.ts";
import { AppError } from "../../../../../lib/http/appError.ts";
import { toGa4ErrorResponse } from "../../../../../lib/ga4/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import { getOpportunities } from "../../../../../lib/ga4/opportunities.ts";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const opportunitiesQuery = z.strictObject({
  brand_key: z.string().optional(),
  range: z.enum(["last_7_days", "last_28_days", "last_90_days"]).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export type Ga4OpportunitiesRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  getOpportunities?: typeof getOpportunities;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}


export async function GET(request: Request, _ctx?: unknown, deps?: Ga4OpportunitiesRouteDeps): Promise<Response> {
  try {
    const url = new URL(request.url);
    const raw: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) raw[k] = v;
    const parsed = opportunitiesQuery.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Invalid query parameters.");
    }
    const q = parsed.data;
    if (Boolean(q.startDate) !== Boolean(q.endDate)) {
      throw new AppError(400, "invalid_request", "Provide both startDate and endDate, or neither.");
    }
    if (q.startDate && q.endDate && q.startDate > q.endDate) {
      throw new AppError(400, "invalid_request", "Dates must be valid YYYY-MM-DD values with startDate on or before endDate.");
    }
    const workspace = await requireWorkspace(request, { brandKey: q.brand_key }, deps);
    const featureCheck = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await featureCheck("ga4", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    const fn = deps?.getOpportunities ?? getOpportunities;
    const result = await fn(workspace.admin, { brandKey: workspace.brandKey, user: workspace.user, role: workspace.role }, {
      range: q.range,
      startDate: q.startDate,
      endDate: q.endDate,
      limit: q.limit,
    });
    return json(result);
  } catch (err) {
    return toGa4ErrorResponse(err);
  }
}
