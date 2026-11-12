import { ZodError } from "zod";
import { requireWorkspace } from "../../../../../../lib/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../../../lib/workspace/requireWorkspace.ts";
import { AppError, readJsonBody, toErrorResponse } from "../../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../lib/features/flags.ts";
import { cancelBody } from "../../../../../../lib/audit/siteAudit.contract.ts";
import { cancelAudit } from "../../../../../../lib/audit/service.ts";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ auditId: string }> | { auditId: string } };
export type AuditCancelRouteDeps = RequireWorkspaceDeps & { requireWorkspace?: typeof requireWorkspace; isFeatureEnabled?: typeof isFeatureEnabled; cancelAudit?: typeof cancelAudit };
function json(body: unknown, status = 200): Response { return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
export async function POST(request: Request, context: Context, deps?: AuditCancelRouteDeps): Promise<Response> {
  try {
    const input = cancelBody.parse(await readJsonBody(request));
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey: input.brand_key }, deps);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("site_audit", workspace.brandKey))) throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    const { auditId } = await context.params;
    const result = await (deps?.cancelAudit ?? cancelAudit)(workspace.admin, workspace.brandKey, auditId);
    return json(result, result.status === "cancelling" ? 202 : 200);
  } catch (err) {
    if (err instanceof AppError || err instanceof ZodError) return toErrorResponse(err);
    return toErrorResponse(new AppError(503, "audit_unavailable", "Site audits are unavailable right now. Please retry.", { cause: err }));
  }
}
