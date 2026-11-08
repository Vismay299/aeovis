import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../lib/workspace/requireWorkspace.ts";
import { toErrorResponse, AppError } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import { checkKeyFiles } from "../../../../../lib/indexnow/keyFile.ts";
import { checkIndexNowRequest } from "../../../../../lib/indexnow/indexnow.contract.ts";
import type { safeFetch } from "../../../../../lib/http/safeFetch.ts";
import type { IndexNowLimits } from "../../../../../lib/indexnow/limits.ts";

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
  deps?: CheckRouteDeps
): Promise<Response> {
  try {
    const rawBody = await readJsonBody(request);
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
