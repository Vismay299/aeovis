/**
 * F04 §6.5 — `GET /api/customer/features`.
 *
 * The route tells the browser which of the workspace's features are on, so the
 * sidebar can hide a flagged item that is off. It reads ONLY the on/off state
 * of the names in `CLIENT_FEATURES`, for a workspace the caller belongs to.
 * No workspace data crosses this route.
 */

import { AppError, jsonOk, toErrorResponse } from "../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../server/features/flags.ts";
import { readClientFeatures } from "../../../../server/features/clientFeatures.ts";
import type { ReadClientFeaturesDeps } from "../../../../server/features/clientFeatures.ts";
import { requireWorkspace } from "../../../../server/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../server/workspace/requireWorkspace.ts";
import { featuresQuery } from "../../../../server/features/features.contract.ts";

export const dynamic = "force-dynamic";

/** The dependencies a test (or a future caller) may replace. */
export type FeaturesRouteDeps = RequireWorkspaceDeps & {
  readClientFeatures?: typeof readClientFeatures;
  /** The seams of `readClientFeatures`: which names, and how to evaluate them. */
  clientFeatureDeps?: ReadClientFeaturesDeps;
  isFeatureEnabled?: typeof isFeatureEnabled;
  env?: Record<string, string | undefined>;
};

export async function GET(
  request: Request,
  _ctx?: unknown,
  deps?: FeaturesRouteDeps
): Promise<Response> {
  try {
    // The declared query is a strictObject, so an unknown parameter is a 400
    // rather than something the route silently drops.
    const parsed = featuresQuery.safeParse(
      Object.fromEntries(new URL(request.url).searchParams)
    );
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Check the query and try again.");
    }
    const query = parsed.data;

    const workspace = await requireWorkspace(
      request,
      { brandKey: query.brand_key },
      deps
    );

    // The flag evaluation reads `paid_feature_controls` for a flag that spends,
    // so the workspace's own admin client is handed to it. A caller that
    // supplied its own evaluator keeps it.
    const clientFeatureDeps: ReadClientFeaturesDeps = {
      ...deps?.clientFeatureDeps,
      isEnabled:
        deps?.clientFeatureDeps?.isEnabled ??
        ((name, brandKey) =>
          (deps?.isFeatureEnabled ?? isFeatureEnabled)(name, brandKey, {
            env: deps?.env ?? process.env,
            admin: workspace.admin,
          })),
    };

    const features = await (deps?.readClientFeatures ?? readClientFeatures)(
      workspace.brandKey,
      clientFeatureDeps
    );

    return jsonOk({ brandKey: workspace.brandKey, features });
  } catch (err) {
    return toErrorResponse(err);
  }
}
