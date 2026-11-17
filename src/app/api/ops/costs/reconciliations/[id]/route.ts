/**
 * F03 §6.5 — `POST /api/ops/costs/reconciliations/[id]`.
 *
 * Resolves one open reconciliation. It never changes a ledger amount:
 * `accepted` and `price_updated` close the question, and `not_billed` zeroes a
 * row that was never a paid call — and the database refuses that for a probe
 * attempt, which is reconciled from Measurement operations instead.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, jsonOk, readJsonBody, toErrorResponse } from "../../../../../../shared/http/errors.ts";
import { getSupabaseAdmin } from "../../../../../../shared/supabase/admin.js";
import { resolveReconciliation } from "../../../../../../server/costs/ops.ts";
import { opsResolveBody } from "../../../../../../server/costs/ops.contract.ts";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export type ResolveReconciliationRouteDeps = {
  getSupabaseAdmin?: () => SupabaseClient | null;
  resolveReconciliation?: typeof resolveReconciliation;
};

export async function POST(
  request: Request,
  context: RouteContext,
  deps: ResolveReconciliationRouteDeps = {}
): Promise<Response> {
  try {
    const params = await context.params;
    const id = params?.id;
    if (!id) throw new AppError(400, "invalid_request", "The reconciliation id is required.");

    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const parsed = opsResolveBody.safeParse(body);
    if (!parsed.success) {
      // A short note has its own code: the database refuses it the same way.
      const note = typeof body?.note === "string" ? body.note : "";
      if (note.length > 0 && note.length < 10) {
        throw new AppError(400, "note_required", "Add a note of at least 10 characters.");
      }
      throw new AppError(400, "invalid_request", "Check the highlighted fields and try again.");
    }

    const admin = (deps.getSupabaseAdmin ?? getSupabaseAdmin)();
    if (!admin) throw new AppError(503, "storage_unavailable", "Workspace storage is unavailable.");

    await (deps.resolveReconciliation ?? resolveReconciliation)(
      admin,
      id,
      parsed.data.resolution,
      parsed.data.note
    );
    return jsonOk({ resolved: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
