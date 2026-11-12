import { ZodError } from "zod";
import { requireWorkspace } from "../../../../lib/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../lib/workspace/requireWorkspace.ts";
import { AppError, readJsonBody, toErrorResponse } from "../../../../lib/http/errors.ts";
import { isCallOutcomeError } from "../../../../lib/spend/errors.ts";
import { isFeatureEnabled } from "../../../../lib/features/flags.ts";
import { auditListQuery, startAuditBody } from "../../../../lib/audit/siteAudit.contract.ts";
import { listAudits, startSiteAudit } from "../../../../lib/audit/service.ts";
import type { StartDeps } from "../../../../lib/audit/service.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 30;
const FEATURE_OFF = "This page is not available for your workspace yet.";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function query(request: Request) {
  const raw: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
  return auditListQuery.parse(raw);
}
function errors(err: unknown): Response {
  if (err instanceof AppError || err instanceof ZodError || isCallOutcomeError(err)) return toErrorResponse(err);
  return toErrorResponse(new AppError(503, "audit_unavailable", "Site audits are unavailable right now. Please retry.", { cause: err }));
}

export type AuditCollectionDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  listAudits?: typeof listAudits;
  startSiteAudit?: typeof startSiteAudit;
  env?: Record<string, string | undefined>;
  startDeps?: StartDeps;
};

export async function GET(request: Request, _context?: unknown, deps?: AuditCollectionDeps): Promise<Response> {
  try {
    const input = query(request);
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey: input.brand_key }, deps);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("site_audit", workspace.brandKey))) throw new AppError(404, "feature_unavailable", FEATURE_OFF);
    return json(await (deps?.listAudits ?? listAudits)(workspace.admin, workspace.brandKey, input.limit, deps?.env ?? process.env, workspace.brand.website));
  } catch (err) { return errors(err); }
}

export async function POST(request: Request, _context?: unknown, deps?: AuditCollectionDeps): Promise<Response> {
  try {
    const body = startAuditBody.parse(await readJsonBody(request));
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey: body.brand_key }, deps);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("site_audit", workspace.brandKey))) throw new AppError(404, "feature_unavailable", FEATURE_OFF);
    const result = await (deps?.startSiteAudit ?? startSiteAudit)(workspace, body, deps?.startDeps ?? { env: deps?.env });
    return json(result, 202);
  } catch (err) { return errors(err); }
}
