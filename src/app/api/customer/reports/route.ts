/**
 * F23 §6.5 — `GET /api/customer/reports`.
 *
 * Lists this workspace's reports, newest first. The response carries no `html`,
 * no `summary` and no share token: the list is metadata only.
 */

import { jsonOk, toErrorResponse } from "../../../../shared/http/errors.ts";
import { listReports } from "../../../../server/reports/service.ts";
import { listReportTemplates } from "../../../../server/reports/templateService.ts";
import {
  requireReportsWorkspace,
  skillTitleFor,
  type ReportsRouteDeps,
} from "../../../../server/reports/routeKit.ts";
import { reportsListQuery } from "../../../../server/reports/reports.contract.ts";

export const dynamic = "force-dynamic";

export type ReportsListRouteDeps = ReportsRouteDeps & {
  listReports?: typeof listReports;
  listReportTemplates?: typeof listReportTemplates;
  getSkillTitle?: (skill: string | null) => string | null;
};

export async function GET(request: Request, _ctx?: unknown, deps?: ReportsListRouteDeps): Promise<Response> {
  try {
    const raw: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
    const parsed = reportsListQuery.safeParse(raw);
    if (!parsed.success) return toErrorResponse(parsed.error);
    const workspace = await requireReportsWorkspace(request, parsed.data.brand_key, deps);

    // Neither read needs the other's result.
    const [{ reports }, { templates }] = await Promise.all([
      (deps?.listReports ?? listReports)(workspace.admin, {
        brandKey: workspace.brandKey,
        limit: parsed.data.limit,
        offset: 0,
      }),
      (deps?.listReportTemplates ?? listReportTemplates)(workspace.admin, workspace.brandKey),
    ]);
    const templateNames = new Map(templates.map((template) => [template.id, template.name]));
    const skillTitle = deps?.getSkillTitle ?? skillTitleFor;
    return jsonOk({
      reports: reports.map((report) => ({
        id: report.id,
        title: report.title,
        skill: report.skill,
        skillTitle: skillTitle(report.skill),
        templateId: report.templateId,
        templateName: report.templateId ? (templateNames.get(report.templateId) ?? null) : null,
        createdBy: report.createdBy,
        createdByYou: report.createdByUserId !== null && report.createdByUserId === workspace.user.id,
        htmlBytes: report.sizeBytes,
        shared: report.shareToken !== null,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt,
      })),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
