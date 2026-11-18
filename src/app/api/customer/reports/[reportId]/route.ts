/**
 * F23 §6.5 — `GET` and `DELETE /api/customer/reports/[reportId]`.
 *
 * Detail carries the share state, the 30-day view count for the current link,
 * and the chat path when the writing session still belongs to the caller.
 * Delete removes the report; sharing state dies with it.
 */

import { jsonOk, readOptionalJsonBody, toErrorResponse } from "../../../../../shared/http/errors.ts";
import { brandKeyFrom } from "../../../../../server/assistant/routeDeps.ts";
import {
  deleteReport,
  getReport,
  viewsLast30Days,
} from "../../../../../server/reports/service.ts";
import { listReportTemplates } from "../../../../../server/reports/templateService.ts";
import { reportChatPath } from "../../../../../server/reports/chatPath.ts";
import {
  requireReportsWorkspace,
  skillTitleFor,
  type ReportsRouteDeps,
} from "../../../../../server/reports/routeKit.ts";
import {
  reportDeleteBodySchema,
  reportsBrandQuery,
} from "../../../../../server/reports/reports.contract.ts";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ reportId: string }> | { reportId: string } };

export type ReportItemRouteDeps = ReportsRouteDeps & {
  getReport?: typeof getReport;
  deleteReport?: typeof deleteReport;
  listReportTemplates?: typeof listReportTemplates;
  viewsLast30Days?: typeof viewsLast30Days;
  getSkillTitle?: (skill: string | null) => string | null;
  getChatPath?: typeof reportChatPath;
};

export async function GET(request: Request, context: Context, deps?: ReportItemRouteDeps): Promise<Response> {
  try {
    const workspace = await requireReportsWorkspace(request, brandKeyFrom(request, reportsBrandQuery), deps);
    const { reportId } = await context.params;
    const report = await (deps?.getReport ?? getReport)(workspace.admin, workspace.brandKey, reportId);

    // The three reads below depend only on the report row, so they run together.
    // The template list is only for the name a report's template now carries, so
    // a report with no template skips it.
    const [templates, views30d, chatPath] = await Promise.all([
      report.templateId
        ? (deps?.listReportTemplates ?? listReportTemplates)(workspace.admin, workspace.brandKey)
        : Promise.resolve(null),
      report.shareToken
        ? (deps?.viewsLast30Days ?? viewsLast30Days)(workspace.admin, {
            brandKey: workspace.brandKey,
            reportId: report.id,
            shareToken: report.shareToken,
          })
        : Promise.resolve(null),
      (deps?.getChatPath ?? reportChatPath)(workspace.admin, {
        brandKey: workspace.brandKey,
        userId: workspace.user.id,
        sessionId: report.sessionId,
      }),
    ]);
    const templateName = templates?.templates.find((template) => template.id === report.templateId)?.name ?? null;

    return jsonOk({
      report: {
        id: report.id,
        title: report.title,
        skill: report.skill,
        skillTitle: (deps?.getSkillTitle ?? skillTitleFor)(report.skill),
        templateId: report.templateId,
        templateName,
        createdBy: report.createdBy,
        createdByYou: report.createdByUserId !== null && report.createdByUserId === workspace.user.id,
        htmlBytes: report.sizeBytes,
        shared: report.shareToken !== null,
        createdAt: report.createdAt,
        updatedAt: report.updatedAt,
        shareToken: report.shareToken,
        sharedAt: report.sharedAt,
        views30d,
        chatPath,
      },
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request, context: Context, deps?: ReportItemRouteDeps): Promise<Response> {
  try {
    const body = await readOptionalJsonBody(request);
    const parsed = reportDeleteBodySchema.safeParse(body);
    if (!parsed.success) return toErrorResponse(parsed.error);
    const workspace = await requireReportsWorkspace(request, parsed.data.brand_key, deps);
    const { reportId } = await context.params;
    await (deps?.deleteReport ?? deleteReport)(workspace.admin, workspace.brandKey, reportId);
    return jsonOk({ reportId, deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
