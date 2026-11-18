/**
 * F23 §6.5 — `POST /api/customer/reports/generate`.
 *
 * Starts an assistant session on a template. The flags, the template read and
 * the session create all live in `startReportGeneration`; this route only
 * adapts the wire shape.
 */

import { toErrorResponse, readOptionalJsonBody } from "../../../../../shared/http/errors.ts";
import { requireWorkspace } from "../../../../../server/workspace/requireWorkspace.ts";
import type { RequireWorkspaceDeps } from "../../../../../server/workspace/requireWorkspace.ts";
import { isFeatureEnabled } from "../../../../../server/features/flags.ts";
import { startReportGeneration } from "../../../../../server/reports/generate.ts";
import { generateBodySchema } from "../../../../../server/reports/reports.contract.ts";

export const dynamic = "force-dynamic";

export type ReportsGenerateRouteDeps = RequireWorkspaceDeps & {
  isFeatureEnabled?: typeof isFeatureEnabled;
  startReportGeneration?: typeof startReportGeneration;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export async function POST(request: Request, _ctx?: unknown, deps?: ReportsGenerateRouteDeps): Promise<Response> {
  try {
    const body = await readOptionalJsonBody(request);
    const parsed = generateBodySchema.safeParse(body);
    if (!parsed.success) return toErrorResponse(parsed.error);
    const workspace = await requireWorkspace(request, { brandKey: parsed.data.brand_key }, deps);
    const result = await (deps?.startReportGeneration ?? startReportGeneration)(
      workspace,
      { templateId: parsed.data.templateId },
      deps ? { isFeatureEnabled: deps.isFeatureEnabled } : undefined,
    );
    return json({ sessionId: result.sessionId, path: result.path }, 201);
  } catch (err) {
    return toErrorResponse(err);
  }
}
