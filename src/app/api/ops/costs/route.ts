/**
 * F03 §6.5 — `GET /api/ops/costs`.
 *
 * The operator's cost view: spend by workspace, estimate accuracy by endpoint,
 * the open holds, the open reconciliation queue and the typical cost per
 * engine. The operator token is checked by the `/api` perimeter, not here, so
 * this route never reads a credential.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, jsonOk, toErrorResponse } from "../../../../lib/http/errors.ts";
import { getSupabaseAdmin } from "../../../../lib/supabase/admin.js";
import { getOperatorCosts } from "../../../../lib/costs/ops.ts";
import { opsCostsQuery } from "../../../../lib/costs/ops.contract.ts";

export const dynamic = "force-dynamic";

export type OperatorCostsRouteDeps = {
  getSupabaseAdmin?: () => SupabaseClient | null;
  getOperatorCosts?: typeof getOperatorCosts;
};

/** The widest window the view may ask for. */
const MAX_RANGE_DAYS = 400;
const DEFAULT_RANGE_DAYS = 30;

export async function GET(request: Request, deps: OperatorCostsRouteDeps = {}): Promise<Response> {
  try {
    const parsed = opsCostsQuery.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) {
      throw new AppError(400, "invalid_request", "Check the query and try again.");
    }
    const to = parsed.data.to ? new Date(parsed.data.to) : new Date();
    const from = parsed.data.from
      ? new Date(parsed.data.from)
      : new Date(to.getTime() - DEFAULT_RANGE_DAYS * 24 * 60 * 60 * 1000);
    if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * 24 * 60 * 60 * 1000) {
      throw new AppError(400, "invalid_range", "Choose a range of 400 days or less.");
    }

    const admin = (deps.getSupabaseAdmin ?? getSupabaseAdmin)();
    if (!admin) throw new AppError(503, "storage_unavailable", "Workspace storage is unavailable.");

    const costs = await (deps.getOperatorCosts ?? getOperatorCosts)(admin, { from, to });
    return jsonOk(costs);
  } catch (err) {
    return toErrorResponse(err);
  }
}
