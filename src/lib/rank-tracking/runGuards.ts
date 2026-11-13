// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/rank-tracking/services/rankCheckRunGuards.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../http/appError.ts";
import { getJobStatus } from "../jobs/status.ts";
import { enqueueJob } from "../jobs/enqueue.ts";
import { createRankTrackingRepository } from "./repository.ts";

export type RunGuardsDeps = {
  repo?: ReturnType<typeof createRankTrackingRepository>;
  getJobStatus?: typeof getJobStatus;
  enqueueJob?: typeof enqueueJob;
};

export type RunRow = any;

export interface RankRunView {
  id: string;
  status: string;
  trigger: string;
  method: string;
  phase: string | null;
  keywordsTotal: number;
  keywordsChecked: number;
  isSubsetRun: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  maybeStale: boolean;
  staleReason: string | null;
  pollAfterSeconds: number | null;
}

export async function staleReason(
  run: any,
  deps?: RunGuardsDeps,
): Promise<string | null> {
  const getStatus = deps?.getJobStatus ?? getJobStatus;
  if (run.status === "completed" || run.status === "failed") return "Run already finished";
  if (!run.job_id) {
    const age = Date.now() - new Date(run.started_at).getTime();
    if (age < 60000) return null;
    return "The check never started";
  }
  try {
    const job = await getStatus(run.job_id);
    if (["completed", "partial", "failed", "cancelled"].includes(job.status)) {
      return "The check stopped without finishing";
    }
  } catch {
    return "The check's job was not found";
  }
  return null;
}

export async function failRunIfActive(
  brandKey: string,
  runId: string,
  code: string,
  message: string,
  deps?: RunGuardsDeps & { repo?: ReturnType<typeof createRankTrackingRepository> },
): Promise<void> {
  const repo = deps?.repo ?? createRankTrackingRepository((deps as any)?.admin);
  try {
    await repo.updateRun(brandKey, runId, {
      status: "failed",
      completed_at: new Date().toISOString(),
      error_code: code,
      error_message: message,
    } as any);
  } catch {
    // ignore
  }
}

export async function beginRankCheckRun(
  ws: { brandKey: string; userId: string | null },
  i: { configId: string; trigger: "manual" | "scheduled"; keywordIds?: string[]; approvedMaxUsd: number },
  deps?: RunGuardsDeps & { admin?: any; repo?: ReturnType<typeof createRankTrackingRepository> },
): Promise<{ ok: true; runId: string; jobId: string } | { ok: false; reason: "already_running"; activeRunId: string | null }> {
  const repo = deps?.repo ?? createRankTrackingRepository(deps?.admin);
  const enqueue = deps?.enqueueJob ?? enqueueJob;
  for (let attempt = 0; attempt < 2; attempt++) {
    const runId = crypto.randomUUID();
    const method = i.trigger === "scheduled" ? "queued" : "live";
    const ok = await repo.tryCreateRun({
      brand_key: ws.brandKey,
      config_id: i.configId,
      id: runId,
      trigger: i.trigger,
      method,
      approved_max_usd: i.approvedMaxUsd,
      keyword_ids: i.keywordIds,
      created_by: ws.userId,
    } as any);
    if (ok) {
      try {
        const { jobId } = await enqueue("rank_tracking.check", { runId }, {
          brandKey: ws.brandKey,
          singleActiveKey: "rank_tracking.check:" + i.configId,
          trigger: i.trigger,
          createdBy: ws.userId ?? undefined,
        } as any);
        await repo.updateRun(ws.brandKey, runId, { job_id: jobId } as any);
        return { ok: true, runId, jobId };
      } catch (err: any) {
        if (err instanceof AppError && err.code === "job_already_running") {
          await failRunIfActive(ws.brandKey, runId, "job_start_failed", "The check could not start.", { repo });
          return { ok: false, reason: "already_running", activeRunId: null };
        }
        await failRunIfActive(ws.brandKey, runId, "job_start_failed", "The check could not start.", { repo });
        throw err;
      }
    }
    // not inserted -> active run
    const active = await repo.getActiveRun(ws.brandKey, i.configId);
    if (attempt === 0) {
      const sr = active ? await staleReason(active, deps) : null;
      if (sr) {
        if (active) await failRunIfActive(ws.brandKey, active.id, "stale_run", sr, { repo });
        continue;
      }
    }
    return { ok: false, reason: "already_running", activeRunId: active?.id ?? null };
  }
  const active = await repo.getActiveRun(ws.brandKey, i.configId);
  return { ok: false, reason: "already_running", activeRunId: active?.id ?? null };
}

export async function getLatestRunView(
  brandKey: string,
  configId: string,
  deps?: RunGuardsDeps & { admin?: any; repo?: ReturnType<typeof createRankTrackingRepository> },
): Promise<RankRunView | null> {
  const repo = deps?.repo ?? createRankTrackingRepository(deps?.admin);
  const run = await repo.getLatestRun(brandKey, configId);
  if (!run) return null;
  const sr = await staleReason(run, deps);
  let pollAfterSeconds: number | null = null;
  if (run.status === "pending" || run.status === "running") {
    if (run.phase === "checking" && run.method === "live") pollAfterSeconds = 3;
    else pollAfterSeconds = 20;
  }
  return {
    id: run.id,
    status: run.status,
    trigger: run.trigger,
    method: run.method,
    phase: run.phase,
    keywordsTotal: run.keywords_total,
    keywordsChecked: run.keywords_checked,
    isSubsetRun: run.is_subset_run,
    errorCode: run.error_code,
    errorMessage: run.error_message,
    startedAt: run.started_at,
    completedAt: run.completed_at,
    maybeStale: sr !== null,
    staleReason: sr,
    pollAfterSeconds,
  };
}
