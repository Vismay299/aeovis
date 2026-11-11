import { AppError } from "../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../lib/workspace/requireWorkspace.ts";
import {
  domainBrandQuery,
  domainCompetitorsRequestBody,
} from "../../../../../lib/domain/domain.contract.ts";
import {
  runSerpCompetitorsRequest,
  type SerpCompetitorsDeps,
} from "../../../../../lib/domain/serpCompetitors.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type DomainCompetitorsRouteDeps = RequireWorkspaceDeps &
  Partial<SerpCompetitorsDeps> & {
    isFeatureEnabled?: typeof isFeatureEnabled;
    runSerpCompetitorsRequest?: typeof runSerpCompetitorsRequest;
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

function queryBrandKey(request: Request): string | undefined {
  const raw: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
  const parsed = domainBrandQuery.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(400, "invalid_request", "Check the query and try again.");
  }
  return parsed.data.brand_key;
}

export async function POST(
  request: Request,
  _ctx?: unknown,
  deps?: DomainCompetitorsRouteDeps,
): Promise<Response> {
  try {
    let bodyRaw: unknown;
    try {
      bodyRaw = await request.json();
    } catch {
      throw new AppError(400, "invalid_request", "The request body must be JSON.");
    }

    const parsed = domainCompetitorsRequestBody.safeParse(bodyRaw);
    if (!parsed.success) {
      throw new AppError(
        400,
        "invalid_request",
        "Check the highlighted fields and try again.",
      );
    }
    const body = parsed.data;

    const brandKey = queryBrandKey(request);
    const workspace = await requireWorkspace(request, { brandKey }, deps);

    const checkFlag = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await checkFlag("domain_research", workspace.brandKey))) {
      throw new AppError(
        404,
        "feature_unavailable",
        "This page is not available for your workspace yet.",
      );
    }

    const runFn = deps?.runSerpCompetitorsRequest ?? runSerpCompetitorsRequest;
    const outcome = await runFn(workspace, body, deps);

    return json(outcome);
  } catch (err) {
    return toErrorResponse(err);
  }
}
