import { AppError } from "../http/errors.ts";
import { getJobDefinition } from "./registry.ts";
import type { JobStore } from "./store.ts";
import type { JobContext, JobRow, JobStatus, StepOptions } from "./types.ts";

export const LEASE_SECONDS = 300;
export const MAX_STEP_TIMEOUT_MS = 230_000;

const CANCEL_CACHE_MS = 5_000;
const BUDGET_GUARD_MS = 10_000;
const PROGRESS_MIN_INTERVAL_MS = 1_000;
const MAX_STEP_RETRIES = 5;
const MAX_STEP_NAME = 200;
const MAX_OUTPUT_BYTES = 65_536;
const MAX_RETRY_DELAY_MS = 60_000;
const IN_PROCESS_WAIT_MS = 10_000;

export type RunEnv = {
  store: JobStore;
  owner: string;
  deadlineMs: number;
  now(): number;
  selfContinue(jobId: string): unknown;
  logger?: Pick<Console, "error" | "warn">;
};

export type RunOutcome = "completed" | "partial" | "failed" | "cancelled" | "yielded" | "lost_lease";

/** Thrown at the handler when a step has permanently failed, so it can finish `partial`. */
export class StepFailedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "StepFailedError";
    this.code = code;
  }
}

class JobYield extends Error {}
class JobCancelled extends Error {}
class LostLease extends Error {}
class StepTimeoutError extends Error {}

/** The `idempotencyKey` convention for a paid call inside a job step. */
export function jobStepKey(ctx: { jobId: string }, stepName: string): string {
  return `job:${ctx.jobId}:${stepName}`;
}

/** Strips query strings, which can carry tokens, out of anything stored or logged. */
export function redactForLog(message: string): string {
  return message.replace(/https?:\/\/[^\s"')]+/g, (url) => url.split("?")[0]);
}

type RunState = {
  names: Set<string>;
  cancelCacheUntil: number;
  cancelCached: boolean;
  lastProgressAt: number;
  pendingProgress: { done: number; total: number; label: string | null } | null;
};

type FinishArgs = {
  status: Extract<JobStatus, "completed" | "partial" | "failed" | "cancelled">;
  result?: unknown;
  errorCode: string | null;
  errorMessage: string | null;
};

function jsonBytes(value: unknown): { ok: true; json: unknown; bytes: number } | { ok: false; code: string; message: string } {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    return { ok: false, code: "step_output_not_json", message: "The step returned a value that is not JSON." };
  }
  if (text === undefined) {
    return { ok: false, code: "step_output_not_json", message: "The step returned a value that is not JSON." };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, code: "step_output_not_json", message: "The step returned a value that is not JSON." };
  }
  if (JSON.stringify(json) !== text) {
    return { ok: false, code: "step_output_not_json", message: "The step returned a value that does not round-trip as JSON." };
  }
  const bytes = new TextEncoder().encode(text).length;
  if (bytes >= MAX_OUTPUT_BYTES) {
    return {
      ok: false,
      code: "step_output_too_large",
      message: `The step returned ${bytes} bytes; the limit is ${MAX_OUTPUT_BYTES}. Put bulk data in a table.`,
    };
  }
  return { ok: true, json, bytes };
}

function stepErrorCode(err: unknown): string {
  if (err instanceof StepTimeoutError) return "step_timeout";
  if (err instanceof StepFailedError) return err.code;
  if (err instanceof AppError) return err.code;
  return "step_failed";
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));
}

function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StepTimeoutError("The step ran past its timeout.")), timeoutMs);
    fn().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

function validateStepName(name: string, state: RunState): void {
  if (typeof name !== "string" || name.length < 1 || name.length > MAX_STEP_NAME) {
    throw new AppError(500, "invalid_step_name", "A step name must be 1–200 characters.");
  }
  if (state.names.has(name)) {
    throw new AppError(500, "duplicate_step_name", "A step name may appear once in a job, as a step or a sleep.");
  }
  state.names.add(name);
}

function validateStep(name: string, opts: StepOptions, state: RunState): void {
  if (opts.billed === true && opts.retries > 0) {
    throw new AppError(500, "billed_step_retries", "A billed step cannot retry: a retry could bill twice.");
  }
  if (!Number.isInteger(opts.retries) || opts.retries < 0 || opts.retries > MAX_STEP_RETRIES) {
    throw new AppError(500, "invalid_step_options", "A step's retry budget must be an integer from 0 to 5.");
  }
  if (!Number.isInteger(opts.timeoutMs) || opts.timeoutMs < 1 || opts.timeoutMs > MAX_STEP_TIMEOUT_MS) {
    throw new AppError(500, "invalid_step_options", "A step's timeout must be 1–230,000 ms.");
  }
  validateStepName(name, state);
}

/**
 * Replays one job handler. Every invocation calls it from the top; completed
 * steps return their memoised output instead of running again, so anything
 * outside a step must be deterministic and free of side effects.
 */
export async function runJob(job: JobRow, env: RunEnv): Promise<RunOutcome> {
  const now = env.now;
  const state: RunState = {
    names: new Set(),
    cancelCacheUntil: 0,
    cancelCached: false,
    lastProgressAt: 0,
    pendingProgress: null,
  };

  const finish = async (args: FinishArgs): Promise<"ok" | "lost_lease" | "error"> => {
    try {
      const written = await env.store.finish({
        jobId: job.id,
        owner: env.owner,
        status: args.status,
        result: args.result ?? null,
        errorCode: args.errorCode,
        errorMessage: args.errorMessage,
      });
      return written ? "ok" : "lost_lease";
    } catch (err) {
      env.logger?.error?.("[jobs] finish failed", {
        jobId: job.id,
        code: args.errorCode,
        reason: err instanceof Error ? err.name : typeof err,
      });
      return "error";
    }
  };

  const settle = async (outcome: RunOutcome, args: FinishArgs): Promise<RunOutcome> => {
    const written = await finish(args);
    // A finish that threw left the row `running`, so this invocation did not
    // settle the job: the watchdog owns it now. Reporting `outcome` here would
    // count an unsettled job as completed.
    return written === "ok" ? outcome : "lost_lease";
  };

  const def = getJobDefinition(job.kind);
  if (!def) {
    return settle("failed", {
      status: "failed",
      errorCode: "unknown_job_kind",
      errorMessage: "This job kind is not registered.",
    });
  }

  let payload: unknown = job.payload;
  if (def.payloadSchema) {
    const parsed = def.payloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      return settle("failed", {
        status: "failed",
        errorCode: "invalid_payload",
        errorMessage: "The job payload does not match its definition.",
      });
    }
    payload = parsed.data;
  }

  const cancelRequested = async (): Promise<boolean> => {
    const at = now();
    if (at < state.cancelCacheUntil) return state.cancelCached;
    state.cancelCacheUntil = at + CANCEL_CACHE_MS;
    try {
      const row = await env.store.getJob(job.id);
      state.cancelCached = Boolean(row?.cancel_requested_at);
    } catch {
      // A cancellation check never fails the job: the next step's own writes are fenced anyway.
      state.cancelCached = false;
    }
    return state.cancelCached;
  };

  const budgetAllows = (timeoutMs: number): boolean => env.deadlineMs - now() >= timeoutMs + BUDGET_GUARD_MS;

  const yieldUntil = async (runAt: Date): Promise<never> => {
    const released = await env.store.yieldJob(job.id, env.owner, runAt);
    if (!released) throw new LostLease();
    if (runAt.getTime() <= now() + 5_000) env.selfContinue(job.id);
    throw new JobYield();
  };

  const failStep = async (
    name: string,
    attempt: number,
    maxAttempts: number,
    billed: boolean,
    err: unknown,
    timeoutMs: number
  ): Promise<never | void> => {
    const code = stepErrorCode(err);
    const message = redactForLog(err instanceof Error ? err.message : String(err));
    const canRetry = !billed && attempt < maxAttempts;
    if (!canRetry) {
      const finalCode = billed ? code : "step_attempts_exhausted";
      const result = await env.store.stepFail({
        jobId: job.id,
        owner: env.owner,
        name,
        code: finalCode,
        message,
        retryAt: null,
      });
      if (result === "lost_lease") throw new LostLease();
      throw new StepFailedError(finalCode, message);
    }
    const retryAt = new Date(now() + Math.min(2 ** attempt * 2_000, MAX_RETRY_DELAY_MS));
    const result = await env.store.stepFail({ jobId: job.id, owner: env.owner, name, code, message, retryAt });
    if (result === "lost_lease") throw new LostLease();
    // The row was written with `code`, and a replay reads it back out of
    // job_step_begin, so the first pass has to throw the same code.
    if (result === "failed") throw new StepFailedError(code, message);
    if (retryAt.getTime() - now() <= IN_PROCESS_WAIT_MS && budgetAllows(timeoutMs)) {
      await waitMs(retryAt.getTime() - now());
      return;
    }
    await yieldUntil(retryAt);
  };

  const step = {
    async do<T>(name: string, opts: StepOptions, fn: () => Promise<T>): Promise<T> {
      validateStep(name, opts, state);
      const billed = opts.billed === true;
      const maxAttempts = billed ? 1 : opts.retries + 1;
      for (;;) {
        if (await cancelRequested()) throw new JobCancelled();
        if (!budgetAllows(opts.timeoutMs)) await yieldUntil(new Date(now()));
        const begin = await env.store.stepBegin({
          jobId: job.id,
          owner: env.owner,
          name,
          billed,
          maxAttempts,
          timeoutMs: opts.timeoutMs,
        });
        const attempt = begin.action === "run" ? begin.attempt : 1;
        if (begin.action === "lost_lease") throw new LostLease();
        if (begin.action === "memoised") return begin.output as T;
        if (begin.action === "failed") throw new StepFailedError(begin.code, begin.message);
        if (begin.action === "wait") await yieldUntil(begin.wakeAt);

        let value: T;
        try {
          value = await withTimeout(fn, opts.timeoutMs);
        } catch (err) {
          await failStep(name, attempt, maxAttempts, billed, err, opts.timeoutMs);
          continue;
        }
        const output = jsonBytes(value);
        if (!output.ok) {
          await env.store.stepFail({
            jobId: job.id,
            owner: env.owner,
            name,
            code: output.code,
            message: output.message,
            retryAt: null,
          });
          throw new StepFailedError(output.code, output.message);
        }
        const completed = await env.store.stepComplete(job.id, env.owner, name, output.json, LEASE_SECONDS);
        if (!completed) throw new LostLease();
        return value;
      }
    },

    async sleep(name: string, seconds: number): Promise<void> {
      validateStepName(name, state);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > 86_400) {
        throw new AppError(500, "invalid_sleep", "A sleep must be 1–86,400 seconds.");
      }
      for (;;) {
        if (await cancelRequested()) throw new JobCancelled();
        const wake = await env.store.sleep(job.id, env.owner, name, seconds);
        if (wake === null) return;
        const delay = wake.getTime() - now();
        if (delay <= IN_PROCESS_WAIT_MS && wake.getTime() + IN_PROCESS_WAIT_MS <= env.deadlineMs) {
          await waitMs(delay);
          continue;
        }
        await yieldUntil(wake);
      }
    },
  };

  const writeProgress = async (done: number, total: number, label: string | null): Promise<void> => {
    state.lastProgressAt = now();
    state.pendingProgress = null;
    const written = await env.store.progress(job.id, env.owner, done, total, label, LEASE_SECONDS);
    if (!written) throw new LostLease();
  };

  const progress = async (done: number, total: number, label?: string): Promise<void> => {
    const at = now();
    if (state.lastProgressAt !== 0 && at - state.lastProgressAt < PROGRESS_MIN_INTERVAL_MS) {
      // Held, not dropped: flushProgress writes the last one the throttle ate,
      // so a fast loop's final progress(10, 10) still lands on the row.
      state.pendingProgress = { done, total, label: label ?? null };
      return;
    }
    await writeProgress(done, total, label ?? null);
  };

  const flushProgress = async (): Promise<void> => {
    const pending = state.pendingProgress;
    if (!pending) return;
    await writeProgress(pending.done, pending.total, pending.label);
  };

  const ctx: JobContext<unknown> = {
    jobId: job.id,
    brandKey: job.brand_key ?? "",
    payload,
    trigger: job.trigger,
    step,
    progress,
    cancelRequested,
  };

  try {
    const outcome = await def.handler(ctx);
    await flushProgress();
    const status =
      outcome?.status === "partial" ||
      outcome?.status === "failed" ||
      outcome?.status === "cancelled"
        ? outcome.status
        : "completed";
    const value = outcome?.result ?? null;
    if (value !== null) {
      const size = jsonBytes(value);
      if (!size.ok) {
        return settle("failed", {
          status: "failed",
          errorCode: size.code === "step_output_too_large" ? "result_too_large" : "result_not_json",
          errorMessage: size.message,
        });
      }
    }
    return settle(status, { status, result: value, errorCode: null, errorMessage: null });
  } catch (err) {
    if (err instanceof JobYield) return "yielded";
    if (err instanceof LostLease) return "lost_lease";
    if (err instanceof JobCancelled) {
      return settle("cancelled", { status: "cancelled", errorCode: "cancelled", errorMessage: "Cancelled." });
    }
    const code =
      err instanceof AppError || err instanceof StepFailedError
        ? err.code
        : "job_failed";
    const message = redactForLog(err instanceof Error ? err.message : String(err));
    return settle("failed", { status: "failed", errorCode: code, errorMessage: message });
  }
}
