import { requireWorkspace } from "../../../../../lib/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../../lib/workspace/requireWorkspace.ts";
import { AppError, toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import { getAuditStatus, deleteAudit } from "../../../../../lib/audit/service.ts";
import { getOwnedAudit } from "../../../../../lib/audit/results.ts";
import { reconcileRunningAudit } from "../../../../../lib/audit/reconcile.ts";

export const dynamic = "force-dynamic";
const FEATURE_OFF = "This page is not available for your workspace yet.";
type Context = { params: Promise<{ auditId: string }> | { auditId: string } };
export type AuditItemDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  getAuditStatus?: typeof getAuditStatus;
  deleteAudit?: typeof deleteAudit;
  getOwnedAudit?: typeof getOwnedAudit;
  reconcileRunningAudit?: typeof reconcileRunningAudit;
};
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
function queryBrandKey(request: Request): string | undefined { const value = new URL(request.url).searchParams.get("brand_key"); if (value !== null && value.length > 200) throw new AppError(400, "invalid_request", "Check the query and try again."); return value ?? undefined; }
async function loadWorkspace(request: Request, deps?: AuditItemDeps) {
  const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey: queryBrandKey(request) }, deps);
  if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("site_audit", workspace.brandKey))) throw new AppError(404, "feature_unavailable", FEATURE_OFF);
  return workspace;
}
export async function GET(request: Request, context: Context, deps?: AuditItemDeps): Promise<Response> {
  try {
    const workspace = await loadWorkspace(request, deps);
    const { auditId } = await context.params;
    const row = await (deps?.getOwnedAudit ?? getOwnedAudit)(workspace.admin, workspace.brandKey, auditId);
    if (row.status === "queued" || row.status === "running") await (deps?.reconcileRunningAudit ?? reconcileRunningAudit)(row, { admin: workspace.admin });
    return json(await (deps?.getAuditStatus ?? getAuditStatus)(workspace.admin, workspace.brandKey, auditId));
  } catch (err) {
    if (err instanceof AppError) return toErrorResponse(err);
    return toErrorResponse(new AppError(503, "audit_unavailable", "Site audits are unavailable right now. Please retry.", { cause: err }));
  }
}
export async function DELETE(request: Request, context: Context, deps?: AuditItemDeps): Promise<Response> {
  try {
    const workspace = await loadWorkspace(request, deps);
    const { auditId } = await context.params;
    return json(await (deps?.deleteAudit ?? deleteAudit)(workspace.admin, workspace.brandKey, auditId, workspace.user.id, workspace.role));
  } catch (err) {
    if (err instanceof AppError) return toErrorResponse(err);
    return toErrorResponse(new AppError(503, "audit_unavailable", "Site audits are unavailable right now. Please retry.", { cause: err }));
  }
}
