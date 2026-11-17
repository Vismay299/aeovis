import { requireUser as defaultRequireUser, type RequireUserDeps } from "../../../../../server/auth/requireUser.ts";
import { AppError } from "../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../shared/http/errors.ts";
import { isFeatureEnabled as defaultIsFeatureEnabled } from "../../../../../server/features/flags.ts";
import {
  saveOnboardingWebsite as defaultSaveOnboardingWebsite,
  type SaveWebsiteDeps,
} from "../../../../../server/onboarding/website.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type WebsiteRouteDeps = RequireUserDeps &
  SaveWebsiteDeps & {
    requireUser?: typeof defaultRequireUser;
    isFeatureEnabled?: typeof defaultIsFeatureEnabled;
    saveOnboardingWebsite?: typeof defaultSaveOnboardingWebsite;
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
  deps?: WebsiteRouteDeps,
): Promise<Response> {
  try {
    const isFlagOn = deps?.isFeatureEnabled ?? defaultIsFeatureEnabled;
    const enabled = await isFlagOn("onboarding_wizard");

    if (!enabled) {
      throw new AppError(404, "feature_unavailable", "The onboarding wizard is not available.");
    }

    const reqUser = deps?.requireUser ?? defaultRequireUser;
    const { user, admin } = await reqUser(request, deps);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError(400, "invalid_request", "Invalid JSON request body.");
    }

    const saveFn = deps?.saveOnboardingWebsite ?? defaultSaveOnboardingWebsite;
    const state = await saveFn(request, user, body, admin, deps);

    return json(state);
  } catch (err) {
    return toErrorResponse(err);
  }
}
