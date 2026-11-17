import { requireUser as defaultRequireUser, type RequireUserDeps } from "../../../../../server/auth/requireUser.ts";
import { AppError } from "../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../shared/http/errors.ts";
import { isFeatureEnabled as defaultIsFeatureEnabled } from "../../../../../server/features/flags.ts";
import { recordStep as defaultRecordStep } from "../../../../../server/onboarding/steps.ts";
import { visibleSteps, type OnboardingStep } from "../../../../../shared/onboarding.ts";
import { onboardingStepBodySchema } from "../../../../../server/onboarding/onboarding.contract.ts";
import { getGa4ConnectionState as defaultGetGa4ConnectionState } from "../../../../../server/ga4/connection.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type StepRouteDeps = RequireUserDeps & {
  requireUser?: typeof defaultRequireUser;
  isFeatureEnabled?: typeof defaultIsFeatureEnabled;
  recordStep?: typeof defaultRecordStep;
  getGa4ConnectionState?: typeof defaultGetGa4ConnectionState;
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
  deps?: StepRouteDeps,
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

    const body = onboardingStepBodySchema.parse(rawBody);

    // Read user_onboarding row to get brand_key if any
    const { data: row } = await admin
      .from("user_onboarding")
      .select("brand_key")
      .eq("user_id", user.id)
      .maybeSingle();

    const brandKey = row?.brand_key ?? undefined;

    const [ga4Flag, emailFlag, analyticsFlag] = await Promise.all([
      isFlagOn("ga4", brandKey),
      isFlagOn("lifecycle_email", brandKey),
      isFlagOn("product_analytics", brandKey),
    ]);

    let ga4Configured = false;
    if (brandKey) {
      try {
        const ga4Fn = deps?.getGa4ConnectionState ?? defaultGetGa4ConnectionState;
        const ga4State = await ga4Fn(admin, { brandKey });
        ga4Configured = Boolean(ga4State?.configured);
      } catch {
        ga4Configured = false;
      }
    }

    const visible = visibleSteps({
      ga4Available: Boolean(ga4Flag && ga4Configured),
      preferencesAvailable: Boolean(emailFlag || analyticsFlag),
    });

    if (!visible.includes(body.step)) {
      throw new AppError(400, "step_hidden", "This step is not available.");
    }

    const recordFn = deps?.recordStep ?? defaultRecordStep;
    const result = await recordFn(admin, user.id, body.step, body.status);

    return json({ steps: result.steps });
  } catch (err) {
    return toErrorResponse(err);
  }
}
