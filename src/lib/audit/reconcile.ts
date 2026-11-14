// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/audit/services/auditReconciler.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { definePeriodic, listPeriodics } from "../jobs/periodic.ts";
import { enqueueSystemJob } from "../jobs/enqueue.ts";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";
import { getJobStatus, type JobStatusResult } from "../jobs/status.ts";
import { AppError } from "../http/errors.ts";
import { StepFailedError } from "../jobs/runner.ts";
import { getSupabaseAdmin } from "../supabase/admin.js";
import { createSqlAuditStore, type AuditRow, type AuditStore } from "./store.ts";
import { classifyAuditFailure } from "./errors.ts";
import { settleRenderHold, type RenderSettleDeps } from "./renderSettle.ts";

const TEN_MINUTES_MS = 10 * 60 * 1000;
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

export interface ReconcileDeps {
  store?: AuditStore;
  admin?: any;
  getJobStatus?: (jobId: string) => Promise<JobStatusResult>;
  now?: () => number;
  settleSpendBatch?: RenderSettleDeps["settleSpendBatch"];
  firecrawlUnitUsd?: number;
  env?: Record<string, string | undefined>;
}

/**
 * Reconciles a running or queued audit against its F01 job status.
 * Terminal jobs or missing jobs older than 10 minutes flip the audit to failed/cancelled.
 * Completed audits are never flipped.
 */
export async function reconcileRunningAudit(
  audit: AuditRow,
  deps?: ReconcileDeps,
): Promise<{ flipped: boolean; newStatus?: string }> {
  // A completed, failed, or cancelled audit is never flipped (AC-20)
  if (audit.status !== "queued" && audit.status !== "running") {
    return { flipped: false };
  }

  const store = deps?.store ?? (deps?.admin ? createSqlAuditStore(deps.admin) : createSqlAuditStore(getSupabaseAdmin()));
  const getStatus = deps?.getJobStatus ?? getJobStatus;
  const now = deps?.now ? deps.now() : Date.now();
  const createdAtMs = Date.parse(audit.created_at);
  const ageMs = now - createdAtMs;

  async function settleAfterFlip(flipped: boolean): Promise<void> {
    if (!flipped) return;
    try {
      await settleRenderHold(audit.id, store, deps?.admin ?? null, {
        settleSpendBatch: deps?.settleSpendBatch,
        firecrawlUnitUsd: deps?.firecrawlUnitUsd,
        env: deps?.env,
      });
    } catch {
      // Reconcile never fails the sweep on a settle error; the guarded
      // `settle-render` step will settle on the next run.
    }
  }

  // Case 1: job_id is null
  if (!audit.job_id) {
    if (ageMs > TEN_MINUTES_MS) {
      const flipped = await store.failAudit(audit.id, {
        errorCode: "job_lost",
        errorDetail: "Audit was queued but no job was created within 10 minutes.",
        failedPhase: audit.current_phase,
      });
      await settleAfterFlip(flipped);
      return { flipped, newStatus: flipped ? "failed" : undefined };
    }
    return { flipped: false };
  }

  // Case 2: job_id is present
  let jobStatusResult: JobStatusResult | null = null;
  try {
    jobStatusResult = await getStatus(audit.job_id);
  } catch (err: unknown) {
    if (err instanceof AppError && err.code === "job_not_found") {
      jobStatusResult = null;
    } else {
      // Transient read error: do not change audit state
      return { flipped: false };
    }
  }

  // If job is missing
  if (!jobStatusResult) {
    if (ageMs > TEN_MINUTES_MS) {
      const flipped = await store.failAudit(audit.id, {
        errorCode: "job_lost",
        errorDetail: "Audit job row was lost or pruned.",
        failedPhase: audit.current_phase,
      });
      await settleAfterFlip(flipped);
      return { flipped, newStatus: flipped ? "failed" : undefined };
    }
    return { flipped: false };
  }

  if (jobStatusResult.status === "failed") {
    const rawCode = jobStatusResult.error?.code ?? "unknown";
    const classification = classifyAuditFailure(
      new StepFailedError(rawCode, jobStatusResult.error?.message ?? "Job failed"),
    );
    const flipped = await store.failAudit(audit.id, {
      errorCode: classification.errorCode,
      errorDetail: classification.errorDetail,
      failedPhase: audit.current_phase,
    });
    await settleAfterFlip(flipped);
    return { flipped, newStatus: flipped ? "failed" : undefined };
  }

  if (jobStatusResult.status === "cancelled") {
    const flipped = await store.cancelAudit(audit.id, {
      errorDetail: "Audit job was cancelled.",
      failedPhase: audit.current_phase,
    });
    await settleAfterFlip(flipped);
    return { flipped, newStatus: flipped ? "cancelled" : undefined };
  }

  return { flipped: false };
}

/**
 * Sweeps up to 100 active audits created more than 15 minutes ago, oldest first.
 */
export async function reconcileStaleAudits(
  deps?: ReconcileDeps,
): Promise<{ checked: number; flipped: number }> {
  const admin = deps?.admin ?? (typeof getSupabaseAdmin === "function" ? getSupabaseAdmin() : null);
  const store = deps?.store ?? (admin ? createSqlAuditStore(admin) : createSqlAuditStore(getSupabaseAdmin()));
  const now = deps?.now ? deps.now() : Date.now();
  const thresholdIso = new Date(now - FIFTEEN_MINUTES_MS).toISOString();

  let staleAudits: AuditRow[] = [];
  if (admin?.from) {
    const { data, error } = await admin
      .from("site_audits")
      .select("*")
      .in("status", ["queued", "running"])
      .lt("created_at", thresholdIso)
      .order("created_at", { ascending: true })
      .limit(100);

    if (!error && Array.isArray(data)) {
      staleAudits = data as AuditRow[];
    }
  }

  let flippedCount = 0;
  for (const audit of staleAudits) {
    const res = await reconcileRunningAudit(audit, deps);
    if (res.flipped) {
      flippedCount += 1;
    }
  }

  return { checked: staleAudits.length, flipped: flippedCount };
}

export function registerSiteAuditReconcileJobs(deps?: ReconcileDeps): void {
  // 1. periodic site_audit.reconcile (every 900 s / 15 minutes)
  if (!listPeriodics().some((p) => p.name === "site_audit.reconcile")) {
    definePeriodic({
      name: "site_audit.reconcile",
      everySeconds: 900,
      run: async (now: Date) => {
        const bucket = Math.floor(now.getTime() / (900 * 1000));
        try {
          await enqueueSystemJob(
            "site_audit.reconcile",
            {},
            { dedupeKey: `site_audit.reconcile:${bucket}` },
          );
        } catch (err: unknown) {
          if (err instanceof AppError && err.code === "job_already_running") return;
          throw err;
        }
      },
    });
  }

  // 2. job site_audit.reconcile definition
  if (!getJobDefinition("site_audit.reconcile")) {
    defineJob("site_audit.reconcile", async (ctx) => {
      const result = await ctx.step.do("reconcile", DB_STEP, async () => {
        return reconcileStaleAudits(deps);
      });
      return { status: "completed", result };
    });
  }
}

// Auto-register on import
registerSiteAuditReconcileJobs();
