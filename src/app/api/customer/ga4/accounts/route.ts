import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../lib/workspace/requireWorkspace.ts";
import { AppError } from "../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import { listGrantsForUser } from "../../../../../lib/ga4/grants.ts";
import { ga4AccountsQuery } from "../../../../../lib/ga4/ga4.contract.ts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export type Ga4AccountsRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  listGrantsForUser?: typeof listGrantsForUser;
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

function parseQuery(request: Request): { brand_key?: string } {
  const url = new URL(request.url);
  const raw: Record<string, string> = {};
  for (const [key, value] of url.searchParams.entries()) {
    raw[key] = value;
  }
  const parsed = ga4AccountsQuery.safeParse(raw);
  if (!parsed.success) {
    throw new AppError(400, "invalid_request", "Invalid query parameters.");
  }
  return parsed.data;
}

export async function GET(
  request: Request,
  _ctx?: unknown,
  deps?: Ga4AccountsRouteDeps,
): Promise<Response> {
  try {
    const query = parseQuery(request);
    const workspace = await requireWorkspace(request, { brandKey: query.brand_key }, deps);

    const featureCheck = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await featureCheck("ga4", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }

    const grantLister = deps?.listGrantsForUser ?? listGrantsForUser;
    let accounts: any[] = [];
    try {
      accounts = await grantLister(workspace.admin, workspace.user.id);
    } catch {
      throw new AppError(503, "ga4_unavailable", "Google Analytics accounts are unavailable right now. Please retry.");
    }

    return json({ accounts });
  } catch (err) {
    return toErrorResponse(err);
  }
}
