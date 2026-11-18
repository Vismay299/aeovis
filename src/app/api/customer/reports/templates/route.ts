/**
 * F23 §6.5 — `GET` and `POST /api/customer/reports/templates`.
 *
 * The shape is validated here; the caps and the refusal copy belong to the
 * template service.
 */

import { jsonOk, readOptionalJsonBody, toErrorResponse } from "../../../../../shared/http/errors.ts";
import { brandKeyFrom } from "../../../../../server/assistant/routeDeps.ts";
import {
  listReportTemplates,
  saveReportTemplate,
} from "../../../../../server/reports/templateService.ts";
import {
  requireReportsWorkspace,
  type ReportsRouteDeps,
} from "../../../../../server/reports/routeKit.ts";
import {
  reportsBrandQuery,
  templateSaveBodySchema,
} from "../../../../../server/reports/reports.contract.ts";

export const dynamic = "force-dynamic";

export type ReportTemplatesRouteDeps = ReportsRouteDeps & {
  listReportTemplates?: typeof listReportTemplates;
  saveReportTemplate?: typeof saveReportTemplate;
};

export async function GET(request: Request, _ctx?: unknown, deps?: ReportTemplatesRouteDeps): Promise<Response> {
  try {
    const workspace = await requireReportsWorkspace(request, brandKeyFrom(request, reportsBrandQuery), deps);
    const { templates, remaining } = await (deps?.listReportTemplates ?? listReportTemplates)(
      workspace.admin,
      workspace.brandKey,
    );
    return jsonOk({
      templates: templates.map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        instructions: template.instructions,
        createdAt: template.createdAt,
        updatedAt: template.updatedAt,
      })),
      remaining,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, _ctx?: unknown, deps?: ReportTemplatesRouteDeps): Promise<Response> {
  try {
    const body = await readOptionalJsonBody(request);
    const parsed = templateSaveBodySchema.safeParse(body);
    if (!parsed.success) return toErrorResponse(parsed.error);
    const workspace = await requireReportsWorkspace(request, parsed.data.brand_key, deps);
    const result = await (deps?.saveReportTemplate ?? saveReportTemplate)(workspace.admin, {
      brandKey: workspace.brandKey,
      name: parsed.data.name,
      description: parsed.data.description,
      instructions: parsed.data.instructions,
      createdBy: "app",
      createdByUserId: workspace.user.id,
    });
    return jsonOk({ templateId: result.templateId, created: true }, 201);
  } catch (err) {
    return toErrorResponse(err);
  }
}
