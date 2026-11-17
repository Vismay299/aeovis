/**
 * F03 §6.5 — `GET /api/customer/usage`.
 *
 * The route is a thin adapter: the service owns the aggregation, the flag
 * decides whether the workspace may read it at all, and `toErrorResponse`
 * shapes every failure. The customer only ever sees their own workspace.
 */

import { AppError, jsonOk, toErrorResponse } from "../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../server/features/flags.ts";
import { requireWorkspace } from "../../../../server/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../server/workspace/requireWorkspace.ts";
import { getWorkspaceUsage } from "../../../../server/costs/usage.ts";
import { usageQuery } from "../../../../server/costs/usage.contract.ts";

export const dynamic = "force-dynamic";

/** The dependencies a test (or a future caller) may replace. */
export type UsageRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  getWorkspaceUsage?: typeof getWorkspaceUsage;
  env?: Record<string, string | undefined>;
};

const FEATURE_UNAVAILABLE = "Usage is not available for this workspace yet.";
const USAGE_UNAVAILABLE = "Usage could not be loaded. Please retry.";

/**
 * The error's name and message, bounded. A database failure is PostgREST's
 * plain `{message, code, details, hint}` object rather than an `Error`, so its
 * message is read directly.
 */
function describeFailure(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message.slice(0, 200)}`;
  const message = (err as { message?: unknown } | null | undefined)?.message;
  if (typeof message === "string") return `Error: ${message.slice(0, 200)}`;
  return typeof err;
}

export async function GET(request: Request, _ctx?: unknown, deps?: UsageRouteDeps): Promise<Response> {
  try {
    // The declared query is a strictObject, so an unknown parameter is a 400
    // rather than something the route silently drops.
    const parsed = usageQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Check the query and try again.");
    }
    const query = parsed.data;

    const workspace = await requireWorkspace(request, { brandKey: query.brand_key }, deps);
    const enabled = await (deps?.isFeatureEnabled ?? isFeatureEnabled)("usage_page", workspace.brandKey, {
      env: deps?.env ?? process.env,
      admin: workspace.admin,
    });
    if (!enabled) {
      throw new AppError(404, "feature_unavailable", FEATURE_UNAVAILABLE);
    }

    let usage;
    try {
      usage = await (deps?.getWorkspaceUsage ?? getWorkspaceUsage)(
        workspace.admin,
        workspace.brandKey,
        {
          range: query.range,
          timeZone: query.tz,
          env: deps?.env ?? process.env,
        }
      );
    } catch (err) {
      // A database failure is a 503 with our own copy, never an upstream body.
      // It is logged here: the route swallows the error, so nothing else would
      // make an outage visible. Route name and the error only — no payload,
      // no query, no headers, no brand key (conventions §6 rule 9).
      console.error("[customer] usage failed:", describeFailure(err));
      throw new AppError(503, "usage_unavailable", USAGE_UNAVAILABLE);
    }
    return jsonOk(usage);
  } catch (err) {
    return toErrorResponse(err);
  }
}
