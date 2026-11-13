// F06 phase 5 — GET /api/customer/scans/history (F06-AC-17, -18, -21).
//
// One response shape, no mode switch. When migration 066 has not been applied
// yet (production auto-deploys main and the migration may lag), the derived
// columns do not exist; fall back to the phase 2 list behaviour so the live
// Scans page keeps working. GET /api/customer/scan is untouched.
import {
  requireWorkspace,
  type RequireWorkspaceDeps,
} from "../../../../../lib/workspace/requireWorkspace.ts";
import { toErrorResponse, jsonOk, AppError } from "../../../../../lib/http/errors.ts";
import {
  isUndefinedColumnError,
  listScanHistory,
  listScanHistoryFallback,
  scanHistoryQuerySchema,
} from "../../../../../lib/scans/scanHistory.ts";

export const dynamic = "force-dynamic";

export type ScanHistoryRouteDeps = RequireWorkspaceDeps & {
  requireWorkspace?: typeof requireWorkspace;
  listScanHistory?: typeof listScanHistory;
  listScanHistoryFallback?: typeof listScanHistoryFallback;
};

export async function GET(
  request: Request,
  _ctx?: unknown,
  deps?: ScanHistoryRouteDeps,
): Promise<Response> {
  try {
    const { searchParams } = new URL(request.url);
    const workspace = await (deps?.requireWorkspace ?? requireWorkspace)(
      request,
      { brandKey: searchParams.get("brand_key") ?? undefined },
      deps,
    );

    const raw: Record<string, string> = {};
    for (const [key, value] of searchParams.entries()) {
      if (value !== "") raw[key] = value;
    }
    // `brand_key` selects the workspace; it is not a history filter.
    delete raw.brand_key;

    const parsed = scanHistoryQuerySchema.safeParse(raw);
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Invalid scan history query.", {
        details: {
          issues: parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        },
      });
    }

    const load = deps?.listScanHistory ?? listScanHistory;
    const fallback = deps?.listScanHistoryFallback ?? listScanHistoryFallback;

    let result: Awaited<ReturnType<typeof listScanHistory>>;
    try {
      result = await load(workspace.admin, workspace.brandKey, parsed.data);
    } catch (error) {
      if (!isUndefinedColumnError(error)) throw error;
      result = await fallback(workspace.admin, workspace.brandKey, parsed.data);
    }

    return jsonOk({ brand_key: workspace.brandKey, ...result });
  } catch (err) {
    return toErrorResponse(err);
  }
}
