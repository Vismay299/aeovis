/**
 * F03 §6.5 — `POST /api/ops/costs/reconciliations/bulk`.
 *
 * Accepts the open unknown-cost backlog older than a cutoff. It resolves as
 * `accepted` only and never rewrites an amount, so it cannot be used to zero
 * spend — that stays one row at a time, and the database refuses it for a
 * probe attempt.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, jsonOk, readJsonBody, toErrorResponse } from "../../../../../../shared/http/errors.ts";
import { getSupabaseAdmin } from "../../../../../../shared/supabase/admin.js";
import { resolveUnknownCostBacklog } from "../../../../../../server/costs/ops.ts";
import { opsBulkBody } from "../../../../../../server/costs/ops.contract.ts";

export const dynamic = "force-dynamic";

export type BulkResolveRouteDeps = {
  getSupabaseAdmin?: () => SupabaseClient | null;
  resolveUnknownCostBacklog?: typeof resolveUnknownCostBacklog;
};

export async function POST(
  request: Request,
  deps: BulkResolveRouteDeps = {}
): Promise<Response> {
  try {
    const body = (await readJsonBody(request)) as Record<string, unknown>;
    const parsed = opsBulkBody.safeParse(body);
    if (!parsed.success) {
      const note = typeof body?.note === "string" ? body.note : "";
      if (note.length > 0 && note.length < 10) {
        throw new AppError(400, "note_required", "Add a note of at least 10 characters.");
      }
      throw new AppError(400, "invalid_request", "Check the highlighted fields and try again.");
    }

    const admin = (deps.getSupabaseAdmin ?? getSupabaseAdmin)();
    if (!admin) throw new AppError(503, "storage_unavailable", "Workspace storage is unavailable.");

    const resolved = await (deps.resolveUnknownCostBacklog ?? resolveUnknownCostBacklog)(admin, {
      beforeDays: parsed.data.beforeDays,
      note: parsed.data.note,
      by: "operator",
      limit: parsed.data.limit,
    });
    return jsonOk({ resolved });
  } catch (err) {
    return toErrorResponse(err);
  }
}
