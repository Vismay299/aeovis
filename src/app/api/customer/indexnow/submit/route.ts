import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../server/workspace/requireWorkspace.ts";
import { toErrorResponse, readOptionalJsonBody, AppError } from "../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../server/features/flags.ts";
import { submitUrls } from "../../../../../server/indexnow/submit.ts";
import { submitIndexNowRequest } from "../../../../../server/indexnow/indexnow.contract.ts";
import type { safeFetch } from "../../../../../shared/http/safeFetch.ts";
import type { IndexNowLimits } from "../../../../../server/indexnow/limits.ts";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export type SubmitRouteDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  submitUrls?: typeof submitUrls;
  safeFetch?: typeof safeFetch;
  fetchImpl?: typeof fetch;
  limits?: IndexNowLimits;
  now?: Date;
  generateKey?: () => string;
};

export async function POST(
  request: Request,
  _ctx?: unknown,
  deps?: SubmitRouteDeps
): Promise<Response> {
  try {
    const rawBody = await readOptionalJsonBody(request);
    const parsed = submitIndexNowRequest.safeParse(rawBody);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Invalid request body.", {
        details: { issues: parsed.error.issues },
      });
    }

    const { brandKey, brand, user, admin } = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: parsed.data.brand_key },
      deps
    );

    const isEnabled = await (deps?.isFeatureEnabled ?? isFeatureEnabled)("indexnow", brandKey);
    if (!isEnabled) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }

    const submitter = deps?.submitUrls ?? submitUrls;
    const result = await submitter(
      admin,
      { brandKey, brand, user },
      {
        urls: parsed.data.urls,
        source: parsed.data.source,
        sourceRef: parsed.data.sourceRef,
        requestId: parsed.data.requestId,
      },
      {
        safeFetch: deps?.safeFetch,
        fetchImpl: deps?.fetchImpl,
        limits: deps?.limits,
        now: deps?.now,
        generateKey: deps?.generateKey,
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
