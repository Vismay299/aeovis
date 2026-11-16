import { z, ZodError } from "zod";
import { requireWorkspace } from "../../../../../lib/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../../lib/workspace/requireWorkspace.ts";
import { AppError, toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import { getAuditCompare } from "../../../../../lib/audit/compare.ts";

export const dynamic = "force-dynamic";

const compareQuery = z.strictObject({
  base: z.uuid(),
  head: z.uuid(),
  brand_key: z.string().max(200).optional(),
});

export type AuditCompareRouteDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  getAuditCompare?: typeof getAuditCompare;
};

export async function GET(request: Request, _ctx?: unknown, deps?: AuditCompareRouteDeps): Promise<Response> {
  try {
    const params = Object.fromEntries(new URL(request.url).searchParams.entries());
    const input = compareQuery.parse(params);
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(request, { brandKey: input.brand_key }, deps);
    if (!(await (deps?.isFeatureEnabled ?? isFeatureEnabled)("site_audit", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    return new Response(JSON.stringify(await (deps?.getAuditCompare ?? getAuditCompare)(
      workspace.admin,
      workspace.brandKey,
      input.base,
      input.head,
    )), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof AppError || err instanceof ZodError) return toErrorResponse(err);
    return toErrorResponse(new AppError(503, "audit_unavailable", "Site audits are unavailable right now. Please retry.", { cause: err }));
  }
}
