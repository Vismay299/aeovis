// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/client.ts, src/server/billing/subscription.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../http/appError.ts";
import { getSupabaseAdmin } from "../supabase/admin.js";
import { keepAlive as defaultKeepAlive } from "../keepAlive.js";
import { AmbiguousCallError, ChargedCallError, SpendRefused, UnbilledCallError } from "./errors.ts";
import type { SpendRefusalReason } from "./errors.ts";
import { usd6 } from "./money.ts";
import { createSpendStore } from "./store.ts";
import type { ReserveResult, SettleResult, SpendCostRow, SpendStore } from "./store.ts";
import type { SpendFeature } from "./features.ts";

export { SPEND_FEATURES, isSpendFeature } from "./features.ts";
export type { SpendFeature } from "./features.ts";
export { usd6, toMicros, fromMicros } from "./money.ts";
export { SpendRefused, ChargedCallError, UnbilledCallError, AmbiguousCallError } from "./errors.ts";

export const MAX_ESTIMATE_USD = 1_000;
const DEFAULT_TTL_SECONDS = 1_800;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 86_340;
const MAX_IDEMPOTENCY_KEY_LENGTH = 300;
const SETTLE_RETRY_DELAY_MS = 250;
const ALERT_MEMORY_LIMIT = 1_000;

// A settle that comes back `settled: false` still carries the hold's amounts, which is the only
// chance a retry after a lost response has to alert. The same retry would otherwise re-emit the
// alert the first attempt already sent, so each hold alerts at most once per process.
const alerted = new Set<string>();

function alertOnce(kind: string, holdId: string): boolean {
  const key = kind + ":" + holdId;
  if (alerted.has(key)) return false;
  if (alerted.size >= ALERT_MEMORY_LIMIT) alerted.clear();
  alerted.add(key);
  return true;
}

const REFUSAL_REASONS: readonly SpendRefusalReason[] = [
  "feature_disabled",
  "workspace_cap",
  "daily_cap",
  "over_approved_max",
];

export type SpendDeps = {
  store?: SpendStore;
  env?: Record<string, string | undefined>;
  keepAlive?: typeof defaultKeepAlive;
  logger?: Pick<Console, "error" | "warn">;
};

export type SpendCost = {
  provider: string;
  endpoint: string;
  units?: number;
  actualUsd: number | null;
  costSource: "provider_reported" | "price_table";
  meta?: Record<string, string | number | boolean>;
};

function refused(message: string, cause?: unknown): AppError {
  return new AppError(503, "spend_unavailable", message, { cause });
}

function storeFor(deps?: SpendDeps): SpendStore {
  if (deps?.store) return deps.store;
  const admin = getSupabaseAdmin();
  if (!admin) throw refused("Spend control is unavailable, so paid work is paused.");
  return createSpendStore(admin);
}

export function capFromEnv(env: Record<string, string | undefined>, name: string): number | null {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError(500, "spend_config_invalid", "Spend configuration is invalid.");
  }
  return usd6(value);
}

function validateReserve(i: {
  estimateUsd: number;
  maxUsd?: number;
  ttlSeconds?: number;
  idempotencyKey: string;
}): void {
  // A sub-micro estimate rounds to a zero-dollar hold, which would meter the call at nothing.
  if (!Number.isFinite(i.estimateUsd) || usd6(i.estimateUsd) <= 0 || i.estimateUsd > MAX_ESTIMATE_USD) {
    throw new AppError(400, "spend_invalid", "The spend estimate is out of range.");
  }
  // max_usd is numeric(12,6): an out-of-range ceiling would overflow in the INSERT and reach the
  // caller as a 503 guard outage instead of the 400 its own input earned.
  if (
    i.maxUsd !== undefined &&
    (!Number.isFinite(i.maxUsd) || usd6(i.maxUsd) <= 0 || i.maxUsd > MAX_ESTIMATE_USD)
  ) {
    throw new AppError(400, "spend_invalid", "The approved maximum is out of range.");
  }
  const ttlSeconds = i.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
    throw new AppError(400, "spend_invalid", "The spend hold lifetime is out of range.");
  }
  if (
    typeof i.idempotencyKey !== "string" ||
    i.idempotencyKey.length < 1 ||
    i.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
  ) {
    throw new AppError(400, "spend_invalid", "The spend idempotency key is invalid.");
  }
}

export async function reserveSpend(
  i: {
    brandKey: string;
    feature: SpendFeature;
    estimateUsd: number;
    maxUsd?: number;
    jobId?: string;
    idempotencyKey: string;
    ttlSeconds?: number;
    subject?: { kind: string; id: string };
  },
  deps?: SpendDeps
): Promise<{ holdId: string; existing: boolean }> {
  validateReserve(i);
  const env = deps?.env ?? process.env;
  const defaultDailyUsd = capFromEnv(env, "SPEND_DEFAULT_DAILY_CAP_USD");
  const defaultMonthlyUsd = capFromEnv(env, "SPEND_DEFAULT_MONTHLY_CAP_USD");
  const store = storeFor(deps);

  let result: ReserveResult;
  try {
    result = await store.reserve({
      brandKey: i.brandKey,
      feature: i.feature,
      estimateUsd: usd6(i.estimateUsd),
      maxUsd: i.maxUsd === undefined ? null : usd6(i.maxUsd),
      idempotencyKey: i.idempotencyKey,
      jobId: i.jobId ?? null,
      subjectKind: i.subject?.kind ?? null,
      subjectId: i.subject?.id ?? null,
      ttlSeconds: i.ttlSeconds ?? DEFAULT_TTL_SECONDS,
      defaultDailyUsd,
      defaultMonthlyUsd,
    });
  } catch (err) {
    throw refused("Spend control is unavailable, so paid work is paused.", err);
  }

  if (result.granted && result.holdId) return { holdId: result.holdId, existing: result.existing === true };
  if (result.reason === "duplicate_paid_call") {
    throw new AppError(409, "duplicate_paid_call", "This paid request was already made.");
  }
  const reason = REFUSAL_REASONS.find((candidate) => candidate === result.reason);
  if (!reason) throw refused("Spend control is unavailable, so paid work is paused.");
  throw new SpendRefused(reason, {
    scope: result.scope,
    limitUsd: result.limitUsd,
    estimateUsd: result.estimateUsd,
  });
}

export async function settleSpend(
  holdId: string,
  actualUsd: number | null,
  meta?: { provider: string; endpoint: string; units?: number; providerCostReported?: boolean },
  deps?: SpendDeps
): Promise<void> {
  await settleSpendBatch(
    holdId,
    [
      {
        provider: meta?.provider ?? "unknown",
        endpoint: meta?.endpoint ?? "unknown",
        units: meta?.units,
        actualUsd: actualUsd === null ? null : usd6(actualUsd),
        costSource: meta?.providerCostReported === false ? "price_table" : "provider_reported",
      },
    ],
    deps
  );
}

export async function settleSpendBatch(
  holdId: string,
  costs: SpendCost[],
  deps?: SpendDeps
): Promise<void> {
  const logger = deps?.logger ?? console;
  let store: SpendStore;
  try {
    store = storeFor(deps);
  } catch {
    logger.error("[spend] settle failed", { holdId, rows: costs.length });
    return;
  }

  let result: SettleResult | null = null;
  for (let attempt = 0; attempt < 2 && result === null; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, SETTLE_RETRY_DELAY_MS));
    try {
      result = await store.settle(holdId, costs as SpendCostRow[]);
    } catch {
      result = null;
    }
  }
  if (result === null) {
    logger.error("[spend] settle failed", { holdId, rows: costs.length });
    return;
  }

  // The RPC reports the flags, and on a skipped or late settle it carries no amounts; fall back
  // to the costs the caller handed us and to the hold row the store read back.
  const attemptedActual = costs.every((cost) => cost.actualUsd !== null)
    ? usd6(costs.reduce((sum, cost) => sum + (cost.actualUsd as number), 0))
    : null;
  const actualUsd = result.actualUsd ?? attemptedActual;
  const estimateUsd = result.estimateUsd ?? null;
  const maxUsd = result.maxUsd ?? null;

  if (result.settled === false) {
    logger.error("[spend] settle skipped", { holdId, status: result.status ?? "unknown" });
  }
  if (result.late === true) {
    logger.error("[spend] late settle", { holdId, actualUsd });
  }
  if (
    (result.undershoot === true ||
      (actualUsd != null && estimateUsd != null && actualUsd > estimateUsd)) &&
    alertOnce("undershoot", holdId)
  ) {
    logger.error("[spend] estimate undershoot", {
      feature: result.feature ?? "unknown",
      provider: costs[0]?.provider ?? "unknown",
      endpoint: costs[0]?.endpoint ?? "unknown",
      estimateUsd,
      actualUsd,
    });
  }
  if (
    (result.overMax === true || (actualUsd != null && maxUsd != null && actualUsd > maxUsd)) &&
    alertOnce("over_max", holdId)
  ) {
    logger.error("[spend] over approved max", { holdId, maxUsd, actualUsd });
  }
}

/**
 * Returns false when the hold was no longer `held` — already swept, settled or released. The
 * caller's unbilled call is then charged at the estimate, so the outcome has to be visible.
 */
export async function releaseSpend(holdId: string, reason: string, deps?: SpendDeps): Promise<boolean> {
  const store = storeFor(deps);
  return await store.release(holdId, reason);
}

export async function metered<T>(
  i: {
    brandKey: string;
    feature: SpendFeature;
    estimateUsd: number;
    maxUsd?: number;
    idempotencyKey: string;
    jobId?: string;
    ttlSeconds?: number;
  },
  call: () => Promise<{
    value: T;
    actualUsd: number | null;
    provider: string;
    endpoint: string;
    billed: boolean;
    units?: number;
  }>,
  deps?: SpendDeps
): Promise<T> {
  const { holdId, existing } = await reserveSpend(i, deps);
  if (existing) {
    // The same (brandKey, idempotencyKey) is already in flight behind a live hold. Running the
    // paid call again would bill twice, so a retry is refused instead of reusing the hold.
    throw new AppError(409, "duplicate_paid_call", "This paid request was already made.");
  }
  const logger = deps?.logger ?? console;
  const keepAlive = deps?.keepAlive ?? defaultKeepAlive;

  const safeRelease = async (reason: string): Promise<void> => {
    try {
      const released = await releaseSpend(holdId, reason, deps);
      if (!released) logger.error("[spend] release failed", { holdId, reason });
    } catch {
      // The release failure must not replace the caller's own outcome; the hold expires and is
      // counted at its estimate, so the outcome is only logged.
      logger.error("[spend] release failed", { holdId, reason });
    }
  };

  const work = (async (): Promise<T> => {
    try {
      const outcome = await call();
      if (outcome.billed) {
        await settleSpendBatch(
          holdId,
          [
            {
              provider: outcome.provider,
              endpoint: outcome.endpoint,
              units: outcome.units,
              actualUsd: outcome.actualUsd === null ? null : usd6(outcome.actualUsd),
              costSource: "provider_reported",
            },
          ],
          deps
        );
      } else {
        await safeRelease("not_billed");
      }
      return outcome.value;
    } catch (err) {
      if (err instanceof UnbilledCallError) {
        await safeRelease("unbilled_error");
        throw err;
      }
      if (err instanceof ChargedCallError) {
        await settleSpendBatch(
          holdId,
          [
            {
              provider: err.provider,
              endpoint: err.endpoint,
              actualUsd: usd6(err.actualUsd),
              costSource: "provider_reported",
            },
          ],
          deps
        );
        throw err;
      }
      if (err instanceof AmbiguousCallError) {
        // Sent, outcome unknown: the cost stays null so the hold settles at its estimate.
        logger.error("[spend] ambiguous call", { holdId, feature: i.feature });
      } else {
        logger.error("[spend] unclassified call error", err instanceof Error ? err.name : typeof err);
      }
      await settleSpendBatch(
        holdId,
        [{ provider: "unknown", endpoint: "unknown", actualUsd: null, costSource: "provider_reported" }],
        deps
      );
      throw err;
    }
  })();

  keepAlive(work, { label: "metered:" + i.feature });
  return await work;
}
