import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../lib/workspace/requireWorkspace.ts";
import { AppError } from "../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import { setProperty } from "../../../../../lib/ga4/connection.ts";
import { getConnection } from "../../../../../lib/ga4/connection.ts";
import { ga4PropertyRequest } from "../../../../../lib/ga4/ga4.contract.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type Ga4PropertyRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  setProperty?: typeof setProperty;
  getConnection?: typeof getConnection;
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

    const connGetter = deps?.getConnection ?? getConnection;
    const conn = await connGetter(workspace.admin, workspace.brandKey);

    return json(
      {
        connected: true,
        configured: true,
        canManage: true,
        currentUserHasGrant: true,
        connectorIsMember: true,
        grantStatus: "active",
        property: conn
          ? {
              id: conn.property_id,
              displayName: conn.property_display_name,
              timeZone: conn.property_time_zone,
              currencyCode: conn.property_currency_code,
              accountDisplayName: conn.account_display_name,
            }
          : null,
        connectedByEmail: conn?.connected_account_email || null,
        connectedAt: conn?.connected_at || conn?.created_at || null,
      },
      201,
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
