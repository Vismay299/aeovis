import { requireWorkspace, type RequireWorkspaceDeps } from "../../../../../lib/workspace/requireWorkspace.ts";
import { AppError } from "../../../../../lib/http/appError.ts";
import { toErrorResponse } from "../../../../../lib/http/errors.ts";
import { isFeatureEnabled } from "../../../../../lib/features/flags.ts";
import { getMeasurementHealth } from "../../../../../lib/ga4/measurementHealth.ts";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const healthQuery = z.strictObject({
  brand_key: z.string().optional(),
});

export type Ga4HealthRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  getMeasurementHealth?: typeof getMeasurementHealth;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function toGa4ErrorResponse(err: unknown): Response {
  const res = toErrorResponse(err);
  const retryAfter =
    err instanceof AppError &&
    err.details &&
    typeof err.details === "object" &&
    typeof (err.details as Record<string, unknown>).retryAfterSeconds === "number"
      ? (err.details as Record<string, unknown>).retryAfterSeconds as number
      : null;
  if (res.status === 429 && typeof retryAfter === "number" && Number.isFinite(retryAfter)) {
    const capped = Math.min(Math.max(Math.ceil(retryAfter), 0), 86400);
    const headers = new Headers(res.headers);
    headers.set("Retry-After", String(capped));
    return new Response(res.body, { status: res.status, headers });
  }
  return res;
}

export async function GET(request: Request, _ctx?: unknown, deps?: Ga4HealthRouteDeps): Promise<Response> {
  try {
    const url = new URL(request.url);
    const raw: Record<string, string> = {};
    for (const [k, v] of url.searchParams.entries()) raw[k] = v;
    const parsed = healthQuery.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Invalid query parameters.");
    }
    const q = parsed.data;
    const workspace = await requireWorkspace(request, { brandKey: q.brand_key }, deps);
    const featureCheck = deps?.isFeatureEnabled ?? isFeatureEnabled;
    if (!(await featureCheck("ga4", workspace.brandKey))) {
      throw new AppError(404, "feature_unavailable", "This page is not available for your workspace yet.");
    }
    const fn = deps?.getMeasurementHealth ?? getMeasurementHealth;
    const result = await fn(workspace.admin, { brandKey: workspace.brandKey, user: workspace.user, role: workspace.role });
    return json(result);
  } catch (err) {
    return toGa4ErrorResponse(err);
  }
}