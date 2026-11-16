import { AppError } from "../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../lib/workspace/requireWorkspace.ts";
import { snapshotsQuery } from "../../../../../lib/backlinks/backlinks.contract.ts";
import { listSnapshots } from "../../../../../lib/backlinks/snapshots.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export type SnapshotsRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  listSnapshots?: typeof listSnapshots;
};

function query(request: Request) {
  const raw: Record<string, string> = {};
  for (const [key, value] of new URL(request.url).searchParams) raw[key] = value;
  const parsed = snapshotsQuery.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "invalid_request", "Check the query and try again.");
  return parsed.data;
}

export async function GET(request: Request, _ctx?: unknown, deps?: SnapshotsRouteDeps): Promise<Response> {
  try {
    const input = query(request);
    const workspace = await requireWorkspace(request, { brandKey: input.brand_key }, deps);
    const checkFlag = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await checkFlag("backlinks", workspace.brandKey)) || !(await checkFlag("backlink_snapshots", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    const snapshots = await (deps?.listSnapshots ?? listSnapshots)(workspace.admin, {
      brandKey: workspace.brandKey,
      target: input.target,
      scope: input.scope,
    });
    return Response.json({ snapshots }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    return toErrorResponse(err);
  }
}
