import { requireWorkspace } from "../../../../../../../server/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../../../../server/workspace/requireWorkspace.ts";
import { AppError, toErrorResponse } from "../../../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../../server/features/flags.ts";
import { getLighthouseDetail } from "../../../../../../../server/audit/results.ts";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ auditId: string; resultId: string }> | { auditId: string; resultId: string } };
export type AuditLighthouseDetailRouteDeps = RequireWorkspaceDeps & { requireWorkspace?: typeof requireWorkspace; isFeatureEnabled?: typeof isFeatureEnabled; getLighthouseDetail?: typeof getLighthouseDetail };
function json(body: unknown): Response { return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
export async function GET(request: Request, context: Context, deps?: AuditLighthouseDetailRouteDeps): Promise<Response> {
  try {
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey: new URL(request.url).searchParams.get("brand_key") ?? undefined }, deps);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("site_audit", workspace.brandKey))) throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    const { auditId, resultId } = await context.params;
    return json(await (deps?.getLighthouseDetail ?? getLighthouseDetail)(workspace.admin, workspace.brandKey, auditId, resultId));
  } catch (err) {
    if (err instanceof AppError) return toErrorResponse(err);
    return toErrorResponse(new AppError(503, "audit_unavailable", "Site audits are unavailable right now. Please retry.", { cause: err }));
  }
}