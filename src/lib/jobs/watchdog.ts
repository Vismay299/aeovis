// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/audit/services/auditReconciler.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

/**
 * The watchdog: the sweep that closes the gap between a row that says
 * "running" and the invocation that no longer exists. There is no external
 * instance to ask here, so staleness is decided by the row itself — past
 * `deadline_at`, or resumed more times than `max_invocations` — oldest first,
 * 100 per batch, and one bad row never stops the sweep.
 */
import { jobStore } from "./store.ts";
import type { JobStore } from "./store.ts";

export const WATCHDOG_BATCH_LIMIT = 100;
export const HOLD_EXPIRY_LIMIT = 500;

export type WatchdogFailure = { label: string; reason: string };

export type WatchdogReport = {
  deadlineExceeded: number;
  invocationLimit: number;
  expiredHolds: number;
  errors: WatchdogFailure[];
};

export type WatchdogDeps = { store?: JobStore; logger?: Pick<Console, "error" | "warn"> };

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 500);
}

/**
 * Runs both sweeps, then rethrows the first failure (`P3.T2.S3`). The tick
 * holds that error until the rest of its work has run and reports it last, so a
 * watchdog outage cannot suppress job progress (`openseo:src/server.ts:235-259`).
 */
export async function runWatchdog(deps?: WatchdogDeps): Promise<WatchdogReport> {
  const store = deps?.store ?? jobStore();
  const logger = deps?.logger ?? console;
  const report: WatchdogReport = { deadlineExceeded: 0, invocationLimit: 0, expiredHolds: 0, errors: [] };
  let firstFailure: unknown = null;

  try {
    const swept = await store.reconcileStale(WATCHDOG_BATCH_LIMIT);
    report.deadlineExceeded = swept.deadlineExceeded;
    report.invocationLimit = swept.invocationLimit;
  } catch (err) {
    if (firstFailure === null) firstFailure = err;
    report.errors.push({ label: "reconcile_stale_jobs", reason: describe(err) });
    logger.error("[jobs] watchdog reconcile failed", { reason: describe(err) });
  }

  try {
    report.expiredHolds = await store.expireSpendHolds(HOLD_EXPIRY_LIMIT);
  } catch (err) {
    if (firstFailure === null) firstFailure = err;
    report.errors.push({ label: "expire_spend_holds", reason: describe(err) });
    logger.error("[jobs] watchdog hold expiry failed", { reason: describe(err) });
  }

  if (firstFailure !== null) throw firstFailure;
  return report;
}
