import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../lib/workspace/requireWorkspace.ts";
import { toErrorResponse, AppError } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import { submitUrls } from "../../../../../lib/indexnow/submit.ts";
import { submitIndexNowRequest } from "../../../../../lib/indexnow/indexnow.contract.ts";
import type { safeFetch } from "../../../../../lib/http/safeFetch.ts";
import type { IndexNowLimits } from "../../../../../lib/indexnow/limits.ts";

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

async function readJsonBody(request: Request): Promise<unknown> {
  let text = "";
  try {
    text = await request.text();
  } catch {
    throw new AppError(400, "invalid_request", "The request body could not be read.");
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(400, "invalid_json", "The request body must be JSON.");
  }
}

export async function POST(
  request: Request,
  _ctx?: unknown,
  deps?: SubmitRouteDeps
): Promise<Response> {
  try {
    const rawBody = await readJsonBody(request);
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
