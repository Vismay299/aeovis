import { randomUUID } from "node:crypto";
import { usd6 } from "./money.ts";
import type {
  PruneResult,
  ReserveArgs,
  ReserveResult,
  SettleResult,
  SpendCostRow,
  SpendStore,
} from "./store.ts";

export type MemoryControl = {
  enabled: boolean;
  mode: "all" | "allowlist";
  brandAllowlist: string[];
  dailyCapUsd: number | null;
  maxCallUsd: number | null;
};

export type MemoryLimit = { dailyCapUsd: number | null; monthlyCapUsd: number | null };

export type MemoryHold = {
  id: string;
  brandKey: string;
  feature: string;
  idempotencyKey: string;
  estimateUsd: number;
  maxUsd: number | null;
  status: "held" | "settled" | "released" | "expired";
  actualUsd: number | null;
  releaseReason: string | null;
  expiresAt: number;
  createdAt: number;
  closedAt: number | null;
};

export type MemoryLedgerRow = {
  brandKey: string;
  feature: string;
  holdId: string;
  sourceRef: string;
  provider: string;
  endpoint: string;
  units: number | null;
  estimateUsd: number | null;
  actualUsd: number | null;
  accountedUsd: number;
  costSource: "provider_reported" | "price_table" | "reservation" | "none";
  occurredAt: number;
  meta: Record<string, unknown>;
};

export type MemoryStoreSeed = {
  controls?: Record<string, MemoryControl>;
  limits?: Record<string, MemoryLimit>;
  now?: () => number;
};

export type MemorySpendStore = SpendStore & {
  controls: Map<string, MemoryControl>;
  limits: Map<string, MemoryLimit>;
  holds: Map<string, MemoryHold>;
  ledger: MemoryLedgerRow[];
};

function controlFrom(seed: Partial<MemoryControl>): MemoryControl {
  return {
    enabled: seed.enabled ?? false,
    mode: seed.mode ?? "allowlist",
    brandAllowlist: seed.brandAllowlist ?? [],
    dailyCapUsd: seed.dailyCapUsd ?? null,
    maxCallUsd: seed.maxCallUsd ?? null,
  };
}

export function createMemoryStore(seed: MemoryStoreSeed = {}): MemorySpendStore {
  const now = seed.now ?? Date.now;
  const controls = new Map<string, MemoryControl>();
  for (const [feature, control] of Object.entries(seed.controls ?? {})) {
    controls.set(feature, controlFrom(control));
  }
  const limits = new Map<string, MemoryLimit>(Object.entries(seed.limits ?? {}));
  const holds = new Map<string, MemoryHold>();
  const ledger: MemoryLedgerRow[] = [];

  const utcDayStart = (at: number): number => {
    const date = new Date(at);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  };
  const utcMonthStart = (at: number): number => {
    const date = new Date(at);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  };
  const committedUsd = (brandKey: string | null, feature: string | null, since: number): number => {
    let total = 0;
    for (const row of ledger) {
      if (row.occurredAt < since) continue;
      if (brandKey !== null && row.brandKey !== brandKey) continue;
      if (feature !== null && row.feature !== feature) continue;
      total = usd6(total + row.accountedUsd);
    }
    for (const hold of holds.values()) {
      if (hold.status !== "held") continue;
      if (brandKey !== null && hold.brandKey !== brandKey) continue;
      if (feature !== null && hold.feature !== feature) continue;
      total = usd6(total + hold.estimateUsd);
    }
    return total;
  };

  return {
    controls,
    limits,
    holds,
    ledger,

    async reserve(args: ReserveArgs): Promise<ReserveResult> {
      if (!Number.isFinite(args.estimateUsd) || args.estimateUsd <= 0) {
        throw new Error("estimate must be positive");
      }
      if (args.ttlSeconds < 60 || args.ttlSeconds > 86340) throw new Error("invalid hold ttl");

      const existing = [...holds.values()].find(
        (hold) =>
          hold.brandKey === args.brandKey &&
          hold.feature === args.feature &&
          hold.idempotencyKey === args.idempotencyKey
      );
      if (existing) {
        if (existing.status === "held") {
          return { granted: true, holdId: existing.id, existing: true };
        }
        return { granted: false, reason: "duplicate_paid_call", holdId: existing.id };
      }

      const control = controls.get(args.feature);
      if (
        !control ||
        !control.enabled ||
        (control.mode === "allowlist" && !control.brandAllowlist.includes(args.brandKey))
      ) {
        return { granted: false, reason: "feature_disabled" };
      }
      if (args.maxUsd !== null && args.estimateUsd > args.maxUsd) {
        return { granted: false, reason: "over_approved_max", estimateUsd: args.estimateUsd };
      }
      if (control.maxCallUsd !== null && args.estimateUsd > control.maxCallUsd) {
        return {
          granted: false,
          reason: "over_approved_max",
          estimateUsd: args.estimateUsd,
          limitUsd: control.maxCallUsd,
        };
      }
      const day = utcDayStart(now());
      const month = utcMonthStart(now());
      if (
        control.dailyCapUsd !== null &&
        committedUsd(null, args.feature, day) + args.estimateUsd > control.dailyCapUsd
      ) {
        return { granted: false, reason: "daily_cap", scope: "feature" };
      }
      const limit = limits.get(args.brandKey);
      const daily = limit ? limit.dailyCapUsd : args.defaultDailyUsd;
      const monthly = limit ? limit.monthlyCapUsd : args.defaultMonthlyUsd;
      if (daily !== null && committedUsd(args.brandKey, null, day) + args.estimateUsd > daily) {
        return { granted: false, reason: "daily_cap", scope: "workspace", limitUsd: daily };
      }
      if (monthly !== null && committedUsd(args.brandKey, null, month) + args.estimateUsd > monthly) {
        return { granted: false, reason: "workspace_cap", limitUsd: monthly };
      }

      const id = randomUUID();
      const at = now();
      holds.set(id, {
        id,
        brandKey: args.brandKey,
        feature: args.feature,
        idempotencyKey: args.idempotencyKey,
        estimateUsd: args.estimateUsd,
        maxUsd: args.maxUsd,
        status: "held",
        actualUsd: null,
        releaseReason: null,
        expiresAt: at + args.ttlSeconds * 1000,
        createdAt: at,
        closedAt: null,
      });
      return { granted: true, holdId: id, existing: false };
    },

    async settle(holdId: string, costs: SpendCostRow[]): Promise<SettleResult> {
      const hold = holds.get(holdId);
      if (!hold) throw new Error("hold not found");

      if (hold.status === "expired") {
        // Late settle of an expired hold: the expiry reservation row is re-priced at the actual
        // cost, and the hold moves to settled. Any unknown cost leaves everything untouched.
        if (costs.length < 1 || costs.length > 200) throw new Error("settle needs 1..200 cost rows");
        let sum = 0;
        let unknown = false;
        for (const cost of costs) {
          if (cost.actualUsd !== null && cost.actualUsd < 0) throw new Error("negative cost");
          if (cost.actualUsd === null) unknown = true;
          else sum = usd6(sum + cost.actualUsd);
        }
        if (unknown) {
          return {
            settled: false,
            status: "expired",
            unknown: true,
            feature: hold.feature,
            estimateUsd: hold.estimateUsd,
            maxUsd: hold.maxUsd ?? undefined,
            actualUsd: hold.actualUsd ?? undefined,
          };
        }
        const actualUsd = usd6(sum);
        const sourceRef = `hold:${holdId}`;
        const reservation = ledger.find((row) => row.sourceRef === sourceRef);
        if (reservation) {
          reservation.actualUsd = actualUsd;
          reservation.accountedUsd = actualUsd;
          reservation.costSource = "provider_reported";
          reservation.meta = { ...reservation.meta, late_settle: true };
        } else {
          ledger.push({
            brandKey: hold.brandKey,
            feature: hold.feature,
            holdId,
            sourceRef,
            provider: costs[0]?.provider ?? "unknown",
            endpoint: costs[0]?.endpoint ?? "late_settle",
            // settle_spend's late path writes neither units nor the caller's meta.
            units: null,
            estimateUsd: hold.estimateUsd,
            actualUsd,
            accountedUsd: actualUsd,
            costSource: "provider_reported",
            occurredAt: now(),
            meta: { expired: true, late_settle: true },
          });
        }
        hold.status = "settled";
        hold.actualUsd = actualUsd;
        hold.closedAt = now();
        return {
          settled: true,
          late: true,
          actualUsd,
          unknown: false,
          undershoot: actualUsd > hold.estimateUsd,
          overMax: hold.maxUsd !== null && actualUsd > hold.maxUsd,
          feature: hold.feature,
          estimateUsd: hold.estimateUsd,
          maxUsd: hold.maxUsd ?? undefined,
        };
      }

      if (hold.status !== "held") {
        return {
          settled: false,
          status: hold.status,
          feature: hold.feature,
          estimateUsd: hold.estimateUsd,
          maxUsd: hold.maxUsd ?? undefined,
          actualUsd: hold.actualUsd ?? undefined,
        };
      }
      if (costs.length < 1 || costs.length > 200) throw new Error("settle needs 1..200 cost rows");

      let actualUsd = 0;
      let unknown = false;
      const rows = costs.length;
      costs.forEach((cost, index) => {
        if (cost.actualUsd !== null && cost.actualUsd < 0) throw new Error("negative cost");
        const share = usd6(hold.estimateUsd / rows);
        const sourceRef = rows > 1 ? `hold:${holdId}:${index + 1}` : `hold:${holdId}`;
        const accountedUsd = cost.actualUsd === null ? share : cost.actualUsd;
        const costSource = cost.actualUsd === null ? "reservation" : cost.costSource;
        if (cost.actualUsd === null) unknown = true;
        else actualUsd = usd6(actualUsd + cost.actualUsd);
        if (ledger.some((row) => row.sourceRef === sourceRef)) return;
        ledger.push({
          brandKey: hold.brandKey,
          feature: hold.feature,
          holdId,
          sourceRef,
          provider: cost.provider,
          endpoint: cost.endpoint,
          units: cost.units ?? null,
          estimateUsd: share,
          actualUsd: cost.actualUsd,
          accountedUsd,
          costSource,
          occurredAt: now(),
          meta: { ...(cost.meta ?? {}), undershoot: cost.actualUsd !== null && cost.actualUsd > share },
        });
      });

      hold.status = "settled";
      hold.actualUsd = unknown ? null : actualUsd;
      hold.closedAt = now();
      return {
        settled: true,
        actualUsd,
        unknown,
        undershoot: actualUsd > hold.estimateUsd,
        overMax: hold.maxUsd !== null && actualUsd > hold.maxUsd,
        feature: hold.feature,
        estimateUsd: hold.estimateUsd,
        maxUsd: hold.maxUsd ?? undefined,
      };
    },

    async release(holdId: string, reason: string): Promise<boolean> {
      const hold = holds.get(holdId);
      if (!hold || hold.status !== "held") return false;
      hold.status = "released";
      hold.releaseReason = reason.slice(0, 200);
      hold.actualUsd = 0;
      hold.closedAt = now();
      return true;
    },

    async expire(limit: number): Promise<number> {
      const at = now();
      const due = [...holds.values()]
        .filter((hold) => hold.status === "held" && hold.expiresAt < at)
        .sort((a, b) => a.expiresAt - b.expiresAt)
        .slice(0, limit);
      for (const hold of due) {
        const sourceRef = `hold:${hold.id}`;
        if (!ledger.some((row) => row.sourceRef === sourceRef)) {
          ledger.push({
            brandKey: hold.brandKey,
            feature: hold.feature,
            holdId: hold.id,
            sourceRef,
            provider: "unknown",
            endpoint: "expired_hold",
            units: null,
            estimateUsd: hold.estimateUsd,
            actualUsd: null,
            accountedUsd: hold.estimateUsd,
            costSource: "reservation",
            occurredAt: at,
            meta: { expired: true },
          });
        }
        hold.status = "expired";
        hold.closedAt = at;
      }
      return due.length;
    },

    async prune(holdsBefore: Date, ledgerBefore: Date): Promise<PruneResult> {
      const ledgerCutoff = ledgerBefore.getTime();
      const holdsCutoff = holdsBefore.getTime();
      let prunedLedger = 0;
      for (let index = ledger.length - 1; index >= 0; index -= 1) {
        if (ledger[index].occurredAt < ledgerCutoff) {
          ledger.splice(index, 1);
          prunedLedger += 1;
        }
      }
      let prunedHolds = 0;
      for (const [id, hold] of holds) {
        if (hold.status !== "held" && hold.closedAt !== null && hold.closedAt < holdsCutoff) {
          holds.delete(id);
          prunedHolds += 1;
        }
      }
      return { ledger: prunedLedger, holds: prunedHolds };
    },
  };
}
