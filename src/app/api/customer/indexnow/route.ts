import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../server/workspace/requireWorkspace.ts";
import { toErrorResponse, AppError } from "../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../server/features/flags.ts";
import { getSetup } from "../../../../server/indexnow/keys.ts";
import { fetchIndexNowUsage, readIndexNowLimits } from "../../../../server/indexnow/limits.ts";
import { getIndexNowQuery } from "../../../../server/indexnow/indexnow.contract.ts";

export const dynamic = "force-dynamic";

export type IndexNowRouteDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  getSetup?: typeof getSetup;
  fetchIndexNowUsage?: typeof fetchIndexNowUsage;
  readIndexNowLimits?: typeof readIndexNowLimits;
};

export async function GET(
  request: Request,
  _ctx?: unknown,
  deps?: IndexNowRouteDeps
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const rawQuery = Object.fromEntries(url.searchParams.entries());
    const queryParsed = getIndexNowQuery.safeParse(rawQuery);
    if (!queryParsed.success) {
      throw new AppError(400, "invalid_request", "Invalid query parameters.", {
        details: { issues: queryParsed.error.issues },
      });
    }

    const { brandKey, brand, admin } = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: queryParsed.data.brand_key },
      deps
    );

    const isEnabled = await (deps?.isFeatureEnabled ?? isFeatureEnabled)("indexnow", brandKey);
    if (!isEnabled) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }

    const getter = deps?.getSetup ?? getSetup;
    const usageFetcher = deps?.fetchIndexNowUsage ?? fetchIndexNowUsage;
    const limitsReader = deps?.readIndexNowLimits ?? readIndexNowLimits;

    const setup = await getter(admin, { brandKey, brand });
    const now = new Date();
    const [usage, limits] = await Promise.all([
      usageFetcher(admin, brandKey, now),
      Promise.resolve(limitsReader()),
    ]);

    const payload = {
      domain: setup.domain,
      key: setup.key,
      hosts: setup.hosts,
      checkedAt: setup.checkedAt,
      ready: setup.ready,
      limits: {
        requestsLastHour: usage.requestsLastHour,
        maxRequestsPerHour: limits.maxRequestsPerHour,
        urlsToday: usage.urlsToday,
        maxUrlsPerDay: limits.maxUrlsPerDay,
      },
    };

    return new Response(JSON.stringify(payload), {
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
