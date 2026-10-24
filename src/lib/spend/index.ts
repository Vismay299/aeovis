// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/dataforseo/client.ts, src/server/billing/subscription.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../http/appError.ts";
import { getSupabaseAdmin } from "../supabase/admin.js";
import { keepAlive as defaultKeepAlive } from "../keepAlive.js";
import { ChargedCallError, SpendRefused, UnbilledCallError } from "./errors.ts";
import type { SpendRefusalReason } from "./errors.ts";
import { usd6 } from "./money.ts";
import { createSpendStore } from "./store.ts";
import type { ReserveResult, SettleResult, SpendCostRow, SpendStore } from "./store.ts";
import type { SpendFeature } from "./features.ts";

export { SPEND_FEATURES, isSpendFeature } from "./features.ts";
export type { SpendFeature } from "./features.ts";
export { usd6, toMicros, fromMicros } from "./money.ts";
export { SpendRefused, ChargedCallError, UnbilledCallError, AmbiguousCallError } from "./errors.ts";

const MAX_ESTIMATE_USD = 1_000;
const DEFAULT_TTL_SECONDS = 1_800;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 86_340;
const MAX_IDEMPOTENCY_KEY_LENGTH = 300;
const SETTLE_RETRY_DELAY_MS = 250;

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

function capFromEnv(env: Record<string, string | undefined>, name: string): number | null {
  const raw = env[name];
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const value = Number(String(raw).trim());
  if (!Number.isFinite(value) || value < 0) {
    throw new AppError(500, "spend_config_invalid", "Spend configuration is invalid.");
  }
  return usd6(value);
}

function validateReserve(i: { estimateUsd: number; ttlSeconds?: number; idempotencyKey: string }): void {
  if (!Number.isFinite(i.estimateUsd) || i.estimateUsd <= 0 || i.estimateUsd > MAX_ESTIMATE_USD) {
    throw new AppError(400, "spend_invalid", "The spend estimate is out of range.");
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
): Promise<{ holdId: string }> {
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
      maxUsd: i.maxUsd ?? null,
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

  if (result.granted && result.holdId) return { holdId: result.holdId };
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

  if (result.undershoot) {
    logger.error("[spend] estimate undershoot", {
      feature: result.feature ?? "unknown",
      provider: costs[0]?.provider ?? "unknown",
      endpoint: costs[0]?.endpoint ?? "unknown",
      estimateUsd: result.estimateUsd ?? null,
      actualUsd: result.actualUsd ?? null,
    });
  }
  if (result.overMax) {
    logger.error("[spend] over approved max", {
      holdId,
      maxUsd: result.maxUsd ?? null,
      actualUsd: result.actualUsd ?? null,
    });
  }
}

export async function releaseSpend(holdId: string, reason: string, deps?: SpendDeps): Promise<void> {
  const store = storeFor(deps);
  await store.release(holdId, reason);
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
  const { holdId } = await reserveSpend(i, deps);
  const logger = deps?.logger ?? console;
  const keepAlive = deps?.keepAlive ?? defaultKeepAlive;

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
        await releaseSpend(holdId, "not_billed", deps);
      }
      return outcome.value;
    } catch (err) {
      if (err instanceof UnbilledCallError) {
        await releaseSpend(holdId, "unbilled_error", deps);
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
      logger.error("[spend] unclassified call error", err instanceof Error ? err.name : typeof err);
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
