import type { ZodType } from "zod";

export type JobStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";

export type JobTrigger = "manual" | "scheduled" | "baseline" | "system";

export type StepOptions = { timeoutMs: number; retries: number; billed?: boolean };

export type JobProgress = { done: number; total: number; label?: string };

export type JobResult = { status?: "completed" | "partial" | "failed" | "cancelled"; result?: unknown };

export type JobContext<P> = {
  jobId: string;
  brandKey: string;
  payload: P;
  trigger: JobTrigger;
  step: {
    do<T>(name: string, opts: StepOptions, fn: () => Promise<T>): Promise<T>;
    sleep(name: string, seconds: number): Promise<void>;
  };
  progress(done: number, total: number, label?: string): Promise<void>;
  cancelRequested?(): Promise<boolean>;
};

export type JobDefinition<P = unknown> = {
  kind: string;
  handler: (ctx: JobContext<P>) => Promise<JobResult>;
  payloadSchema?: ZodType<P>;
  pollAfterSeconds?: number;
  deadlineSeconds?: number;
  maxInvocations?: number;
};

export type JobRow = {
  id: string;
  brand_key: string | null;
  kind: string;
  payload: unknown;
  trigger: JobTrigger;
  status: JobStatus;
  dedupe_key: string | null;
  single_active_key: string | null;
  run_at: string;
  deadline_at: string;
  invocations: number;
  max_invocations: number;
  lease_owner: string | null;
  lease_until: string | null;
  progress_done: number | null;
  progress_total: number | null;
  progress_label: string | null;
  result: unknown;
  error_code: string | null;
  error_message: string | null;
  cancel_requested_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
};
