/**
 * F23 §6.5 — `POST /api/customer/reports/generate`.
 *
 * Starts an assistant session on a template. The flags, the template read and
 * the session create all live in `startReportGeneration`; this route only
 * adapts the wire shape.
 */

import { jsonOk, readOptionalJsonBody, toErrorResponse } from "../../../../../shared/http/errors.ts";
import { requireWorkspace } from "../../../../../server/workspace/requireWorkspace.ts";
import { startReportGeneration } from "../../../../../server/reports/generate.ts";
import type { ReportsRouteDeps } from "../../../../../server/reports/routeKit.ts";
import { generateBodySchema } from "../../../../../server/reports/reports.contract.ts";

export const dynamic = "force-dynamic";

export type ReportsGenerateRouteDeps = ReportsRouteDeps & {
  startReportGeneration?: typeof startReportGeneration;
};

export async function POST(request: Request, _ctx?: unknown, deps?: ReportsGenerateRouteDeps): Promise<Response> {
  try {
    const body = await readOptionalJsonBody(request);
    const parsed = generateBodySchema.safeParse(body);
    if (!parsed.success) return toErrorResponse(parsed.error);
    // The service owns the flag rules (`reports`, `report_generate`, `assistant`).
    const workspace = await requireWorkspace(request, { brandKey: parsed.data.brand_key }, deps);
    const result = await (deps?.startReportGeneration ?? startReportGeneration)(
      workspace,
      { templateId: parsed.data.templateId },
      deps?.isFeatureEnabled ? { isFeatureEnabled: deps.isFeatureEnabled } : undefined,
    );
    return jsonOk({ sessionId: result.sessionId, path: result.path }, 201);
  } catch (err) {
    return toErrorResponse(err);
  }
}
