/**
 * F23 §6.5 — `GET /api/customer/reports`.
 *
 * Lists this workspace's reports, newest first. The response carries no `html`,
 * no `summary` and no share token: the list is metadata only.
 */

import { AppError } from "../../../../shared/http/appError.ts";
import { toErrorResponse } from "../../../../shared/http/errors.ts";
import { requireWorkspace } from "../../../../server/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../server/workspace/requireWorkspace.ts";
import { isFeatureEnabled } from "../../../../server/features/flags.ts";
import { listReports } from "../../../../server/reports/service.ts";
import { listReportTemplates } from "../../../../server/reports/templateService.ts";
import { SKILL_MANIFEST } from "../../../../assistant/skills/manifest.generated.ts";
import {
  reportsListQuery,
} from "../../../../server/reports/reports.contract.ts";

export const dynamic = "force-dynamic";

const FEATURE_OFF = "This page is not available for your workspace yet.";

export type ReportsListRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  listReports?: typeof listReports;
  listReportTemplates?: typeof listReportTemplates;
  getSkillTitle?: (skill: string | null) => string | null;
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

function defaultSkillTitle(skill: string | null): string | null {
  if (!skill) return null;
  return SKILL_MANIFEST.find((entry) => entry.name === skill)?.title ?? null;
}

export async function GET(request: Request, _ctx?: unknown, deps?: ReportsListRouteDeps): Promise<Response> {
  try {
    const raw: Record<string, string> = {};
    for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
    const parsed = reportsListQuery.safeParse(raw);
    if (!parsed.success) return toErrorResponse(parsed.error);
    const workspace = await (deps ? requireWorkspace(request, { brandKey: parsed.data.brand_key }, deps) : requireWorkspace(request, { brandKey: parsed.data.brand_key }));
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("reports", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", FEATURE_OFF);
    }
    const listFn = deps?.listReports ?? listReports;
    const templatesFn = deps?.listReportTemplates ?? listReportTemplates;
    const skillTitleFn = deps?.getSkillTitle ?? defaultSkillTitle;
    const { reports } = await listFn(workspace.admin, {
      brandKey: workspace.brandKey,
      limit: parsed.data.limit,
      offset: 0,
    });
    const { templates } = await templatesFn(workspace.admin, workspace.brandKey);
    const templateNames = new Map(templates.map((template) => [template.id, template.name]));
    return json({
      reports: reports.map((report) => ({
        id: report.id,
        title: report.title,
        skill: report.skill,
        skillTitle: skillTitleFn(report.skill),
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
