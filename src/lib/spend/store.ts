import type { SupabaseClient } from "@supabase/supabase-js";

export type ReserveArgs = {
  brandKey: string;
  feature: string;
  estimateUsd: number;
  maxUsd: number | null;
  idempotencyKey: string;
  jobId: string | null;
  subjectKind: string | null;
  subjectId: string | null;
  ttlSeconds: number;
  defaultDailyUsd: number | null;
  defaultMonthlyUsd: number | null;
};

export type ReserveResult = {
  granted: boolean;
  holdId?: string;
  reason?: string;
  existing?: boolean;
  scope?: "feature" | "workspace";
  limitUsd?: number;
  estimateUsd?: number;
};

export type SpendCostRow = {
  provider: string;
  endpoint: string;
  units?: number;
  actualUsd: number | null;
  costSource: "provider_reported" | "price_table";
  meta?: Record<string, string | number | boolean>;
};

export type SettleResult = {
  settled: boolean;
  status?: string;
  actualUsd?: number;
  unknown?: boolean;
  undershoot?: boolean;
  overMax?: boolean;
  feature?: string;
  estimateUsd?: number;
  maxUsd?: number;
};

export type PruneResult = { ledger: number; holds: number };

export type SpendStore = {
  reserve(args: ReserveArgs): Promise<ReserveResult>;
  settle(holdId: string, costs: SpendCostRow[]): Promise<SettleResult>;
  release(holdId: string, reason: string): Promise<boolean>;
  expire(limit: number): Promise<number>;
  prune(holdsBefore: Date, ledgerBefore: Date): Promise<PruneResult>;
};

type RawResult = Record<string, unknown> | null;

function num(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toReserveResult(raw: RawResult): ReserveResult {
  const data = raw ?? {};
  const result: ReserveResult = { granted: data.granted === true };
  if (typeof data.hold_id === "string") result.holdId = data.hold_id;
  if (typeof data.reason === "string") result.reason = data.reason;
  if (typeof data.existing === "boolean") result.existing = data.existing;
  if (data.scope === "feature" || data.scope === "workspace") result.scope = data.scope;
  const limitUsd = num(data.limit_usd);
  if (limitUsd !== undefined) result.limitUsd = limitUsd;
  const estimateUsd = num(data.estimate_usd);
  if (estimateUsd !== undefined) result.estimateUsd = estimateUsd;
  return result;
}

function toSettleResult(raw: RawResult): SettleResult {
  const data = raw ?? {};
  const result: SettleResult = { settled: data.settled === true };
  if (typeof data.status === "string") result.status = data.status;
  const actualUsd = num(data.actual_usd);
  if (actualUsd !== undefined) result.actualUsd = actualUsd;
  if (typeof data.unknown === "boolean") result.unknown = data.unknown;
  result.undershoot = data.undershoot === true;
  result.overMax = data.over_max === true;
  return result;
}

function toCostPayload(cost: SpendCostRow): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    provider: cost.provider,
    endpoint: cost.endpoint,
    actual_usd: cost.actualUsd,
    cost_source: cost.costSource,
  };
  if (cost.units !== undefined) payload.units = cost.units;
  if (cost.meta !== undefined) payload.meta = cost.meta;
  return payload;
}

export function createSpendStore(admin: SupabaseClient): SpendStore {
  return {
    async reserve(args) {
      const { data, error } = await admin.rpc("reserve_spend", {
        p_brand: args.brandKey,
        p_feature: args.feature,
        p_estimate: args.estimateUsd,
        p_max: args.maxUsd,
        p_idempotency: args.idempotencyKey,
        p_job: args.jobId,
        p_subject_kind: args.subjectKind,
        p_subject_id: args.subjectId,
        p_ttl_seconds: args.ttlSeconds,
        p_default_daily: args.defaultDailyUsd,
        p_default_monthly: args.defaultMonthlyUsd,
      });
      if (error) throw new Error(error.message);
      return toReserveResult(data as RawResult);
    },

    async settle(holdId, costs) {
      const { data, error } = await admin.rpc("settle_spend", {
        p_hold: holdId,
        p_costs: costs.map(toCostPayload),
      });
      if (error) throw new Error(error.message);
      const result = toSettleResult(data as RawResult);
      if (result.undershoot || result.overMax) {
        // settle_spend reports the flags but not the hold it priced them against;
        // the undershoot log line is required to carry feature, estimate and max.
        const hold = await admin
          .from("spend_holds")
          .select("feature, estimate_usd, max_usd")
          .eq("id", holdId)
          .maybeSingle();
        const row = hold.error ? null : (hold.data as RawResult);
        if (row) {
          if (typeof row.feature === "string") result.feature = row.feature;
          const estimateUsd = num(row.estimate_usd);
          if (estimateUsd !== undefined) result.estimateUsd = estimateUsd;
          const maxUsd = num(row.max_usd);
          if (maxUsd !== undefined) result.maxUsd = maxUsd;
        }
      }
      return result;
    },

    async release(holdId, reason) {
      const { data, error } = await admin.rpc("release_spend", { p_hold: holdId, p_reason: reason });
      if (error) throw new Error(error.message);
      return data === true;
    },

    async expire(limit) {
      const { data, error } = await admin.rpc("expire_spend_holds", { p_limit: limit });
      if (error) throw new Error(error.message);
      return num(data) ?? 0;
    },

    async prune(holdsBefore, ledgerBefore) {
      const { data, error } = await admin.rpc("prune_spend", {
        p_holds_before: holdsBefore.toISOString(),
        p_ledger_before: ledgerBefore.toISOString(),
      });
      if (error) throw new Error(error.message);
      const row = (data ?? {}) as Record<string, unknown>;
      return { ledger: num(row.ledger) ?? 0, holds: num(row.holds) ?? 0 };
    },
  };
}
