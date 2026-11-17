import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../server/workspace/requireWorkspace.ts";
import { toErrorResponse, readOptionalJsonBody, AppError } from "../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../server/features/flags.ts";
import { checkKeyFiles } from "../../../../../server/indexnow/keyFile.ts";
import { checkIndexNowRequest } from "../../../../../server/indexnow/indexnow.contract.ts";
import type { safeFetch } from "../../../../../shared/http/safeFetch.ts";
import type { IndexNowLimits } from "../../../../../server/indexnow/limits.ts";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export type CheckRouteDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  checkKeyFiles?: typeof checkKeyFiles;
  safeFetch?: typeof safeFetch;
  limits?: IndexNowLimits;
  now?: Date;
};

export async function POST(
  request: Request,
  _ctx?: unknown,
  deps?: CheckRouteDeps
): Promise<Response> {
  try {
    const rawBody = await readOptionalJsonBody(request);
    const parsed = checkIndexNowRequest.safeParse(rawBody);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Invalid request body.", {
        details: { issues: parsed.error.issues },
      });
    }

    const { brandKey, brand, admin } = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: parsed.data.brand_key },
      deps
    );

    const isEnabled = await (deps?.isFeatureEnabled ?? isFeatureEnabled)("indexnow", brandKey);
    if (!isEnabled) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }

    const checker = deps?.checkKeyFiles ?? checkKeyFiles;
    const result = await checker(
      admin,
      { brandKey, brand },
      { force: parsed.data.force },
      {
        safeFetch: deps?.safeFetch,
        limits: deps?.limits,
        now: deps?.now,
      }
    );

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
