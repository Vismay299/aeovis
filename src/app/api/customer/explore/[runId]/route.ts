import { requireWorkspace } from "../../../../../server/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../../server/workspace/requireWorkspace.ts";
import { toErrorResponse, jsonOk, AppError } from "../../../../../shared/http/errors.ts";
import { exploreGetQuery } from "../../../../../server/explore/explore.contract.ts";
import {
  getExploreRun,
  type ExploreServiceDeps,
} from "../../../../../server/explore/service.ts";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ runId: string }> | { runId: string } };

export type ExploreRunRouteDeps = RequireWorkspaceDeps &
  ExploreServiceDeps & {
    requireWorkspace?: typeof requireWorkspace;
  };

export async function GET(
  request: Request,
  context: Context,
  deps?: ExploreRunRouteDeps,
): Promise<Response> {
  try {
    const raw: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) {
      raw[key] = value;
    }
    const query = exploreGetQuery.parse(raw);
    const { runId } = await context.params;
    if (!runId || typeof runId !== "string") {
      throw new AppError(400, "invalid_request", "Missing runId parameter.");
    }
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: query.brand_key },
      deps,
    );
    const result = await getExploreRun(
      workspace.admin,
      workspace.brandKey,
      runId,
      {
        ...deps,
        workspaceAliases: deps?.workspaceAliases ?? workspace.brand?.aliases,
      },
    );
    return jsonOk(result, 200);
  } catch (err) {
    return toErrorResponse(err);
  }
}
