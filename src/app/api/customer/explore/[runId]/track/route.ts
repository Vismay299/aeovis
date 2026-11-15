// Portions Copyright (c) 2026 OpenSEO authors. Licensed under MIT.
// Adapted for Perceev.

import { requireWorkspace } from "../../../../../../lib/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../../../lib/workspace/requireWorkspace.ts";
import { toErrorResponse, readOptionalJsonBody, AppError } from "../../../../../../lib/http/errors.ts";
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
    await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: body.brand_key },
      deps,
    );
    // Phase 2: returns 501 not_available until Phase 3
    await trackExploreQuestion();
    return new Response(null, { status: 501 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
