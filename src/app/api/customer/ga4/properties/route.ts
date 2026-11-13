import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../lib/workspace/requireWorkspace.ts";
import { AppError } from "../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import { listPropertiesForUser } from "../../../../../lib/ga4/connection.ts";
import { getConnection } from "../../../../../lib/ga4/connection.ts";
import { ga4PropertiesQuery } from "../../../../../lib/ga4/ga4.contract.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type Ga4PropertiesRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  listPropertiesForUser?: typeof listPropertiesForUser;
  getConnection?: typeof getConnection;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function parseQuery(request: Request): { brand_key?: string } {
  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) raw[key] = value;
  const parsed = ga4PropertiesQuery.safeParse(raw);
  if (!parsed.success) throw new AppError(400, "invalid_request", "Invalid query parameters.");
  return parsed.data;
}

export async function GET(request: Request, _ctx?: unknown, deps?: Ga4PropertiesRouteDeps): Promise<Response> {
  try {
    const query = parseQuery(request);
    const workspace = await requireWorkspace(request, { brandKey: query.brand_key, role: "owner" }, deps);

    const featureCheck = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await featureCheck("ga4", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }

    const connGetter = deps?.getConnection ?? getConnection;
    const conn = await connGetter(workspace.admin, workspace.brandKey);

    const lister = deps?.listPropertiesForUser ?? listPropertiesForUser;
    const result = await lister(workspace.admin, workspace.user.id, conn?.property_id, {
      fetchImpl: undefined,
    });

    return json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
