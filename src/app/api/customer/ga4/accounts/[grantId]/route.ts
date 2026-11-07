import { z } from "zod";
import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../../lib/workspace/requireWorkspace.ts";
import { AppError } from "../../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../lib/features/flags.ts";
import { getGrant } from "../../../../../../lib/ga4/grants.ts";
import { removeGoogleAccount } from "../../../../../../lib/ga4/accounts.ts";
import { ga4AccountDeleteRequest } from "../../../../../../lib/ga4/ga4.contract.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const grantIdSchema = z.string().regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, "Invalid grant ID format.");

export type Ga4AccountDeleteRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  getGrant?: typeof getGrant;
  removeGoogleAccount?: typeof removeGoogleAccount;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function DELETE(
  request: Request,
  ctx?: { params?: Promise<{ grantId?: string }> | { grantId?: string } } | unknown,
  deps?: Ga4AccountDeleteRouteDeps,
): Promise<Response> {
  try {
    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      rawBody = {};
    }

    const parsedBody = ga4AccountDeleteRequest.safeParse(rawBody);
    if (!parsedBody.success) {
      throw new AppError(400, "invalid_request", "Check the request parameters and try again.");
    }

    // Resolve route param
    const resolvedParams = ctx && typeof ctx === "object" && "params" in ctx
      ? (ctx.params instanceof Promise ? await ctx.params : ctx.params)
      : undefined;
    const rawGrantId = resolvedParams?.grantId;
    const parsedGrantId = grantIdSchema.safeParse(rawGrantId);
    if (!parsedGrantId.success) {
      throw new AppError(400, "invalid_request", "Invalid grant ID format.");
    }
    const grantId = parsedGrantId.data;

    const workspace = await requireWorkspace(
      request,
      { brandKey: parsedBody.data.brand_key },
      deps,
    );

    const featureCheck = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await featureCheck("ga4", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }

    const grantGetter = deps?.getGrant ?? getGrant;
    const grant = await grantGetter(workspace.admin, grantId, workspace.user.id);
    if (!grant) {
      throw new AppError(404, "ga4_grant_not_found", "That Google account isn't linked to your Perceev account.");
    }

    const accountRemover = deps?.removeGoogleAccount ?? removeGoogleAccount;
    const result = await accountRemover(workspace.admin, workspace.user.id, grantId);

    return json({
      removed: result.removed,
      workspacesDisconnected: result.workspacesDisconnected,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
