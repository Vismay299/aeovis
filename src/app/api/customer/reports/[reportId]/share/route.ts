/**
 * F23 §6.5 — `POST /api/customer/reports/[reportId]/share`.
 *
 * Sharing is a human action only: `{ public: true }` mints (or returns) the
 * link, `{ public: false }` revokes it. The service refuses when
 * `report_sharing` is off.
 */

import { AppError } from "../../../../../../shared/http/appError.ts";
import { readOptionalJsonBody, toErrorResponse } from "../../../../../../shared/http/errors.ts";
import { requireWorkspace } from "../../../../../../server/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../../../server/workspace/requireWorkspace.ts";
import { isFeatureEnabled } from "../../../../../../server/features/flags.ts";
import { shareReport, unshareReport } from "../../../../../../server/reports/service.ts";
import { reportShareBodySchema } from "../../../../../../server/reports/reports.contract.ts";

export const dynamic = "force-dynamic";

const FEATURE_OFF = "This page is not available for your workspace yet.";

type Context = { params: Promise<{ reportId: string }> | { reportId: string } };

export type ReportShareRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  shareReport?: typeof shareReport;
  unshareReport?: typeof unshareReport;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function POST(request: Request, context: Context, deps?: ReportShareRouteDeps): Promise<Response> {
  try {
    const body = await readOptionalJsonBody(request);
    const parsed = reportShareBodySchema.safeParse(body);
    if (!parsed.success) return toErrorResponse(parsed.error);
    const workspace = await requireWorkspace(request, { brandKey: parsed.data.brand_key }, deps);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("reports", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", FEATURE_OFF);
    }
    const { reportId } = await context.params;
    if (parsed.data.public) {
      const result = await (deps?.shareReport ?? shareReport)(workspace.admin, {
        brandKey: workspace.brandKey,
        reportId,
        userId: workspace.user.id,
      });
      return json({ shareToken: result.shareToken, sharedAt: result.sharedAt });
    }
    const result = await (deps?.unshareReport ?? unshareReport)(workspace.admin, {
      brandKey: workspace.brandKey,
      reportId,
      userId: workspace.user.id,
    });
    return json({ shareToken: result.shareToken, sharedAt: result.sharedAt });
  } catch (err) {
    return toErrorResponse(err);
  }
}
