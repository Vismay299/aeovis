import { AppError } from "../http/errors.ts";
import { jobStore } from "./store.ts";
import type { JobStore } from "./store.ts";

/** `cancel_job`'s answer: a terminal row keeps its status, a live one does not. */
export type CancelOutcome = "cancelled" | "cancel_requested" | "completed" | "partial" | "failed";

export type CancelDeps = { store?: JobStore };

export async function cancelJob(jobId: string, deps?: CancelDeps): Promise<CancelOutcome> {
  const store = deps?.store ?? jobStore();
  const outcome = await store.cancel(jobId);
  if (outcome === "not_found") {
    throw new AppError(404, "job_not_found", "This job does not exist in this workspace.");
  }
  return outcome as CancelOutcome;
}
