import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../server/workspace/requireWorkspace.ts";
import { AppError } from "../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../server/features/flags.ts";
import { getGa4ConnectionState, setProperty } from "../../../../../server/ga4/connection.ts";
import { ga4PropertyRequest } from "../../../../../server/ga4/ga4.contract.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type Ga4PropertyRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  setProperty?: typeof setProperty;
  getGa4ConnectionState?: typeof getGa4ConnectionState;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function POST(request: Request, _ctx?: unknown, deps?: Ga4PropertyRouteDeps): Promise<Response> {
  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      rawBody = {};
    }
    const parsed = ga4PropertyRequest.safeParse(rawBody);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Check the request parameters and try again.");
    }

    const workspace = await requireWorkspace(
      request,
      { brandKey: parsed.data.brand_key, role: "owner" },
      deps,
    );

    const featureCheck = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await featureCheck("ga4", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }

    const setter = deps?.setProperty ?? setProperty;
    await setter(
      workspace.admin,
      { brandKey: workspace.brandKey, user: workspace.user, role: workspace.role },
      { grantId: parsed.data.grantId, propertyId: parsed.data.propertyId },
    );

    // 201 carries the same shape as GET /api/customer/ga4, read back from the
    // database rather than assumed, so the UI shows what was actually saved.
    const stateGetter = deps?.getGa4ConnectionState ?? getGa4ConnectionState;
    const state = await stateGetter(workspace.admin, {
      brandKey: workspace.brandKey,
      user: workspace.user,
      role: workspace.role,
    });
    return json(state, 201);
  } catch (err) {
    return toErrorResponse(err);
  }
}
