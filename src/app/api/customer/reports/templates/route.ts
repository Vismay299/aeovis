/**
 * F23 §6.5 — `GET` and `POST /api/customer/reports/templates`.
 *
 * The shape is validated here; the caps and the refusal copy belong to the
 * template service.
 */

import { AppError } from "../../../../../shared/http/appError.ts";
import { readOptionalJsonBody, toErrorResponse } from "../../../../../shared/http/errors.ts";
import { requireWorkspace } from "../../../../../server/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../../server/workspace/requireWorkspace.ts";
import { isFeatureEnabled } from "../../../../../server/features/flags.ts";
import {
  listReportTemplates,
  saveReportTemplate,
} from "../../../../../server/reports/templateService.ts";
import {
  reportsBrandQuery,
  templateSaveBodySchema,
} from "../../../../../server/reports/reports.contract.ts";

export const dynamic = "force-dynamic";

const FEATURE_OFF = "This page is not available for your workspace yet.";

export type ReportTemplatesRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  listReportTemplates?: typeof listReportTemplates;
  saveReportTemplate?: typeof saveReportTemplate;
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

function queryBrandKey(request: Request): string | undefined {
  const raw: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
  const parsed = reportsBrandQuery.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "invalid_request", "Check the query and try again.");
  return parsed.data.brand_key;
}

export async function GET(request: Request, _ctx?: unknown, deps?: ReportTemplatesRouteDeps): Promise<Response> {
  try {
    const workspace = await requireWorkspace(request, { brandKey: queryBrandKey(request) }, deps);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("reports", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", FEATURE_OFF);
    }
    const { templates, remaining } = await (deps?.listReportTemplates ?? listReportTemplates)(
      workspace.admin,
      workspace.brandKey,
    );
    return json({
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
    const workspace = await requireWorkspace(request, { brandKey: parsed.data.brand_key }, deps);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("reports", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", FEATURE_OFF);
    }
    const result = await (deps?.saveReportTemplate ?? saveReportTemplate)(workspace.admin, {
      brandKey: workspace.brandKey,
      name: parsed.data.name,
      description: parsed.data.description,
      instructions: parsed.data.instructions,
      createdBy: "app",
      createdByUserId: workspace.user.id,
    });
    return json({ templateId: result.templateId, created: true }, 201);
  } catch (err) {
    return toErrorResponse(err);
  }
}
