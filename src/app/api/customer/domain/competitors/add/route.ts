import { AppError } from "../../../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../server/features/flags.ts";
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../../server/workspace/requireWorkspace.ts";
import {
  domainBrandQuery,
  domainCompetitorAddRequestBody,
} from "../../../../../../server/domain/domain.contract.ts";
import {
  addDomainAsCompetitor,
  type AddDomainAsCompetitorDeps,
} from "../../../../../../server/domain/addCompetitor.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type DomainCompetitorsAddRouteDeps = RequireWorkspaceDeps &
  AddDomainAsCompetitorDeps & {
    isFeatureEnabled?: typeof isFeatureEnabled;
    addDomainAsCompetitor?: typeof addDomainAsCompetitor;
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
  deps?: DomainCompetitorsAddRouteDeps,
): Promise<Response> {
  try {
    let bodyRaw: unknown;
    try {
      bodyRaw = await request.json();
    } catch {
      throw new AppError(400, "invalid_request", "The request body must be JSON.");
    }

    const parsed = domainCompetitorAddRequestBody.safeParse(bodyRaw);
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
    if (!(await checkFlag("project_memory", workspace.brandKey))) {
      throw new AppError(
        404,
        "feature_unavailable",
        "Project memory is not enabled for this workspace.",
      );
    }

    const addFn = deps?.addDomainAsCompetitor ?? addDomainAsCompetitor;
    const result = await addFn(
      workspace.admin,
      workspace.brand,
      workspace.user,
      body,
      deps,
    );

    return json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
