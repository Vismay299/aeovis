import { ZodError } from "zod";
import { requireWorkspace } from "../../../../../../lib/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../../../lib/workspace/requireWorkspace.ts";
import { AppError, toErrorResponse } from "../../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../lib/features/flags.ts";
import { issuesQuery } from "../../../../../../lib/audit/siteAudit.contract.ts";
import { listAuditIssues } from "../../../../../../lib/audit/results.ts";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ auditId: string }> | { auditId: string } };
export type AuditIssuesRouteDeps = RequireWorkspaceDeps & { requireWorkspace?: typeof requireWorkspace; isFeatureEnabled?: typeof isFeatureEnabled; listAuditIssues?: typeof listAuditIssues };
function json(body: unknown): Response { return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } }); }
export async function GET(request: Request, context: Context, deps?: AuditIssuesRouteDeps): Promise<Response> {
  try {
    const raw: Record<string, string> = {}; for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
    const input = issuesQuery.parse(raw);
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey: new URL(request.url).searchParams.get("brand_key") ?? undefined }, deps);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("site_audit", workspace.brandKey))) throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    const { auditId } = await context.params;
    return json(await (deps?.listAuditIssues ?? listAuditIssues)(workspace.admin, workspace.brandKey, auditId, input));
  } catch (err) {
    if (err instanceof AppError || err instanceof ZodError) return toErrorResponse(err);
    return toErrorResponse(new AppError(503, "audit_unavailable", "Site audits are unavailable right now. Please retry.", { cause: err }));
  }
}
