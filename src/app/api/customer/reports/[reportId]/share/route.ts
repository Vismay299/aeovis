/**
 * F23 §6.5 — `POST /api/customer/reports/[reportId]/share`.
 *
 * Sharing is a human action only: `{ public: true }` mints (or returns) the
 * link, `{ public: false }` revokes it. The service refuses when
 * `report_sharing` is off.
 */

import { jsonOk, readOptionalJsonBody, toErrorResponse } from "../../../../../../shared/http/errors.ts";
import { shareReport, unshareReport } from "../../../../../../server/reports/service.ts";
import {
  requireReportsWorkspace,
  type ReportsRouteDeps,
} from "../../../../../../server/reports/routeKit.ts";
import { reportShareBodySchema } from "../../../../../../server/reports/reports.contract.ts";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ reportId: string }> | { reportId: string } };

export type ReportShareRouteDeps = ReportsRouteDeps & {
  shareReport?: typeof shareReport;
  unshareReport?: typeof unshareReport;
};

export async function POST(request: Request, context: Context, deps?: ReportShareRouteDeps): Promise<Response> {
  try {
    const body = await readOptionalJsonBody(request);
    const parsed = reportShareBodySchema.safeParse(body);
    if (!parsed.success) return toErrorResponse(parsed.error);
    const workspace = await requireReportsWorkspace(request, parsed.data.brand_key, deps);
    const { reportId } = await context.params;
    const input = { brandKey: workspace.brandKey, reportId, userId: workspace.user.id };
    const result = parsed.data.public
      ? await (deps?.shareReport ?? shareReport)(workspace.admin, input)
      : await (deps?.unshareReport ?? unshareReport)(workspace.admin, input);
    return jsonOk({ shareToken: result.shareToken, sharedAt: result.sharedAt });
  } catch (err) {
    return toErrorResponse(err);
  }
}
