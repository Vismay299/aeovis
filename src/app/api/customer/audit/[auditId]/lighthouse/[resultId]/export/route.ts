import { requireWorkspace } from "../../../../../../../../lib/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../../../../../lib/workspace/requireWorkspace.ts";
import { AppError, toErrorResponse } from "../../../../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../../../lib/features/flags.ts";
import { getLighthouseDetail } from "../../../../../../../../lib/audit/results.ts";
import { buildLighthouseExportFile } from "../../../../../../../../lib/audit/lighthousePayload.ts";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ auditId: string; resultId: string }> | { auditId: string; resultId: string } };
export async function GET(request: Request, context: Context, deps?: any): Promise<Response> {
  try {
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey: new URL(request.url).searchParams.get("brand_key") ?? undefined }, deps);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("site_audit", workspace.brandKey))) throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    const { auditId, resultId } = await context.params;
    const mode = (new URL(request.url).searchParams.get("mode") ?? "issues") as any;
    const detail = await (deps?.getLighthouseDetail ?? getLighthouseDetail)(workspace.admin, workspace.brandKey, auditId, resultId);
    const file = buildLighthouseExportFile({ idField: "resultId", idValue: resultId, finalUrl: detail.finalUrl ?? "", strategy: detail.strategy, createdAt: detail.createdAt, payloadJson: JSON.stringify({ version:2, source:"dataforseo-lighthouse", hasIssueDetails: detail.hasIssueDetails, metadata:{ requestedUrl: detail.finalUrl ?? "", finalUrl: detail.finalUrl ?? "", strategy: detail.strategy, fetchedAt: detail.createdAt, lighthouseVersion: null, taskId: null, cost: null }, scores: detail.scores, metrics: detail.metrics ?? {}, issues: detail.issues }), mode });
    return new Response(file.content, { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename=\"${file.filename}\"`, "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof AppError) return toErrorResponse(err);
    return toErrorResponse(new AppError(503, "audit_unavailable", "Site audits are unavailable right now. Please retry.", { cause: err }));
  }
}