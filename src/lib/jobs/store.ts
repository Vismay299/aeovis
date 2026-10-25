import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError } from "../http/errors.ts";
import { getSupabaseAdmin } from "../supabase/admin.js";
import type { JobRow, JobStatus, JobTrigger } from "./types.ts";

export type EnqueueArgs = {
  kind: string;
  brandKey: string | null;
  payload: unknown;
  trigger: JobTrigger;
  dedupeKey: string | null;
  singleActiveKey: string | null;
  runAt: Date | null;
  createdBy: string | null;
  deadlineSeconds: number;
  maxInvocations: number | null;
};

export type EnqueueResult = {
  jobId: string | null;
  deduped: boolean;
  conflictJobId: string | null;
};

export type StepBeginArgs = {
  jobId: string;
  owner: string;
  name: string;
  billed: boolean;
  maxAttempts: number;
  timeoutMs: number;
};

export type StepBeginResult =
  | { action: "run"; attempt: number }
  | { action: "memoised"; output: unknown }
  | { action: "failed"; code: string; message: string }
  | { action: "wait"; wakeAt: Date }
  | { action: "lost_lease" };

export type StepFailArgs = {
  jobId: string;
  owner: string;
  name: string;
  code: string;
  message: string;
  retryAt: Date | null;
};

export type StepFailResult = "retry_wait" | "failed" | "lost_lease";

export type FinishArgs = {
  jobId: string;
  owner: string;
  status: Extract<JobStatus, "completed" | "partial" | "failed" | "cancelled">;
  result: unknown;
  errorCode: string | null;
  errorMessage: string | null;
};

export type ReconcileResult = { deadlineExceeded: number; invocationLimit: number };

export type PruneResult = { ledger: number; holds: number };

export type JobStore = {
  enqueue(args: EnqueueArgs): Promise<EnqueueResult>;
  claimDue(owner: string, limit: number, leaseSeconds: number, jobId?: string | null): Promise<JobRow[]>;
  getJob(jobId: string): Promise<JobRow | null>;
  stepBegin(args: StepBeginArgs): Promise<StepBeginResult>;
  stepComplete(jobId: string, owner: string, name: string, output: unknown, leaseSeconds: number): Promise<boolean>;
  stepFail(args: StepFailArgs): Promise<StepFailResult>;
  sleep(jobId: string, owner: string, name: string, seconds: number): Promise<Date | null>;
  yieldJob(jobId: string, owner: string, runAt: Date): Promise<boolean>;
  progress(
    jobId: string,
    owner: string,
    done: number,
    total: number,
    label: string | null,
    leaseSeconds: number
  ): Promise<boolean>;
  finish(args: FinishArgs): Promise<boolean>;
  cancel(jobId: string): Promise<string>;
  reconcileStale(limit: number): Promise<ReconcileResult>;
  claimDuePeriodic(name: string, intervalSeconds: number, now: Date): Promise<boolean>;
  markPeriodic(name: string, error: string | null): Promise<void>;
  pruneJobs(before: Date, limit: number): Promise<number>;
  expireSpendHolds(limit: number): Promise<number>;
  pruneSpend(holdsBefore: Date, ledgerBefore: Date, limit: number): Promise<PruneResult>;
  pruneProviderCache(before: Date, limit: number): Promise<string[]>;
  removeCacheBodies(storagePaths: string[]): Promise<void>;
};

type RawRow = Record<string, unknown>;

function num(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function toStepBeginResult(raw: unknown): StepBeginResult {
  const data = (raw ?? {}) as RawRow;
  if (data.action === "run") return { action: "run", attempt: num(data.attempt) || 1 };
  if (data.action === "memoised") return { action: "memoised", output: data.output ?? null };
  if (data.action === "failed") {
    return {
      action: "failed",
      code: typeof data.error_code === "string" ? data.error_code : "step_failed",
      message: typeof data.error_message === "string" ? data.error_message : "The step failed.",
    };
  }
  if (data.action === "wait") {
    const wakeAt = isoDate(data.wake_at);
    if (wakeAt) return { action: "wait", wakeAt };
  }
  return { action: "lost_lease" };
}

export function jobStore(): JobStore {
  const admin = getSupabaseAdmin();
  if (!admin) throw new AppError(503, "storage_unavailable", "Workspace storage is unavailable.");
  return createJobStore(admin);
}

export function createJobStore(admin: SupabaseClient): JobStore {
  return {
    async enqueue(args) {
      const { data, error } = await admin.rpc("enqueue_job", {
        p_kind: args.kind,
        p_brand: args.brandKey,
        p_payload: args.payload ?? {},
        p_trigger: args.trigger,
        p_dedupe: args.dedupeKey,
        p_single_active: args.singleActiveKey,
        p_run_at: args.runAt ? args.runAt.toISOString() : null,
        p_created_by: args.createdBy,
        p_deadline_seconds: args.deadlineSeconds,
        p_max_invocations: args.maxInvocations,
      });
      if (error) throw new Error(error.message);
      const row = (data ?? {}) as RawRow;
      return {
        jobId: typeof row.job_id === "string" ? row.job_id : null,
        deduped: row.deduped === true,
        conflictJobId: typeof row.conflict_job_id === "string" ? row.conflict_job_id : null,
      };
    },

    async claimDue(owner, limit, leaseSeconds, jobId) {
      const { data, error } = await admin.rpc("claim_due_jobs", {
        p_owner: owner,
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
        p_job_id: jobId ?? null,
      });
      if (error) throw new Error(error.message);
      return (Array.isArray(data) ? data : []) as JobRow[];
    },

    async getJob(jobId) {
      const { data, error } = await admin.from("jobs").select("*").eq("id", jobId).maybeSingle();
      if (error) throw new Error(error.message);
      return (data ?? null) as JobRow | null;
    },

    async stepBegin(args) {
      const { data, error } = await admin.rpc("job_step_begin", {
        p_job: args.jobId,
        p_owner: args.owner,
        p_name: args.name,
        p_billed: args.billed,
        p_max_attempts: args.maxAttempts,
        p_timeout_ms: args.timeoutMs,
      });
      if (error) throw new Error(error.message);
      return toStepBeginResult(data);
    },

    async stepComplete(jobId, owner, name, output, leaseSeconds) {
      const { data, error } = await admin.rpc("job_step_complete", {
        p_job: jobId,
        p_owner: owner,
        p_name: name,
        p_output: output ?? null,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw new Error(error.message);
      return data === true;
    },

    async stepFail(args) {
      const { data, error } = await admin.rpc("job_step_fail", {
        p_job: args.jobId,
        p_owner: args.owner,
        p_name: args.name,
        p_code: args.code,
        p_message: args.message,
        p_retry_at: args.retryAt ? args.retryAt.toISOString() : null,
      });
      if (error) throw new Error(error.message);
      return (typeof data === "string" ? data : "failed") as StepFailResult;
    },

    async sleep(jobId, owner, name, seconds) {
      const { data, error } = await admin.rpc("job_sleep", {
        p_job: jobId,
        p_owner: owner,
        p_name: name,
        p_seconds: seconds,
      });
      if (error) throw new Error(error.message);
      return isoDate(data);
    },

    async yieldJob(jobId, owner, runAt) {
      const { data, error } = await admin.rpc("job_yield", {
        p_job: jobId,
        p_owner: owner,
        p_run_at: runAt.toISOString(),
      });
      if (error) throw new Error(error.message);
      return data === true;
    },

    async progress(jobId, owner, done, total, label, leaseSeconds) {
      const { data, error } = await admin.rpc("job_progress", {
        p_job: jobId,
        p_owner: owner,
        p_done: done,
        p_total: total,
        p_label: label,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw new Error(error.message);
      return data === true;
    },

    async finish(args) {
      const { data, error } = await admin.rpc("job_finish", {
        p_job: args.jobId,
        p_owner: args.owner,
        p_status: args.status,
        p_result: args.result ?? null,
        p_error_code: args.errorCode,
        p_error_message: args.errorMessage,
      });
      if (error) throw new Error(error.message);
      return data === true;
    },

    async cancel(jobId) {
      const { data, error } = await admin.rpc("cancel_job", { p_job: jobId });
      if (error) throw new Error(error.message);
      return typeof data === "string" ? data : "not_found";
    },

    async reconcileStale(limit) {
      const { data, error } = await admin.rpc("reconcile_stale_jobs", { p_limit: limit });
      if (error) throw new Error(error.message);
      const row = (data ?? {}) as RawRow;
      return { deadlineExceeded: num(row.deadline_exceeded), invocationLimit: num(row.invocation_limit) };
    },

    async claimDuePeriodic(name, intervalSeconds, now) {
      const { data, error } = await admin.rpc("claim_due_periodic", {
        p_name: name,
        p_interval_seconds: intervalSeconds,
        p_now: now.toISOString(),
      });
      if (error) throw new Error(error.message);
      return data === true;
    },

    async markPeriodic(name, error) {
      const patch =
        error === null
          ? { last_finished_at: new Date().toISOString(), last_error: null }
          : { last_error: error.slice(0, 500) };
      const { error: writeError } = await admin.from("job_periodic").update(patch).eq("name", name);
      if (writeError) throw new Error(writeError.message);
    },

    async pruneJobs(before, limit) {
      const { data, error } = await admin.rpc("prune_jobs", {
        p_before: before.toISOString(),
        p_limit: limit,
      });
      if (error) throw new Error(error.message);
      return num(data);
    },

    async expireSpendHolds(limit) {
      const { data, error } = await admin.rpc("expire_spend_holds", { p_limit: limit });
      if (error) throw new Error(error.message);
      return num(data);
    },

    async pruneSpend(holdsBefore, ledgerBefore, limit) {
      const { data, error } = await admin.rpc("prune_spend", {
        p_holds_before: holdsBefore.toISOString(),
        p_ledger_before: ledgerBefore.toISOString(),
        p_limit: limit,
      });
      if (error) throw new Error(error.message);
      const row = (data ?? {}) as RawRow;
      return { ledger: num(row.ledger), holds: num(row.holds) };
    },

    async pruneProviderCache(before, limit) {
      const { data, error } = await admin.rpc("prune_provider_cache", {
        p_expired_before: before.toISOString(),
        p_limit: limit,
      });
      if (error) throw new Error(error.message);
      if (!Array.isArray(data)) return [];
      return data.filter((path): path is string => typeof path === "string");
    },

    async removeCacheBodies(storagePaths) {
      if (storagePaths.length === 0) return;
      const { error } = await admin.storage.from("provider-cache").remove(storagePaths);
      if (error) throw new Error(error.message);
    },
  };
}
