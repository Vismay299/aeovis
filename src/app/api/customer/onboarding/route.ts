import { requireUser as defaultRequireUser, type RequireUserDeps } from "../../../../server/auth/requireUser.ts";
import { toErrorResponse } from "../../../../shared/http/errors.ts";
import { isFeatureEnabled as defaultIsFeatureEnabled } from "../../../../server/features/flags.ts";
import {
  getOnboardingState as defaultGetOnboardingState,
  type OnboardingStateDeps,
} from "../../../../server/onboarding/state.ts";
import { normalizeScanId, normalizeHandoffDomain } from "../../../../shared/auth-redirect.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type OnboardingRouteDeps = RequireUserDeps &
  OnboardingStateDeps & {
    requireUser?: typeof defaultRequireUser;
    isFeatureEnabled?: typeof defaultIsFeatureEnabled;
    getOnboardingState?: typeof defaultGetOnboardingState;
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
  deps?: OnboardingRouteDeps,
): Promise<Response> {
  try {
    const isFlagOn = deps?.isFeatureEnabled ?? defaultIsFeatureEnabled;
    const enabled = await isFlagOn("onboarding_wizard");

    if (!enabled) {
      return json({ enabled: false });
    }

    const reqUser = deps?.requireUser ?? defaultRequireUser;
    const { user, admin } = await reqUser(request, deps);

    const url = new URL(request.url);
    const rawScan = url.searchParams.get("scan");
    const rawDomain = url.searchParams.get("domain");

    const scanId = rawScan ? normalizeScanId(rawScan) : null;
    const domain = rawDomain ? normalizeHandoffDomain(rawDomain) : null;

    const getState = deps?.getOnboardingState ?? defaultGetOnboardingState;
    const state = await getState(admin, user, { scanId, domain }, deps);

    return json(state);
  } catch (err) {
    return toErrorResponse(err);
  }
}
