import { AppError } from "../http/errors.ts";
import { makeSelfContinue } from "../selfContinue.js";
import { getJobDefinition } from "./registry.ts";
import { jobStore } from "./store.ts";
import type { EnqueueResult, JobStore } from "./store.ts";
import type { JobTrigger } from "./types.ts";

/** §6.3.3: an interactive job should set its own, shorter deadline. */
export const DEFAULT_DEADLINE_SECONDS = 86_400;
export const MAX_PAYLOAD_BYTES = 32_768;
const IMMEDIATE_RUN_MS = 5_000;

export type EnqueueDeps = {
  store?: JobStore;
  now?: () => number;
  selfContinue?: (jobId: string) => unknown;
};

export type EnqueueOptions = {
  brandKey: string;
  dedupeKey?: string;
  singleActiveKey?: string;
  runAt?: Date;
  trigger?: "manual" | "scheduled" | "baseline";
  createdBy?: string;
};

export type SystemEnqueueOptions = {
  dedupeKey?: string;
  singleActiveKey?: string;
  runAt?: Date;
};

let defaultSelfContinue: ((jobId: string) => unknown) | null = null;

function continueTick(jobId: string, deps?: EnqueueDeps): void {
  const send =
    deps?.selfContinue ??
    (defaultSelfContinue ??= makeSelfContinue({ routePath: "/api/jobs/tick", label: "jobs" }));
  send(jobId);
}

function assertEnqueueable(kind: string, payload: unknown): void {
  const def = getJobDefinition(kind);
  if (!def) {
    throw new AppError(500, "unknown_job_kind", "This job kind is not registered.");
  }
  let text: string | undefined;
  try {
    text = JSON.stringify(payload ?? {});
  } catch {
    throw new AppError(500, "invalid_payload", "The job payload is not JSON.");
  }
  if (text === undefined) {
    throw new AppError(500, "invalid_payload", "The job payload is not JSON.");
  }
  if (text.length >= MAX_PAYLOAD_BYTES) {
    throw new AppError(500, "payload_too_large", "The job payload is too large; put bulk data in a table.");
  }
  if (def.payloadSchema && !def.payloadSchema.safeParse(payload).success) {
    throw new AppError(500, "invalid_payload", "The job payload does not match its definition.");
  }
}

async function enqueue(
  kind: string,
  payload: unknown,
  trigger: JobTrigger,
  opts: { brandKey: string | null; dedupeKey?: string; singleActiveKey?: string; runAt?: Date; createdBy?: string },
  deps?: EnqueueDeps
): Promise<{ jobId: string; deduped: boolean }> {
  assertEnqueueable(kind, payload);
  const def = getJobDefinition(kind);
  const store = deps?.store ?? jobStore();
  const now = (deps?.now ?? Date.now)();
  const runAt = opts.runAt ?? null;

  const result: EnqueueResult = await store.enqueue({
    kind,
    brandKey: opts.brandKey,
    payload: payload ?? {},
    trigger,
    dedupeKey: opts.dedupeKey ?? null,
    singleActiveKey: opts.singleActiveKey ?? null,
    runAt,
    createdBy: opts.createdBy ?? null,
    deadlineSeconds: def?.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS,
    maxInvocations: def?.maxInvocations ?? null,
  });

  if (result.conflictJobId) {
    throw new AppError(409, "job_already_running", "This is already running.", {
      details: { activeJobId: result.conflictJobId },
    });
  }
  if (!result.jobId) {
    throw new AppError(500, "job_not_enqueued", "The job could not be queued.");
  }
  // A job due now starts at once instead of waiting for the next minute's tick.
  if (!result.deduped && (runAt === null || runAt.getTime() <= now + IMMEDIATE_RUN_MS)) {
    continueTick(result.jobId, deps);
  }
  return { jobId: result.jobId, deduped: result.deduped };
}

export async function enqueueJob<P>(
  kind: string,
  payload: P,
  opts: EnqueueOptions,
  deps?: EnqueueDeps
): Promise<{ jobId: string; deduped: boolean }> {
  return await enqueue(
    kind,
    payload,
    opts.trigger ?? "manual",
    {
      brandKey: opts.brandKey,
      dedupeKey: opts.dedupeKey,
      singleActiveKey: opts.singleActiveKey,
      runAt: opts.runAt,
      createdBy: opts.createdBy,
    },
    deps
  );
}

export async function enqueueSystemJob<P>(
  kind: string,
  payload: P,
  opts: SystemEnqueueOptions = {},
  deps?: EnqueueDeps
): Promise<{ jobId: string; deduped: boolean }> {
  return await enqueue(
    kind,
    payload,
    "system",
    {
      brandKey: null,
      dedupeKey: opts.dedupeKey,
      singleActiveKey: opts.singleActiveKey,
      runAt: opts.runAt,
    },
    deps
  );
}
