import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../lib/workspace/requireWorkspace.ts";
import { toErrorResponse, AppError } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import { listSubmissions } from "../../../../../lib/indexnow/history.ts";
import { submissionsQuery } from "../../../../../lib/indexnow/indexnow.contract.ts";

export const dynamic = "force-dynamic";

export type SubmissionsRouteDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  listSubmissions?: typeof listSubmissions;
};

export async function GET(
  request: Request,
  _ctx?: unknown,
  deps?: SubmissionsRouteDeps
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const rawQuery = Object.fromEntries(url.searchParams.entries());

    const queryParsed = submissionsQuery.safeParse(rawQuery);
    if (!queryParsed.success) {
      throw new AppError(400, "invalid_request", "Invalid query parameters.", {
        details: { issues: queryParsed.error.issues },
      });
    }

    const { brandKey, admin } = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: queryParsed.data.brand_key },
      deps
    );

    const isEnabled = await (deps?.isFeatureEnabled ?? isFeatureEnabled)("indexnow", brandKey);
    if (!isEnabled) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }

    const lister = deps?.listSubmissions ?? listSubmissions;
    const result = await lister(
      admin,
      { brandKey },
      {
        source: queryParsed.data.source,
        sourceRef: queryParsed.data.sourceRef,
        limit: queryParsed.data.limit,
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
