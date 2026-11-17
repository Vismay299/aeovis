import { AppError } from "../../shared/http/errors.ts";
import type { JobContext, JobDefinition, JobResult } from "./types.ts";

/** The kind shape the `jobs.kind` column and `job_periodic.name` both enforce. */
export const KIND_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

// Handlers are registered with their own payload type and looked up by kind, so
// the map holds them at the widest payload type the definition accepts.
const definitions = new Map<string, JobDefinition<unknown>>();

export function isJobKind(kind: unknown): kind is string {
  return typeof kind === "string" && KIND_PATTERN.test(kind);
}

export function defineJob<P>(
  kind: string,
  handler: (ctx: JobContext<P>) => Promise<JobResult>,
  opts?: {
    payloadSchema?: JobDefinition<P>["payloadSchema"];
    pollAfterSeconds?: number;
    deadlineSeconds?: number;
    maxInvocations?: number;
  }
): void {
  if (!isJobKind(kind)) {
    throw new AppError(500, "invalid_job_kind", "A job kind must look like 'feature.action'.");
  }
  if (definitions.has(kind)) {
    throw new AppError(500, "duplicate_job_kind", "This job kind is already defined.");
  }
  definitions.set(kind, {
    kind,
    handler,
    payloadSchema: opts?.payloadSchema,
    pollAfterSeconds: opts?.pollAfterSeconds,
    deadlineSeconds: opts?.deadlineSeconds,
    maxInvocations: opts?.maxInvocations,
  } as JobDefinition<unknown>);
}

export function getJobDefinition(kind: string): JobDefinition<unknown> | undefined {
  return definitions.get(kind);
}

export function listJobKinds(): string[] {
  return [...definitions.keys()].sort();
}
