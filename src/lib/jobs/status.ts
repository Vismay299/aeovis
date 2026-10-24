import { AppError } from "../http/errors.ts";
import { getJobDefinition } from "./registry.ts";
import { jobStore } from "./store.ts";
import type { JobStore } from "./store.ts";
import type { JobProgress, JobRow, JobStatus } from "./types.ts";

export const MIN_POLL_SECONDS = 5;
export const MAX_POLL_SECONDS = 60;

export type JobStatusResult = {
  status: JobStatus;
  progress: JobProgress | null;
  pollAfterSeconds: number | null;
  result: unknown;
  error: { code: string; message: string } | null;
};

export type StatusDeps = { store?: JobStore; now?: () => number };

const TERMINAL: readonly JobStatus[] = ["completed", "partial", "failed", "cancelled"];

function clampSeconds(seconds: number): number {
  return Math.min(MAX_POLL_SECONDS, Math.max(MIN_POLL_SECONDS, Math.round(seconds)));
}

/**
 * Terminal: null. A job due later (queued ahead, or sleeping) polls on its own
 * delay. Otherwise the kind's own interval, else 20 s for a scheduled run and
 * 5 s for a manual one.
 */
export function pollAfterFor(
  job: JobRow,
  def: { pollAfterSeconds?: number } | undefined,
  now: number
): number | null {
  if (TERMINAL.includes(job.status)) return null;
  const runAt = Date.parse(job.run_at);
  if (Number.isFinite(runAt) && runAt > now) return clampSeconds(Math.ceil((runAt - now) / 1000));
  if (def?.pollAfterSeconds !== undefined) return clampSeconds(def.pollAfterSeconds);
  return job.trigger === "scheduled" ? 20 : 5;
}

export async function getJobStatus(jobId: string, deps?: StatusDeps): Promise<JobStatusResult> {
  const store = deps?.store ?? jobStore();
  const job = await store.getJob(jobId);
  if (!job) throw new AppError(404, "job_not_found", "This job does not exist in this workspace.");

  const now = (deps?.now ?? Date.now)();
  const progress =
    job.progress_done !== null && job.progress_total !== null
      ? {
          done: job.progress_done,
          total: job.progress_total,
          ...(job.progress_label ? { label: job.progress_label } : {}),
        }
      : null;
  const result = job.status === "completed" || job.status === "partial" ? job.result ?? null : null;
  const error =
    job.status === "failed" || job.status === "cancelled"
      ? {
          code: job.error_code ?? "job_failed",
          message: job.error_message ?? "The job did not finish.",
        }
      : null;

  return {
    status: job.status,
    progress,
    pollAfterSeconds: pollAfterFor(job, getJobDefinition(job.kind), now),
    result,
    error,
  };
}
