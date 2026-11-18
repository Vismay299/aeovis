/**
 * F23 §6.5 — `PUT` and `DELETE /api/customer/reports/templates/[templateId]`.
 *
 * Updates keep the stored template when the name is unchanged; deleting a
 * template never touches the reports that followed it.
 */

import { jsonOk, readOptionalJsonBody, toErrorResponse } from "../../../../../../shared/http/errors.ts";
import {
  deleteReportTemplate,
  saveReportTemplate,
} from "../../../../../../server/reports/templateService.ts";
import {
  requireReportsWorkspace,
  type ReportsRouteDeps,
} from "../../../../../../server/reports/routeKit.ts";
import {
  reportDeleteBodySchema,
  templateSaveBodySchema,
} from "../../../../../../server/reports/reports.contract.ts";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ templateId: string }> | { templateId: string } };

export type ReportTemplateItemRouteDeps = ReportsRouteDeps & {
  saveReportTemplate?: typeof saveReportTemplate;
  deleteReportTemplate?: typeof deleteReportTemplate;
};

export async function PUT(request: Request, context: Context, deps?: ReportTemplateItemRouteDeps): Promise<Response> {
  try {
    const body = await readOptionalJsonBody(request);
    const parsed = templateSaveBodySchema.safeParse(body);
    if (!parsed.success) return toErrorResponse(parsed.error);
    const workspace = await requireReportsWorkspace(request, parsed.data.brand_key, deps);
    const { templateId } = await context.params;
    const result = await (deps?.saveReportTemplate ?? saveReportTemplate)(workspace.admin, {
      brandKey: workspace.brandKey,
      templateId,
      name: parsed.data.name,
      description: parsed.data.description,
      instructions: parsed.data.instructions,
      createdBy: "app",
      createdByUserId: workspace.user.id,
    });
    return jsonOk({ templateId: result.templateId, created: false });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request, context: Context, deps?: ReportTemplateItemRouteDeps): Promise<Response> {
  try {
    const body = await readOptionalJsonBody(request);
    const parsed = reportDeleteBodySchema.safeParse(body);
    if (!parsed.success) return toErrorResponse(parsed.error);
    const workspace = await requireReportsWorkspace(request, parsed.data.brand_key, deps);
    const { templateId } = await context.params;
    await (deps?.deleteReportTemplate ?? deleteReportTemplate)(workspace.admin, workspace.brandKey, templateId);
    return jsonOk({ templateId, deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
