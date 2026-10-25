import { randomUUID } from "node:crypto";
import type {
  CachePruneResult,
  EnqueueArgs,
  EnqueueResult,
  FinishArgs,
  JobStore,
  PruneResult,
  ReconcileResult,
  StepBeginArgs,
  StepBeginResult,
  StepFailArgs,
  StepFailResult,
} from "./store.ts";
import type { JobRow, JobStatus, JobTrigger } from "./types.ts";

export type MemoryJob = {
  id: string;
  brand_key: string | null;
  kind: string;
  payload: unknown;
  trigger: JobTrigger;
  status: JobStatus;
  dedupe_key: string | null;
  single_active_key: string | null;
  run_at: number;
  deadline_at: number;
  invocations: number;
  max_invocations: number;
  lease_owner: string | null;
  lease_until: number | null;
  progress_done: number | null;
  progress_total: number | null;
  progress_label: string | null;
  result: unknown;
  error_code: string | null;
  error_message: string | null;
  cancel_requested_at: number | null;
  created_by: string | null;
  created_at: number;
  started_at: number | null;
  heartbeat_at: number | null;
  finished_at: number | null;
};

export type MemoryStep = {
  job_id: string;
  name: string;
  step_kind: "do" | "sleep";
  status: "running" | "retry_wait" | "sleeping" | "completed" | "failed";
  billed: boolean;
  attempts: number;
  max_attempts: number;
  timeout_ms: number;
  output: unknown;
  error_code: string | null;
  error_message: string | null;
  wake_at: number | null;
  started_at: number;
  finished_at: number | null;
};

export type MemoryPeriodic = {
  name: string;
  interval_seconds: number;
  next_run_at: number;
  enabled: boolean;
  last_started_at: number | null;
  last_finished_at: number | null;
  last_error: string | null;
};

export type MemoryJobStoreSeed = { now?: () => number };

export type MemoryJobStore = JobStore & {
  jobs: Map<string, MemoryJob>;
  steps: Map<string, MemoryStep>;
  periodics: Map<string, MemoryPeriodic>;
  /** Seed for `pruneProviderCache`: a null stands for a deleted inline row. */
  prunedCachePaths: (string | null)[];
  removedCacheBodies: string[][];
};

const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

function toRow(job: MemoryJob): JobRow {
  return {
    id: job.id,
    brand_key: job.brand_key,
    kind: job.kind,
    payload: job.payload,
    trigger: job.trigger,
    status: job.status,
    dedupe_key: job.dedupe_key,
    single_active_key: job.single_active_key,
    run_at: iso(job.run_at) as string,
    deadline_at: iso(job.deadline_at) as string,
    invocations: job.invocations,
    max_invocations: job.max_invocations,
    lease_owner: job.lease_owner,
    lease_until: iso(job.lease_until),
    progress_done: job.progress_done,
    progress_total: job.progress_total,
    progress_label: job.progress_label,
    result: job.result,
    error_code: job.error_code,
    error_message: job.error_message,
    cancel_requested_at: iso(job.cancel_requested_at),
    created_by: job.created_by,
    created_at: iso(job.created_at) as string,
    updated_at: iso(job.heartbeat_at ?? job.created_at) as string,
    started_at: iso(job.started_at),
    heartbeat_at: iso(job.heartbeat_at),
    finished_at: iso(job.finished_at),
  };
}

const TERMINAL: readonly JobStatus[] = ["completed", "partial", "failed", "cancelled"];

function stepKey(jobId: string, name: string): string {
  return jobId + ":" + name;
}

export function createMemoryJobStore(seed: MemoryJobStoreSeed = {}): MemoryJobStore {
  const now = seed.now ?? Date.now;
  const jobs = new Map<string, MemoryJob>();
  const steps = new Map<string, MemoryStep>();
  const periodics = new Map<string, MemoryPeriodic>();
  const prunedCachePaths: (string | null)[] = [];
  const removedCacheBodies: string[][] = [];

  const fenced = (jobId: string, owner: string): boolean => {
    const job = jobs.get(jobId);
    if (!job) return false;
    return job.lease_owner === owner && job.lease_until !== null && job.lease_until >= now() && job.status === "running";
  };

  return {
    jobs,
    steps,
    periodics,
    prunedCachePaths,
    removedCacheBodies,

    async enqueue(args: EnqueueArgs): Promise<EnqueueResult> {
      if (!Number.isInteger(args.deadlineSeconds) || args.deadlineSeconds < 60 || args.deadlineSeconds > 7 * 86_400) {
        throw new Error("invalid job deadline");
      }
      if (args.dedupeKey !== null) {
        for (const job of jobs.values()) {
          if (job.kind !== args.kind || job.brand_key !== args.brandKey) continue;
          if (job.dedupe_key === args.dedupeKey) return { jobId: job.id, deduped: true, conflictJobId: null };
        }
      }
      if (args.singleActiveKey !== null) {
        for (const job of jobs.values()) {
          if (job.kind !== args.kind || job.single_active_key !== args.singleActiveKey) continue;
          if (job.status === "queued" || job.status === "running") {
            return { jobId: null, deduped: false, conflictJobId: job.id };
          }
        }
      }
      const at = now();
      const job: MemoryJob = {
        id: randomUUID(),
        brand_key: args.brandKey,
        kind: args.kind,
        payload: args.payload ?? {},
        trigger: args.trigger,
        status: "queued",
        dedupe_key: args.dedupeKey,
        single_active_key: args.singleActiveKey,
        run_at: args.runAt === null ? at : args.runAt.getTime(),
        deadline_at: (args.runAt === null ? at : args.runAt.getTime()) + args.deadlineSeconds * 1000,
        invocations: 0,
        max_invocations: args.maxInvocations ?? 200,
        lease_owner: null,
        lease_until: null,
        progress_done: null,
        progress_total: null,
        progress_label: null,
        result: null,
        error_code: null,
        error_message: null,
        cancel_requested_at: null,
        created_by: args.createdBy,
        created_at: at,
        started_at: null,
        heartbeat_at: null,
        finished_at: null,
      };
      jobs.set(job.id, job);
      return { jobId: job.id, deduped: false, conflictJobId: null };
    },

    async claimDue(owner, limit, leaseSeconds, jobId) {
      if (limit < 1 || limit > 50 || leaseSeconds < 30 || leaseSeconds > 900) throw new Error("invalid claim");
      const at = now();
      const due = [...jobs.values()]
        .filter(
          (job) =>
            (job.status === "queued" || job.status === "running") &&
            job.run_at <= at &&
            (job.lease_until === null || job.lease_until < at) &&
            (jobId === undefined || jobId === null || job.id === jobId)
        )
        .sort((a, b) => a.run_at - b.run_at || a.created_at - b.created_at)
        .slice(0, limit);
      for (const job of due) {
        job.status = "running";
        job.lease_owner = owner;
        job.lease_until = at + leaseSeconds * 1000;
        job.invocations += 1;
        job.started_at = job.started_at ?? at;
        job.heartbeat_at = at;
      }
      return due.map(toRow);
    },

    async getJob(jobId) {
      const job = jobs.get(jobId);
      return job ? toRow(job) : null;
    },

    async stepBegin(args: StepBeginArgs): Promise<StepBeginResult> {
      if (!fenced(args.jobId, args.owner)) return { action: "lost_lease" };
      if (args.billed && args.maxAttempts !== 1) throw new Error("billed step must have one attempt");
      const key = stepKey(args.jobId, args.name);
      const step = steps.get(key);
      if (!step) {
        steps.set(key, {
          job_id: args.jobId,
          name: args.name,
          step_kind: "do",
          status: "running",
          billed: args.billed,
          attempts: 1,
          max_attempts: args.maxAttempts,
          timeout_ms: args.timeoutMs,
          output: null,
          error_code: null,
          error_message: null,
          wake_at: null,
          started_at: now(),
          finished_at: null,
        });
        return { action: "run", attempt: 1 };
      }
      if (step.step_kind !== "do") throw new Error(`step name ${args.name} already used by a sleep`);
      if (step.status === "completed") return { action: "memoised", output: step.output };
      if (step.status === "failed") {
        return {
          action: "failed",
          code: step.error_code ?? "step_failed",
          message: step.error_message ?? "The step failed.",
        };
      }
      if (step.status === "retry_wait" && step.wake_at !== null && step.wake_at > now()) {
        return { action: "wait", wakeAt: new Date(step.wake_at) };
      }
      if (step.status === "running" && step.billed) {
        step.status = "failed";
        step.error_code = "billed_step_interrupted";
        step.error_message = "A billed step was interrupted; it is never re-run.";
        step.finished_at = now();
        return {
          action: "failed",
          code: "billed_step_interrupted",
          message: "A billed step was interrupted; it is never re-run.",
        };
      }
      if (step.attempts >= step.max_attempts) {
        step.status = "failed";
        step.error_code = "step_attempts_exhausted";
        step.finished_at = now();
        step.wake_at = null;
        return {
          action: "failed",
          code: "step_attempts_exhausted",
          message: step.error_message ?? "Step failed after its retry budget.",
        };
      }
      step.status = "running";
      step.attempts += 1;
      step.wake_at = null;
      step.started_at = now();
      return { action: "run", attempt: step.attempts };
    },

    async stepComplete(jobId, owner, name, output, leaseSeconds) {
      if (!fenced(jobId, owner)) return false;
      const step = steps.get(stepKey(jobId, name));
      if (step && step.status === "running") {
        step.status = "completed";
        step.output = output;
        step.finished_at = now();
        step.error_code = null;
        step.error_message = null;
      }
      const job = jobs.get(jobId) as MemoryJob;
      job.lease_until = now() + leaseSeconds * 1000;
      job.heartbeat_at = now();
      return true;
    },

    async stepFail(args: StepFailArgs): Promise<StepFailResult> {
      if (!fenced(args.jobId, args.owner)) return "lost_lease";
      const step = steps.get(stepKey(args.jobId, args.name));
      if (!step) throw new Error("step not found");
      if (args.retryAt !== null && !step.billed && step.attempts < step.max_attempts) {
        step.status = "retry_wait";
        step.wake_at = args.retryAt.getTime();
        step.error_code = args.code;
        step.error_message = args.message.slice(0, 500);
        return "retry_wait";
      }
      step.status = "failed";
      step.error_code = args.code;
      step.error_message = args.message.slice(0, 500);
      step.finished_at = now();
      step.wake_at = null;
      return "failed";
    },

    async sleep(jobId, owner, name, seconds) {
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400) throw new Error("invalid sleep");
      if (!fenced(jobId, owner)) throw new Error("lost_lease");
      const key = stepKey(jobId, name);
      const step = steps.get(key);
      if (!step) {
        const wake = now() + seconds * 1000;
        steps.set(key, {
          job_id: jobId,
          name,
          step_kind: "sleep",
          status: "sleeping",
          billed: false,
          attempts: 1,
          max_attempts: 1,
          timeout_ms: 1,
          output: null,
          error_code: null,
          error_message: null,
          wake_at: wake,
          started_at: now(),
          finished_at: null,
        });
        return new Date(wake);
      }
      if (step.step_kind !== "sleep") throw new Error(`step name ${name} already used by a do`);
      if (step.status === "completed") return null;
      if (step.wake_at !== null && step.wake_at > now()) return new Date(step.wake_at);
      step.status = "completed";
      step.wake_at = null;
      step.finished_at = now();
      return null;
    },

    async yieldJob(jobId, owner, runAt) {
      const job = jobs.get(jobId);
      if (!job || job.lease_owner !== owner || job.status !== "running") return false;
      job.lease_owner = null;
      job.lease_until = null;
      job.run_at = runAt.getTime();
      job.heartbeat_at = now();
      return true;
    },

    async progress(jobId, owner, done, total, label, leaseSeconds) {
      const job = jobs.get(jobId);
      if (!job) return false;
      if (job.lease_owner !== owner || job.lease_until === null || job.lease_until < now()) return false;
      if (job.status !== "running") return false;
      job.progress_done = done;
      job.progress_total = total;
      job.progress_label = label === null ? null : label.slice(0, 120);
      job.lease_until = now() + leaseSeconds * 1000;
      job.heartbeat_at = now();
      return true;
    },

    async finish(args: FinishArgs) {
      if (!["completed", "partial", "failed", "cancelled"].includes(args.status)) {
        throw new Error("invalid terminal status");
      }
      const job = jobs.get(args.jobId);
      if (!job || job.lease_owner !== args.owner || job.status !== "running") return false;
      job.status = args.status;
      job.result = args.result ?? null;
      job.error_code = args.errorCode;
      job.error_message = args.errorMessage === null ? null : args.errorMessage.slice(0, 500);
      job.finished_at = now();
      job.lease_owner = null;
      job.lease_until = null;
      return true;
    },

    async cancel(jobId) {
      const job = jobs.get(jobId);
      if (!job) return "not_found";
      if (TERMINAL.includes(job.status)) return job.status;
      if (job.status === "queued" || job.lease_until === null || job.lease_until < now()) {
        job.status = "cancelled";
        job.cancel_requested_at = job.cancel_requested_at ?? now();
        job.finished_at = now();
        job.lease_owner = null;
        job.lease_until = null;
        job.error_code = "cancelled";
        job.error_message = "Cancelled.";
        return "cancelled";
      }
      job.cancel_requested_at = job.cancel_requested_at ?? now();
      return "cancel_requested";
    },

    async reconcileStale(limit): Promise<ReconcileResult> {
      const at = now();
      const expired = [...jobs.values()]
        .filter(
          (job) =>
            (job.status === "queued" || job.status === "running") &&
            job.deadline_at < at &&
            (job.lease_until === null || job.lease_until < at)
        )
        .sort((a, b) => a.deadline_at - b.deadline_at)
        .slice(0, limit);
      for (const job of expired) {
        job.status = "failed";
        job.error_code = "deadline_exceeded";
        job.error_message = "The job did not finish before its deadline.";
        job.finished_at = at;
        job.lease_owner = null;
        job.lease_until = null;
      }
      const runaway = [...jobs.values()]
        .filter(
          (job) =>
            (job.status === "queued" || job.status === "running") &&
            job.invocations >= job.max_invocations &&
            (job.lease_until === null || job.lease_until < at)
        )
        .sort((a, b) => a.created_at - b.created_at)
        .slice(0, limit);
      for (const job of runaway) {
        job.status = "failed";
        job.error_code = "invocation_limit";
        job.error_message = "The job resumed too many times without finishing.";
        job.finished_at = at;
        job.lease_owner = null;
        job.lease_until = null;
      }
      return { deadlineExceeded: expired.length, invocationLimit: runaway.length };
    },

    async claimDuePeriodic(name, intervalSeconds, at: Date) {
      const atMs = at.getTime();
      const existing = periodics.get(name);
      if (!existing) {
        periodics.set(name, {
          name,
          interval_seconds: intervalSeconds,
          next_run_at: atMs,
          enabled: true,
          last_started_at: null,
          last_finished_at: null,
          last_error: null,
        });
      } else {
        existing.interval_seconds = intervalSeconds;
      }
      const row = periodics.get(name) as MemoryPeriodic;
      if (!row.enabled || row.next_run_at > atMs) return false;
      let next = row.next_run_at;
      while (next <= atMs) next += intervalSeconds * 1000;
      row.next_run_at = next;
      row.last_started_at = atMs;
      row.last_error = null;
      return true;
    },

    async markPeriodic(name, error) {
      const row = periodics.get(name);
      if (!row) throw new Error("periodic not found");
      if (error === null) {
        row.last_finished_at = now();
        row.last_error = null;
      } else {
        row.last_error = error.slice(0, 500);
      }
    },

    async pruneJobs(before, limit) {
      const cutoff = before.getTime();
      const old = [...jobs.values()]
        .filter((job) => job.finished_at !== null && job.finished_at < cutoff)
        .sort((a, b) => (a.finished_at as number) - (b.finished_at as number))
        .slice(0, limit);
      for (const job of old) {
        jobs.delete(job.id);
        for (const key of [...steps.keys()]) {
          if (key.startsWith(job.id + ":")) steps.delete(key);
        }
      }
      return old.length;
    },

    async expireSpendHolds() {
      return 0;
    },

    async pruneSpend(): Promise<PruneResult> {
      return { ledger: 0, holds: 0 };
    },

    async pruneProviderCache(): Promise<CachePruneResult> {
      const rows = [...prunedCachePaths.splice(0)];
      return {
        deleted: rows.length,
        paths: rows.filter((path): path is string => typeof path === "string" && path.length > 0),
      };
    },

    async removeCacheBodies(storagePaths: string[]) {
      removedCacheBodies.push([...storagePaths]);
    },
  };
}
