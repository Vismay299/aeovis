import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../lib/workspace/requireWorkspace.ts";
import { AppError } from "../../../../../lib/http/appError.ts";
import { toGa4ErrorResponse } from "../../../../../lib/ga4/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import { getMeasurementHealth } from "../../../../../lib/ga4/measurementHealth.ts";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const healthQuery = z.strictObject({
  brand_key: z.string().optional(),
});

export type Ga4HealthRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  getMeasurementHealth?: typeof getMeasurementHealth;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}


export async function GET(request: Request, _ctx?: unknown, deps?: Ga4HealthRouteDeps): Promise<Response> {
  try {
    const url = new URL(request.url);
    const raw: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) raw[k] = v;
    const parsed = healthQuery.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Invalid query parameters.");
    }
    const q = parsed.data;
    const workspace = await requireWorkspace(request, { brandKey: q.brand_key }, deps);
    const featureCheck = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await featureCheck("ga4", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    const fn = deps?.getMeasurementHealth ?? getMeasurementHealth;
    const result = await fn(workspace.admin, { brandKey: workspace.brandKey, user: workspace.user, role: workspace.role });
    return json(result);
  } catch (err) {
    return toGa4ErrorResponse(err);
  }
}