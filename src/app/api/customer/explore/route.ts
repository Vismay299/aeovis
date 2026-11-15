// Portions Copyright (c) 2026 OpenSEO authors. Licensed under MIT.
// Adapted for Perceev.

import { requireWorkspace } from "../../../../lib/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../lib/workspace/requireWorkspace.ts";
import { readJsonBody, toErrorResponse, jsonOk } from "../../../../lib/http/errors.ts";
import {
  exploreStartRequestBody,
  exploreListQuery,
} from "../../../../lib/explore/explore.contract.ts";
import {
  startExploreRun,
  listExploreRuns,
  type ExploreServiceDeps,
} from "../../../../lib/explore/service.ts";

export const dynamic = "force-dynamic";

export type ExploreRouteDeps = RequireWorkspaceDeps &
  ExploreServiceDeps & {
    requireWorkspace?: typeof requireWorkspace;
  };

export async function POST(
  request: Request,
  _context?: unknown,
  deps?: ExploreRouteDeps,
): Promise<Response> {
  try {
    const rawBody = await readJsonBody(request);
    const body = exploreStartRequestBody.parse(rawBody);
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: body.brand_key },
      deps,
    );
    const result = await startExploreRun(
      workspace.admin,
      {
        brandKey: workspace.brandKey,
        userId: workspace.user.id,
        body,
      },
      deps,
    );
    const status = result.status === "completed" ? 200 : 202;
    return jsonOk(result, status);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function GET(
  request: Request,
  _context?: unknown,
  deps?: ExploreRouteDeps,
): Promise<Response> {
  try {
    const raw: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) {
      raw[key] = value;
    }
    const query = exploreListQuery.parse(raw);
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: query.brand_key },
      deps,
    );
    const result = await listExploreRuns(
      workspace.admin,
      workspace.brandKey,
      {
        limit: query.limit,
        cursor: query.cursor,
      },
      deps,
    );
    return jsonOk(result, 200);
  } catch (err) {
    return toErrorResponse(err);
  }
}
