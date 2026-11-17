import { requireUser as defaultRequireUser, type RequireUserDeps } from "../../../../../server/auth/requireUser.ts";
import { AppError } from "../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../shared/http/errors.ts";
import { isFeatureEnabled as defaultIsFeatureEnabled } from "../../../../../server/features/flags.ts";
import { completeOnboarding as defaultCompleteOnboarding } from "../../../../../server/onboarding/steps.ts";
import { finishDestination } from "../../../../../shared/onboarding.ts";
import { onboardingCompleteBodySchema } from "../../../../../server/onboarding/onboarding.contract.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type CompleteRouteDeps = RequireUserDeps & {
  requireUser?: typeof defaultRequireUser;
  isFeatureEnabled?: typeof defaultIsFeatureEnabled;
  completeOnboarding?: typeof defaultCompleteOnboarding;
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
  deps?: CompleteRouteDeps,
): Promise<Response> {
  try {
    const isFlagOn = deps?.isFeatureEnabled ?? defaultIsFeatureEnabled;
    const enabled = await isFlagOn("onboarding_wizard");

    if (!enabled) {
      throw new AppError(404, "feature_unavailable", "The onboarding wizard is not available.");
    }

    const reqUser = deps?.requireUser ?? defaultRequireUser;
    const { user, admin } = await reqUser(request, deps);

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      throw new AppError(400, "invalid_request", "Invalid JSON request body.");
    }

    const body = onboardingCompleteBodySchema.parse(rawBody);

    const completeFn = deps?.completeOnboarding ?? defaultCompleteOnboarding;
    const result = await completeFn(admin, user.id, body.via);

    // Read row to compute finishDestination
    const { data: row } = await admin
      .from("user_onboarding")
      .select("brand_key, handoff")
      .eq("user_id", user.id)
      .maybeSingle();

    const handoff = (row?.handoff as Record<string, unknown> | null) ?? {};
    let workspaceHost: string | null = null;
    let domainOverviewOn = false;

    if (row?.brand_key) {
      const { data: brand } = await admin
        .from("customer_brands")
        .select("website_host")
        .eq("brand_key", row.brand_key)
        .maybeSingle();

      workspaceHost = brand?.website_host ?? null;
      domainOverviewOn = await isFlagOn("domain_research", row.brand_key);
    }

    const destination = finishDestination({
      redirect: null,
      handoffDomain: (handoff.domain as string) ?? null,
      handoffScan: (handoff.scanId as string) ?? null,
      workspaceHost,
      domainOverviewOn,
    });

    return json({
      completedAt: result.completedAt,
      via: result.via,
      destination,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
