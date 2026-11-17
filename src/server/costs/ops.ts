/**
 * F03 §6.2 — the operator's cost view.
 *
 * Everything here is operator-only data: estimate accuracy, the reconciliation
 * queue and the engine statistics. A customer never reads any of it, so every
 * read goes through the service role and the `/api/ops/*` perimeter.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../../shared/http/appError.ts";
import { PRICE_TABLE_VERSION } from "../../shared/pricing/version.ts";

export type OperatorWorkspaceCost = {
  brandKey: string;
  feature: string;
  accountedUsd: number;
  knownUsd: number;
  unknownUsd: number;
  calls: number;
  openReconciliations: number;
};

export type OperatorEndpointCost = {
  provider: string;
  endpoint: string;
  calls: number;
  estimateUsd: number;
  actualUsd: number;
  unknownCalls: number;
  undershoots: number;
  maxRatio: number | null;
};

export type OperatorHold = {
  holdId: string;
  brandKey: string;
  feature: string;
  estimateUsd: number;
  createdAt: string;
  expiresAt: string;
  subjectKind: string | null;
  subjectId: string | null;
};

export type OperatorReconciliation = {
  id: string;
  brandKey: string;
  feature: string;
  provider: string;
  endpoint: string;
  kind: string;
  estimateUsd: number | null;
  actualUsd: number | null;
  priceVersion: string | null;
  createdAt: string;
  /** A probe attempt is reconciled from Measurement operations, not here. */
  isProbe: boolean;
};

export type OperatorEngineStat = {
  engine: string;
  samples: number;
  medianUsd: number | null;
  p90Usd: number | null;
};

export type OperatorCosts = {
  byWorkspace: OperatorWorkspaceCost[];
  byEndpoint: OperatorEndpointCost[];
  openHolds: OperatorHold[];
  reconciliations: OperatorReconciliation[];
  engineStats: OperatorEngineStat[];
  priceVersion: string;
};

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function instant(value: unknown): string {
  return new Date(String(value)).toISOString();
}

/** The ledger rows behind the open queue that are probe attempts. */
async function probeLedgerIds(
  admin: SupabaseClient,
  reconciliations: Record<string, unknown>[]
): Promise<Set<string>> {
  const ledgerIds = reconciliations
    .map((row) => (row.ledger_id === null || row.ledger_id === undefined ? null : String(row.ledger_id)))
    .filter((value): value is string => value !== null);
  if (ledgerIds.length === 0) return new Set<string>();
  const { data, error } = await admin
    .from("spend_ledger")
    .select("id, source_ref")
    .in("id", ledgerIds);
  if (error) throw error;
  const probes = new Set<string>();
  for (const row of (data ?? []) as Record<string, unknown>[]) {
    if (String(row.source_ref ?? "").startsWith("probe_attempt:")) probes.add(String(row.id));
  }
  return probes;
}

/**
 * The whole operator cost view for a window: spend per workspace, estimate
 * accuracy per endpoint, the open holds, the open reconciliation queue and the
 * typical cost per engine.
 */
export async function getOperatorCosts(
  admin: SupabaseClient,
  opts: { from: Date; to: Date }
): Promise<OperatorCosts> {
  const { data: workspaceRows, error: workspaceError } = await admin.rpc("operator_costs_by_workspace", {
    p_from: opts.from.toISOString(),
    p_to: opts.to.toISOString(),
  });
  if (workspaceError) throw workspaceError;

  const { data: endpointRows, error: endpointError } = await admin.rpc("operator_costs_by_endpoint", {
    p_from: opts.from.toISOString(),
    p_to: opts.to.toISOString(),
  });
  if (endpointError) throw endpointError;

  const { data: holdRows, error: holdError } = await admin
    .from("spend_holds")
    .select("id, brand_key, feature, estimate_usd, created_at, expires_at, subject_kind, subject_id")
    .eq("status", "held")
    .order("created_at", { ascending: true })
    .limit(200);
  if (holdError) throw holdError;

  const { data: reconciliationRows, error: reconciliationError } = await admin
    .from("cost_reconciliations")
    .select("id, ledger_id, brand_key, feature, provider, endpoint, kind, estimate_usd, actual_usd, price_version, created_at")
    .is("resolution", null)
    .order("created_at", { ascending: true })
    .limit(200);
  if (reconciliationError) throw reconciliationError;

  const probeIds = await probeLedgerIds(admin, reconciliationRows ?? []);

  const { data: engineRows, error: engineError } = await admin.rpc("engine_cost_stats", { p_days: 30 });
  if (engineError) throw engineError;

  return {
    byWorkspace: ((workspaceRows ?? []) as Record<string, unknown>[]).map((row) => ({
      brandKey: String(row.brand_key),
      feature: String(row.feature),
      accountedUsd: number(row.accounted_usd),
      knownUsd: number(row.known_usd),
      unknownUsd: number(row.unknown_usd),
      calls: number(row.calls),
      openReconciliations: number(row.open_reconciliations),
    })),
    byEndpoint: ((endpointRows ?? []) as Record<string, unknown>[]).map((row) => ({
      provider: String(row.provider),
      endpoint: String(row.endpoint),
      calls: number(row.calls),
      estimateUsd: number(row.estimate_usd),
      actualUsd: number(row.actual_usd),
      unknownCalls: number(row.unknown_calls),
      undershoots: number(row.undershoots),
      maxRatio: nullableNumber(row.max_ratio),
    })),
    openHolds: ((holdRows ?? []) as Record<string, unknown>[]).map((row) => ({
      holdId: String(row.id),
      brandKey: String(row.brand_key),
      feature: String(row.feature),
      estimateUsd: number(row.estimate_usd),
      createdAt: instant(row.created_at),
      expiresAt: instant(row.expires_at),
      subjectKind: row.subject_kind === null || row.subject_kind === undefined ? null : String(row.subject_kind),
      subjectId: row.subject_id === null || row.subject_id === undefined ? null : String(row.subject_id),
    })),
    reconciliations: ((reconciliationRows ?? []) as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      brandKey: String(row.brand_key),
      feature: String(row.feature),
      provider: String(row.provider),
      endpoint: String(row.endpoint),
      kind: String(row.kind),
      estimateUsd: nullableNumber(row.estimate_usd),
      actualUsd: nullableNumber(row.actual_usd),
      priceVersion: row.price_version === null || row.price_version === undefined ? null : String(row.price_version),
      createdAt: instant(row.created_at),
      isProbe: probeIds.has(String(row.ledger_id)),
    })),
    engineStats: ((engineRows ?? []) as Record<string, unknown>[]).map((row) => ({
      engine: String(row.engine),
      samples: number(row.samples),
      medianUsd: nullableNumber(row.median_usd),
      p90Usd: nullableNumber(row.p90_usd),
    })),
    priceVersion: PRICE_TABLE_VERSION,
  };
}

/** The SQL's refusals, as the codes the wire speaks. */
function mapReconciliationError(message: string): AppError {
  const text = String(message ?? "");
  if (text.includes("reconciliation not found")) {
    return new AppError(404, "reconciliation_not_found", "That reconciliation does not exist.");
  }
  if (text.includes("probe attempts are reconciled")) {
    return new AppError(
      409,
      "use_probe_reconciliation",
      "Probe attempts are reconciled from Measurement operations.",
      { recovery: "Reconcile this attempt from Measurement operations with reconcile_probe_dispatch." }
    );
  }
  if (text.includes("only unknown costs can be marked not billed")) {
    return new AppError(409, "not_unknown_cost", "Only an unknown cost can be marked not billed.");
  }
  if (text.includes("note of at least 10 characters")) {
    return new AppError(400, "note_required", "Add a note of at least 10 characters.");
  }
  return new AppError(500, "reconciliation_unavailable", "The reconciliation could not be saved.");
}

/**
 * Resolve one open reconciliation. It never changes a ledger amount: `accepted`
 * and `price_updated` close the question, and `not_billed` zeroes a row that
 * was never a paid call.
 */
export async function resolveReconciliation(
  admin: SupabaseClient,
  id: string,
  resolution: "accepted" | "price_updated" | "not_billed",
  note: string
): Promise<void> {
  const { error } = await admin.rpc("resolve_cost_reconciliation", {
    p_id: id,
    p_resolution: resolution,
    p_note: note,
    p_by: "operator",
  });
  if (error) throw mapReconciliationError(error.message);
}

/**
 * Accept the open unknown-cost backlog older than `beforeDays`. It resolves as
 * `accepted` only and never rewrites an amount, so it cannot be used to zero
 * spend.
 */
export async function resolveUnknownCostBacklog(
  admin: SupabaseClient,
  opts: { beforeDays: number; note: string; by: string; limit?: number }
): Promise<number> {
  const before = new Date(Date.now() - opts.beforeDays * 24 * 60 * 60 * 1000);
  const { data, error } = await admin.rpc("resolve_unknown_cost_backlog", {
    p_before: before.toISOString(),
    p_note: opts.note,
    p_by: opts.by,
    p_limit: opts.limit ?? 1000,
  });
  if (error) {
    const message = String(error.message ?? "");
    if (message.includes("note of at least 10 characters")) {
      throw new AppError(400, "note_required", "Add a note of at least 10 characters.");
    }
    if (message.includes("bulk resolve limit")) {
      throw new AppError(400, "invalid_request", "Choose a limit of 5000 rows or less.");
    }
    throw mapReconciliationError(message);
  }
  return number(data);
}
