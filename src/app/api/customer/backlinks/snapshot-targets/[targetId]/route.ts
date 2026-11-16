import { AppError } from "../../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../../lib/features/flags.ts";
import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../../lib/workspace/requireWorkspace.ts";
import { backlinksBrandQuery } from "../../../../../../lib/backlinks/backlinks.contract.ts";
import { deleteSnapshotTarget } from "../../../../../../lib/backlinks/snapshots.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Context = { params: Promise<{ targetId: string }> | { targetId: string } };
export type SnapshotTargetDeleteRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  deleteSnapshotTarget?: typeof deleteSnapshotTarget;
};

function brandKey(request: Request): string | undefined {
  const raw: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
  const parsed = backlinksBrandQuery.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "invalid_request", "Check the query and try again.");
  return parsed.data.brand_key;
}

export async function DELETE(request: Request, ctx: Context, deps?: SnapshotTargetDeleteRouteDeps): Promise<Response> {
  try {
    const workspace = await requireWorkspace(request, { brandKey: brandKey(request), role: "owner" }, deps);
    const flag = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await flag("backlinks", workspace.brandKey)) || !(await flag("backlink_snapshots", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    const { targetId } = await ctx.params;
    if (!targetId || targetId.length > 64) throw new AppError(404, "snapshot_target_not_found", "This tracked target does not exist.");
    await (deps?.deleteSnapshotTarget ?? deleteSnapshotTarget)(workspace.admin, workspace.brandKey, targetId);
    return Response.json({ deleted: true }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
