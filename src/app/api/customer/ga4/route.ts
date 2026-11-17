import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../server/workspace/requireWorkspace.ts";
import { AppError } from "../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../server/features/flags.ts";
import { isGa4Configured } from "../../../../server/ga4/config.ts";
import { listGrantsForUser } from "../../../../server/ga4/grants.ts";
import { disconnect } from "../../../../server/ga4/connection.ts";
import { ga4DisconnectRequest, ga4StatusQuery } from "../../../../server/ga4/ga4.contract.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type Ga4RouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  isGa4Configured?: typeof isGa4Configured;
  listGrantsForUser?: typeof listGrantsForUser;
  disconnect?: typeof disconnect;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function parseQuery(request: Request): { brand_key?: string } {
  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    raw[key] = value;
  }
  const parsed = ga4StatusQuery.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(400, "invalid_request", "Invalid query parameters.");
  }
  return parsed.data;
}

export async function GET(
  request: Request,
  _ctx?: unknown,
  deps?: Ga4RouteDeps,
): Promise<Response> {
  try {
    const query = parseQuery(request);
    const workspace = await requireWorkspace(request, { brandKey: query.brand_key }, deps);

    const featureCheck = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await featureCheck("ga4", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }

    const checkConfigured = deps?.isGa4Configured ?? isGa4Configured;
    const configured = checkConfigured();
    const canManage = workspace.role === "owner";

    const grantLister = deps?.listGrantsForUser ?? listGrantsForUser;
    let currentUserHasGrant = false;
    try {
      const userGrants = await grantLister(workspace.admin, workspace.user.id);
      currentUserHasGrant = userGrants.length > 0;
    } catch {
      // Non-blocking check
    }

    const { data: connection, error: connError } = await workspace.admin
      .from("ga4_connections")
      .select("*")
      .eq("brand_key", workspace.brandKey)
      .maybeSingle();

    if (connError) {
      throw new AppError(503, "ga4_unavailable", "Google Analytics data is unavailable right now. Please retry.");
    }

    if (!connection) {
      return json({
        connected: false,
        configured,
        canManage,
        currentUserHasGrant,
        connectorIsMember: false,
        grantStatus: null,
        property: null,
        connectedByEmail: null,
        connectedAt: null,
      });
    }

    // Verify connector membership
    let connectorIsMember = false;
    if (connection.connected_by) {
      const { data: member } = await workspace.admin
        .from("customer_brand_memberships")
        .select("role")
        .eq("brand_key", workspace.brandKey)
        .eq("user_id", connection.connected_by)
        .maybeSingle();
      connectorIsMember = Boolean(member);
    }

    // Verify grant status
    let grantStatus: "active" | "error" | null = null;
    if (connection.grant_id) {
      const { data: grant } = await workspace.admin
        .from("ga4_grants")
        .select("status")
        .eq("id", connection.grant_id)
        .maybeSingle();
      if (grant) {
        grantStatus = grant.status;
      }
    }

    return json({
      connected: true,
      configured,
      canManage,
      currentUserHasGrant,
      connectorIsMember,
      grantStatus,
      property: {
        id: connection.property_id,
        displayName: connection.property_display_name,
        timeZone: connection.property_time_zone,
        currencyCode: connection.property_currency_code,
        accountDisplayName: connection.account_display_name,
      },
      connectedByEmail: connection.connected_account_email || null,
      connectedAt: connection.connected_at || connection.created_at,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  _ctx?: unknown,
  deps?: Ga4RouteDeps,
): Promise<Response> {
  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      rawBody = {};
    }
    const parsed = ga4DisconnectRequest.safeParse(rawBody);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Check the request parameters and try again.");
    }
    const brandKey = parsed.data.brand_key;

    const workspace = await requireWorkspace(
      request,
      { brandKey, role: "owner" },
      deps,
    );

    const featureCheck = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await featureCheck("ga4", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }

    const disconnecter = deps?.disconnect ?? disconnect;
    await disconnecter(
      workspace.admin,
      { brandKey: workspace.brandKey, user: workspace.user, role: workspace.role },
    );

    return json({ connected: false });
  } catch (err) {
    return toErrorResponse(err);
  }
}
