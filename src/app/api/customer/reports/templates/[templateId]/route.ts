/**
 * F23 §6.5 — `PUT` and `DELETE /api/customer/reports/templates/[templateId]`.
 *
 * Updates keep the stored template when the name is unchanged; deleting a
 * template never touches the reports that followed it.
 */

import { AppError } from "../../../../../../shared/http/appError.ts";
import { readOptionalJsonBody, toErrorResponse } from "../../../../../../shared/http/errors.ts";
import { requireWorkspace } from "../../../../../../server/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../../../server/workspace/requireWorkspace.ts";
import { isFeatureEnabled } from "../../../../../../server/features/flags.ts";
import {
  deleteReportTemplate,
  saveReportTemplate,
} from "../../../../../../server/reports/templateService.ts";
import {
  reportDeleteBodySchema,
  templateSaveBodySchema,
} from "../../../../../../server/reports/reports.contract.ts";

export const dynamic = "force-dynamic";

const FEATURE_OFF = "This page is not available for your workspace yet.";

type Context = { params: Promise<{ templateId: string }> | { templateId: string } };

export type ReportTemplateItemRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  saveReportTemplate?: typeof saveReportTemplate;
  deleteReportTemplate?: typeof deleteReportTemplate;
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

export async function PUT(request: Request, context: Context, deps?: ReportTemplateItemRouteDeps): Promise<Response> {
  try {
    const body = await readOptionalJsonBody(request);
    const parsed = templateSaveBodySchema.safeParse(body);
    if (!parsed.success) return toErrorResponse(parsed.error);
    const workspace = await requireWorkspace(request, { brandKey: parsed.data.brand_key }, deps);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("reports", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", FEATURE_OFF);
    }
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
    return json({ templateId: result.templateId, created: false });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request, context: Context, deps?: ReportTemplateItemRouteDeps): Promise<Response> {
  try {
    const body = await readOptionalJsonBody(request);
    const parsed = reportDeleteBodySchema.safeParse(body);
    if (!parsed.success) return toErrorResponse(parsed.error);
    const workspace = await requireWorkspace(request, { brandKey: parsed.data.brand_key }, deps);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("reports", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", FEATURE_OFF);
    }
    const { templateId } = await context.params;
    await (deps?.deleteReportTemplate ?? deleteReportTemplate)(
      workspace.admin,
      workspace.brandKey,
      templateId,
    );
    return json({ templateId, deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
