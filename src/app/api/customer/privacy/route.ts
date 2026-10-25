import { requireUser, type RequireUserDeps } from "../../../../lib/auth/requireUser.ts";
import { AppError } from "../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../lib/features/flags.ts";
import { POLICY_VERSION } from "../../../../lib/telemetry/events.ts";
import { privacyPutRequest } from "../../../../lib/telemetry/privacy.contract.ts";
import { readPrivacyChoice, savePrivacyChoice } from "../../../../lib/telemetry/privacy.ts";
import { serverTelemetryEnabled } from "../../../../lib/telemetry/server.ts";

export const dynamic = "force-dynamic";

export type PrivacyRouteDeps = RequireUserDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  serverTelemetryEnabled?: typeof serverTelemetryEnabled;
  readPrivacyChoice?: typeof readPrivacyChoice;
  savePrivacyChoice?: typeof savePrivacyChoice;
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

async function telemetryAvailable(deps?: PrivacyRouteDeps): Promise<boolean> {
  const enabled = (deps?.serverTelemetryEnabled ?? serverTelemetryEnabled)();
  if (!enabled) return false;
  return (deps?.isFeatureEnabled ?? isFeatureEnabled)("product_analytics");
}

function shape(
  choice: Awaited<ReturnType<typeof readPrivacyChoice>>,
  available: boolean,
) {
  return {
    analytics: choice ? choice.analytics : null,
    decidedAt: choice ? choice.decidedAt : null,
    source: choice ? choice.source : null,
    policyVersion: choice?.policyVersion ?? POLICY_VERSION,
    telemetryAvailable: available,
  };
}

export async function GET(request: Request, _ctx?: unknown, deps?: PrivacyRouteDeps): Promise<Response> {
  try {
    const { user, admin } = await requireUser(request, deps);
    const available = await telemetryAvailable(deps);
    const reader = deps?.readPrivacyChoice ?? readPrivacyChoice;
    let choice;
    try {
      choice = await reader(admin, user.id);
    } catch {
      throw new AppError(503, "privacy_unavailable", "Your privacy settings couldn't be saved. Please retry.");
    }
    return json(shape(choice, available));
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PUT(request: Request, _ctx?: unknown, deps?: PrivacyRouteDeps): Promise<Response> {
  try {
    const { user, admin } = await requireUser(request, deps);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError(400, "invalid_request", "The request body must be JSON.");
    }
    const parsed = privacyPutRequest.safeParse(body);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Check the highlighted fields and try again.");
    }
    const saver = deps?.savePrivacyChoice ?? savePrivacyChoice;
    let choice;
    try {
      choice = await saver(admin, user.id, parsed.data.analytics, parsed.data.source);
    } catch {
      throw new AppError(
        503,
        "privacy_unavailable",
        "Your privacy settings couldn't be saved. Please retry.",
      );
    }
    const available = await telemetryAvailable(deps);
    return json(shape(choice, available));
  } catch (err) {
    return toErrorResponse(err);
  }
}
