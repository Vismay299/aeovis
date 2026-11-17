import { z, ZodError } from "zod";
import { requireWorkspace } from "../../../../../../server/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps, Workspace } from "../../../../../../server/workspace/requireWorkspace.ts";
import { AppError, toErrorResponse } from "../../../../../../shared/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../server/features/flags.ts";
import { crawlerAccessQuery } from "../../../../../../server/audit/siteAudit.contract.ts";
import { deleteCrawlerCredential } from "../../../../../../server/audit/crawlerAccess.ts";

export const dynamic = "force-dynamic";

const FEATURE_OFF = "This page is not available for your workspace yet.";
const FEATURE_DISABLED = "This feature is not enabled for your workspace.";
const OWNER_REQUIRED = "Only the workspace owner can manage Shopify crawler access.";
const CREDENTIAL_NOT_FOUND = "Crawler access not found.";

export type CrawlerAccessItemDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  isFeatureEnabled?: typeof isFeatureEnabled;
  deleteCrawlerCredential?: typeof deleteCrawlerCredential;
  env?: Record<string, string | undefined>;
};

type Context = { params: Promise<{ id: string }> | { id: string } };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function errors(err: unknown): Response {
  if (err instanceof AppError || err instanceof ZodError) return toErrorResponse(err);
  return toErrorResponse(
    new AppError(503, "audit_unavailable", "Site audits are unavailable right now. Please retry.", {
      cause: err,
    }),
  );
}

async function authorize(
  request: Request,
  brandKey: string | undefined,
  deps?: CrawlerAccessItemDeps,
): Promise<Workspace> {
  const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
    request,
    { brandKey },
    deps,
  );
  const enabled = deps?.isFeatureEnabled ?? isFeatureEnabled;
  if (!(await enabled("site_audit", workspace.brandKey))) {
    throw new AppError(404, "feature_unavailable", FEATURE_OFF);
  }
  if (!(await enabled("site_audit_crawler_access", workspace.brandKey))) {
    throw new AppError(403, "feature_disabled", FEATURE_DISABLED);
  }
  if (workspace.role !== "owner") {
    throw new AppError(403, "owner_required", OWNER_REQUIRED);
  }
  return workspace;
}

export async function DELETE(
  request: Request,
  context: Context,
  deps?: CrawlerAccessItemDeps,
): Promise<Response> {
  try {
    const raw = Object.fromEntries(new URL(request.url).searchParams.entries());
    const input = crawlerAccessQuery.parse(raw);
    const workspace = await authorize(request, input.brand_key, deps);
    const { id } = await context.params;
    // A malformed id is indistinguishable from a missing one at this boundary.
    if (!z.uuid().safeParse(id).success) {
      throw new AppError(404, "credential_not_found", CREDENTIAL_NOT_FOUND);
    }
    const deleted = await (deps?.deleteCrawlerCredential ?? deleteCrawlerCredential)(
      workspace.admin,
      workspace.brandKey,
      id,
    );
    if (!deleted) throw new AppError(404, "credential_not_found", CREDENTIAL_NOT_FOUND);
    return json({ deleted: true });
  } catch (err) {
    return errors(err);
  }
}
