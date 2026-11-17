import { requireWorkspace } from "../../../../../../../../server/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../../../../../server/workspace/requireWorkspace.ts";
import { AppError, toErrorResponse } from "../../../../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../../../server/features/flags.ts";
import { getLighthouseDetail } from "../../../../../../../../server/audit/results.ts";
import { buildLighthouseExportFile, LIGHTHOUSE_CATEGORIES } from "../../../../../../../../server/audit/lighthousePayload.ts";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ auditId: string; resultId: string }> | { auditId: string; resultId: string } };
export type AuditLighthouseExportRouteDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  getLighthouseDetail?: typeof getLighthouseDetail;
  downloadPayload?: (admin: any, path: string) => Promise<string>;
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
export async function GET(request: Request, context: Context, deps?: AuditLighthouseExportRouteDeps): Promise<Response> {
  try {
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey: new URL(request.url).searchParams.get("brand_key") ?? undefined }, deps);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("site_audit", workspace.brandKey))) throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    const { auditId, resultId } = await context.params;
    const url = new URL(request.url);
    const mode = (url.searchParams.get("mode") ?? "issues") as "full" | "issues" | "category";
    if (!["full", "issues", "category"].includes(mode)) throw new AppError(400, "invalid_request", "Enter a valid export mode.");
    const category = url.searchParams.get("category") as never;
    if (mode === "category" && !category) throw new AppError(400, "invalid_request", "Choose a category to export.");
    if (category && !(LIGHTHOUSE_CATEGORIES as readonly string[]).includes(category as string)) {
      throw new AppError(400, "invalid_request", "Enter a valid category.");
    }
    const detail = await (deps?.getLighthouseDetail ?? getLighthouseDetail)(workspace.admin, workspace.brandKey, auditId, resultId);
    let payloadJson: string;
    if (deps?.downloadPayload) {
      payloadJson = await deps.downloadPayload(workspace.admin, resultId);
    } else {
      payloadJson = JSON.stringify({
        version: 2,
        source: "dataforseo-lighthouse",
        hasIssueDetails: detail.hasIssueDetails,
        metadata: {
          requestedUrl: detail.finalUrl ?? "",
          finalUrl: detail.finalUrl ?? "",
          strategy: detail.strategy,
          fetchedAt: detail.createdAt,
          lighthouseVersion: null,
          taskId: null,
          cost: null,
        },
        scores: detail.scores,
        metrics: detail.metrics ?? {},
        issues: detail.issues,
      });
    }
    const file = buildLighthouseExportFile({
      idField: "resultId",
      idValue: resultId,
      finalUrl: detail.finalUrl ?? "",
      strategy: detail.strategy,
      createdAt: detail.createdAt,
      payloadJson,
      mode,
      category: category ?? undefined,
    });
    return new Response(file.content, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${file.filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof AppError) return toErrorResponse(err);
    return toErrorResponse(new AppError(503, "audit_unavailable", "Site audits are unavailable right now. Please retry.", { cause: err }));
  }
}
export async function POST(request: Request): Promise<Response> {
  return json({ error: "Method not allowed.", code: "method_not_allowed" }, 405);
}
