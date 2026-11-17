import { requireWorkspace as defaultRequireWorkspace, type RequireWorkspaceDeps, type Workspace } from "../../../../server/workspace/requireWorkspace.ts";
import { AppError } from "../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../shared/http/errors.ts";
import { isFeatureEnabled as defaultIsFeatureEnabled } from "../../../../server/features/flags.ts";
import { getSetupActivation as defaultGetSetupActivation } from "../../../../server/onboarding/setup.ts";
import { setupGetQuerySchema } from "../../../../server/onboarding/onboarding.contract.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type SetupRouteDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof defaultRequireWorkspace;
  isFeatureEnabled?: typeof defaultIsFeatureEnabled;
  getSetupActivation?: typeof defaultGetSetupActivation;
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

export async function GET(
  request: Request,
  _ctx?: unknown,
  deps?: SetupRouteDeps,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const rawQuery: Record<string, string> = {};
    const brandKeyParam = url.searchParams.get("brand_key");
    if (brandKeyParam) rawQuery.brand_key = brandKeyParam;

    setupGetQuerySchema.parse(rawQuery);

    const reqWs = deps?.requireWorkspace ?? defaultRequireWorkspace;
    const ws = await reqWs(request, { brandKey: rawQuery.brand_key }, deps);

    const isFlagOn = deps?.isFeatureEnabled ?? defaultIsFeatureEnabled;
    const enabled = await isFlagOn("onboarding_wizard", ws.brandKey);

    if (!enabled) {
      throw new AppError(404, "feature_unavailable", "The setup checklist is not available.");
    }

    const [siteAudit, schedule, ga4] = await Promise.all([
      isFlagOn("site_audit", ws.brandKey),
      isFlagOn("customer_scheduling", ws.brandKey),
      isFlagOn("ga4", ws.brandKey),
    ]);

    const features: Record<string, boolean> = {
      site_audit: siteAudit,
      customer_scheduling: schedule,
      ga4: ga4,
    };

    const getActivation = deps?.getSetupActivation ?? defaultGetSetupActivation;
    const result = await getActivation(ws.admin, ws, features);

    return json({
      brandKey: ws.brandKey,
      steps: result.steps,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
