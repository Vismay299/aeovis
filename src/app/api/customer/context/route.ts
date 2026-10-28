// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/serverFunctions/projectContext.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * F07 §6.5 — `/api/customer/context`.
 *
 * Both handlers answer JSON with `Cache-Control: no-store`, gate on
 * `project_memory` before touching memory, and let `toErrorResponse` shape every
 * failure. The route is a thin adapter: the service owns all the behaviour, so
 * the whole surface can be exercised without a database through `deps`.
 */

import { AppError } from "../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../lib/features/flags.ts";
import { requireWorkspace } from "../../../../lib/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../lib/workspace/requireWorkspace.ts";
import { contextGetQuery } from "../../../../lib/projectContext/projectContext.contract.ts";
import {
  applyContextUpdates,
  getProjectContext,
  maybeImportBrandBrief,
} from "../../../../lib/projectContext/service.ts";
import type { ProjectContextDeps } from "../../../../lib/projectContext/service.ts";
import { updateProjectContextBody } from "../../../../shared/project-context.ts";

export const dynamic = "force-dynamic";

/** The dependencies a test (or a future caller) may replace. */
export type ContextRouteDeps = RequireWorkspaceDeps &
  ProjectContextDeps & {
    isFeatureEnabled?: typeof isFeatureEnabled;
    maybeImportBrandBrief?: typeof maybeImportBrandBrief;
    getProjectContext?: typeof getProjectContext;
    applyContextUpdates?: typeof applyContextUpdates;
  };

const UNAVAILABLE_MESSAGE = "This page is not available for your workspace yet.";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

/** The `brand_key` query parameter, rejected when it carries anything else. */
function queryBrandKey(request: Request): string | undefined {
  const raw: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
  const parsed = contextGetQuery.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "invalid_request", "Check the query and try again.");
  return parsed.data.brand_key;
}

export async function GET(request: Request, _ctx?: unknown, deps?: ContextRouteDeps): Promise<Response> {
  try {
    const workspace = await requireWorkspace(request, { brandKey: queryBrandKey(request) }, deps);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("project_memory", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", UNAVAILABLE_MESSAGE);
    }
    // GAP-10: the lazy brief import belongs to the read, not to the service, so
    // F13–F17 and F22 can call getProjectContext without importing anything.
    await (deps?.maybeImportBrandBrief ?? maybeImportBrandBrief)(workspace.admin, workspace.brand, deps);
    const context = await (deps?.getProjectContext ?? getProjectContext)(workspace.admin, workspace.brand, deps);
    return json(context);
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, _ctx?: unknown, deps?: ContextRouteDeps): Promise<Response> {
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new AppError(400, "invalid_request", "The request body must be JSON.");
    }
    // The 1–50 update bound is zod's, so an oversized batch is refused here and
    // never reaches the resolver or the 1–60-operation RPC.
    const parsed = updateProjectContextBody.safeParse(body);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Check the highlighted fields and try again.");
    }
    const brandKey = parsed.data.brand_key ?? queryBrandKey(request);
    const workspace = await requireWorkspace(request, { brandKey }, deps);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("project_memory", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", UNAVAILABLE_MESSAGE);
    }
    // Authorship on the wire: the author is always "user" from a route, and the
    // caller's id is what `updated_by_user` stores. PATCH never imports a brief.
    const context = await (deps?.applyContextUpdates ?? applyContextUpdates)(
      workspace.admin,
      workspace.brand,
      parsed.data.updates,
      "user",
      workspace.user.id,
      deps,
    );
    return json(context);
  } catch (err) {
    return toErrorResponse(err);
  }
}
