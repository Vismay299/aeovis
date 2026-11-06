import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../lib/workspace/requireWorkspace.ts";
import { AppError } from "../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import { isGa4Configured } from "../../../../../lib/ga4/config.ts";
import { createGa4AuthorizationUrl } from "../../../../../lib/ga4/oauth.ts";
import { customerSessionBinding } from "../../../../../lib/supabase/sessionBinding.js";
import { ga4ConnectRequest } from "../../../../../lib/ga4/ga4.contract.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type Ga4ConnectRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  isGa4Configured?: typeof isGa4Configured;
  customerSessionBinding?: typeof customerSessionBinding;
  createGa4AuthorizationUrl?: typeof createGa4AuthorizationUrl;
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

export async function POST(
  request: Request,
  _ctx?: unknown,
  deps?: Ga4ConnectRouteDeps,
): Promise<Response> {
  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      rawBody = {};
    }

    const parsed = ga4ConnectRequest.safeParse(rawBody);
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

    const checkConfigured = deps?.isGa4Configured ?? isGa4Configured;
    if (!checkConfigured()) {
      throw new AppError(503, "ga4_not_configured", "Google Analytics isn't set up on this deployment yet.");
    }

    const getCtx =
      deps?.getCustomerContext ??
      (async () => {
        const { getCustomerContext } = await import("../../../../../lib/supabase/customer.js");
        return getCustomerContext();
      });
    const customerContext = await getCtx();

    const getSessionBinding = deps?.customerSessionBinding ?? customerSessionBinding;
    const sessionHash = await getSessionBinding(customerContext);
    if (!sessionHash) {
      throw new AppError(401, "session_expired", "Your login session expired. Please sign in again.");
    }

    const authUrlCreator = deps?.createGa4AuthorizationUrl ?? createGa4AuthorizationUrl;
    const { authorizationUrl } = await authUrlCreator({
      admin: workspace.admin,
      userId: workspace.user.id,
      brandKey: workspace.brandKey,
      sessionTokenHash: sessionHash,
      returnPath: parsed.data.returnTo,
    });

    return json({ authorizationUrl });
  } catch (err) {
    return toErrorResponse(err);
  }
}
