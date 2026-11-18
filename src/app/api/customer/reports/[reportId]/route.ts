/**
 * F23 §6.5 — `GET` and `DELETE /api/customer/reports/[reportId]`.
 *
 * Detail carries the share state, the 30-day view count for the current link,
 * and the chat path when the writing session still belongs to the caller.
 * Delete removes the report; sharing state dies with it.
 */

import { AppError } from "../../../../../shared/http/appError.ts";
import { readOptionalJsonBody, toErrorResponse } from "../../../../../shared/http/errors.ts";
import { requireWorkspace } from "../../../../../server/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../../server/workspace/requireWorkspace.ts";
import { isFeatureEnabled } from "../../../../../server/features/flags.ts";
import {
  deleteReport,
  getReport,
  viewsLast30Days,
} from "../../../../../server/reports/service.ts";
import { listReportTemplates } from "../../../../../server/reports/templateService.ts";
import { SKILL_MANIFEST } from "../../../../../assistant/skills/manifest.generated.ts";
import {
  reportDeleteBodySchema,
  reportsBrandQuery,
} from "../../../../../server/reports/reports.contract.ts";

export const dynamic = "force-dynamic";

const FEATURE_OFF = "This page is not available for your workspace yet.";

type Context = { params: Promise<{ reportId: string }> | { reportId: string } };

export type ReportItemRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  getReport?: typeof getReport;
  deleteReport?: typeof deleteReport;
  listReportTemplates?: typeof listReportTemplates;
  viewsLast30Days?: typeof viewsLast30Days;
  getSkillTitle?: (skill: string | null) => string | null;
  getChatPath?: (admin: unknown, brandKey: string, userId: string, reportId: string) => Promise<string | null>;
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

function queryBrandKey(request: Request): string | undefined {
  const raw: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
  const parsed = reportsBrandQuery.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "invalid_request", "Check the query and try again.");
  return parsed.data.brand_key;
}

async function defaultChatPath(
  admin: unknown,
  brandKey: string,
  userId: string,
  reportId: string,
): Promise<string | null> {
  try {
    type Chain = {
      eq: (column: string, value: string) => Chain;
      maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
    };
    const client = admin as {
      from: (table: string) => {
        select: (columns: string) => Chain;
      };
    };
    const { data, error } = await client
      .from("reports")
      .select("session_id")
      .eq("id", reportId)
      .eq("brand_key", brandKey)
      .maybeSingle();
    if (error) return null;
    const sessionId = (data as { session_id?: unknown } | null)?.session_id;
    if (typeof sessionId !== "string" || !sessionId) return null;
    const { data: session, error: sessionError } = await client
      .from("assistant_sessions")
      .select("id")
      .eq("id", sessionId)
      .eq("brand_key", brandKey)
      .eq("user_id", userId)
      .maybeSingle();
    if (sessionError || !session) return null;
    return `/portal/assistant?s=${sessionId}`;
  } catch {
    return null;
  }
}

async function loadWorkspace(request: Request, brandKey: string | undefined, deps?: ReportItemRouteDeps) {
  const workspace = await requireWorkspace(request, { brandKey }, deps);
  if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("reports", workspace.brandKey))) {
    throw new AppError(404, "feature_unavailable", FEATURE_OFF);
  }
  return workspace;
}

export async function GET(request: Request, context: Context, deps?: ReportItemRouteDeps): Promise<Response> {
  try {
    const workspace = await loadWorkspace(request, queryBrandKey(request), deps);
    const { reportId } = await context.params;
    const report = await (deps?.getReport ?? getReport)(workspace.admin, workspace.brandKey, reportId);
    const templatesFn = deps?.listReportTemplates ?? listReportTemplates;
    const skillTitleFn = deps?.getSkillTitle ?? defaultSkillTitle;
    const viewsFn = deps?.viewsLast30Days ?? viewsLast30Days;
    const chatPathFn = deps?.getChatPath ?? defaultChatPath;
    const { templates } = await templatesFn(workspace.admin, workspace.brandKey);
    const templateNames = new Map(templates.map((template) => [template.id, template.name]));
    const views30d = report.shareToken
      ? await viewsFn(
          workspace.admin,
          { brandKey: workspace.brandKey, reportId: report.id, shareToken: report.shareToken },
        )
      : null;
    const chatPath = await chatPathFn(workspace.admin, workspace.brandKey, workspace.user.id, report.id);
    return json({
      report: {
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
    const workspace = await loadWorkspace(request, parsed.data.brand_key ?? queryBrandKey(request), deps);
    const { reportId } = await context.params;
    await (deps?.deleteReport ?? deleteReport)(workspace.admin, workspace.brandKey, reportId);
    return json({ reportId, deleted: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
