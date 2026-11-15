import { requireWorkspace } from "../../../../../../lib/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../../../lib/workspace/requireWorkspace.ts";
import { toErrorResponse, readOptionalJsonBody, jsonOk, AppError } from "../../../../../../lib/http/errors.ts";
import { exploreTrackRequestBody } from "../../../../../../lib/explore/explore.contract.ts";
import {
  trackExploreQuestion,
  type ExploreServiceDeps,
} from "../../../../../../lib/explore/service.ts";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ runId: string }> | { runId: string } };

export type ExploreTrackRouteDeps = RequireWorkspaceDeps &
  ExploreServiceDeps & {
    requireWorkspace?: typeof requireWorkspace;
    trackExploreQuestion?: typeof trackExploreQuestion;
  };

export async function POST(
  request: Request,
  context: Context,
  deps?: ExploreTrackRouteDeps,
): Promise<Response> {
  try {
    const raw = await readOptionalJsonBody(request);
    const body = exploreTrackRequestBody.parse(raw);
    const { runId } = await context.params;
    if (!runId || typeof runId !== "string") {
      throw new AppError(400, "invalid_request", "Missing runId parameter.");
    }
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: body.brand_key },
      deps,
    );
    const trackFn = deps?.trackExploreQuestion ?? trackExploreQuestion;
    const result = await trackFn(workspace, runId, deps);
    return jsonOk(result, 200);
  } catch (err) {
    return toErrorResponse(err);
  }
}
