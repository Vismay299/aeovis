// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/aiVisibilityExport.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../server/workspace/requireWorkspace.ts";
import { toErrorResponse, jsonOk, AppError, readJsonBody } from "../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../server/features/flags.ts";
import { createServerExport } from "../../../../shared/export/serverExport.ts";
import { exportRequest } from "../../../../shared/export/exports.contract.ts";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

export type ExportsRouteDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  createServerExport?: typeof createServerExport;
  now?: () => Date;
};

export async function POST(
  request: Request,
  _ctx?: unknown,
  deps?: ExportsRouteDeps,
): Promise<Response> {
  try {
    const raw = await readJsonBody(request);
    const parsed = exportRequest.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Invalid export request.", {
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    }
    const body = parsed.data;

    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: body.brandKey },
      deps,
    );

    const enabled = await (deps?.isFeatureEnabled ?? isFeatureEnabled)(
      "server_exports",
      workspace.brandKey,
    );
    if (!enabled) {
      throw new AppError(
        403,
        "feature_disabled",
        "Server exports are not enabled for this workspace.",
      );
    }

    const result = await (deps?.createServerExport ?? createServerExport)({
      admin: workspace.admin,
      brandKey: workspace.brandKey,
      userId: workspace.user.id,
      kind: body.kind,
      format: body.format,
      params: body.params,
      ...(deps?.now ? { now: deps.now } : {}),
    });

    return jsonOk(result, 200);
  } catch (err) {
    return toErrorResponse(err);
  }
}
