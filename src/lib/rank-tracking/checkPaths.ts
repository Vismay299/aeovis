// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/workflows/rankCheckPaths.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../http/appError.ts";
import { SpendRefused } from "../spend/errors.ts";
import { SINGLE_ATTEMPT, READ_STEP, DB_STEP } from "../jobs/stepConfigs.ts";
import { jobStepKey } from "../jobs/runner.ts";
import { KEYWORDS_PER_BATCH } from "../../shared/rank-tracking.ts";
import { estimatePairsUsd } from "./cost.ts";

export const QUEUED_POLL_SECONDS = [240, 120, 120, 120, 120, 180] as const;
export const TASK_GET_CONCURRENCY = 25;
export const TASK_GETS_PER_COLLECT = 500;

export function expandToTaskInputs(keywords: any[], devices: string): any[] {
  const devs = devices === "both" ? ["desktop", "mobile"] : [devices];
  const out: any[] = [];
  for (const k of keywords) {
    for (const d of devs) {
      out.push({ keywordId: k.id ?? k.keywordId, keyword: k.keyword, device: d });
    }
  }
  return out;
}

export function mapResultsToSnapshotRows(brandKey: string, runId: string, results: any[]): any[] {
  return results.map((r) => ({
    brand_key: brandKey,
    run_id: runId,
    tracking_keyword_id: r.keywordId,
    keyword: r.keyword,
    device: r.device,
    position: r.position ?? null,
    url: r.url ?? null,
    serp_features: r.serpFeatures ?? [],
  }));
}

type CheckDeps = {
  repo: any;
  client: any;
  fetchTaskResult?: any;
  logger?: Pick<Console, "warn" | "error">;
};

function isUpstream(err: any): boolean {
  return err?.code === "dataforseo_unavailable" || err?.code === "dataforseo_bad_response" || err?.code?.startsWith?.("dataforseo_");
}

export async function runLiveCheck(ctx: any, run: any, deps: CheckDeps): Promise<void> {
  const repo = deps.repo;
  const keywords = await repo.listKeywords(ctx.brandKey, run.config_id);
  const byId = new Map(keywords.map((k: any) => [k.id, k]));
  const frozen = (run.keyword_ids ?? []).map((id: string) => byId.get(id)).filter(Boolean);
  const total = frozen.length;
  let checked = 0;
  for (let i = 0; i < frozen.length; i += KEYWORDS_PER_BATCH) {
    const batch = frozen.slice(i, i + KEYWORDS_PER_BATCH);
    const pairs = batch.map((k: any) => ({ keyword: k.keyword }));
    const stepName = "live-batch-" + Math.floor(i / KEYWORDS_PER_BATCH);
    try {
      await ctx.step.do(stepName, SINGLE_ATTEMPT, async () => {
        const devices = run.devices === "both" ? ["desktop", "mobile"] : [run.devices];
        // One paid SERP per keyword per device: reserve for every device.
        const est = estimatePairsUsd(pairs, run.serp_depth, "live") * devices.length;
        const reserved = await repo.reserve(ctx.brandKey, run.id, est);
        if (!reserved) {
          const cur = await repo.getRun(ctx.brandKey, run.id);
          if (!cur?.error_code) {
            await repo.setRunErrorIfEmpty(ctx.brandKey, run.id, "budget_exhausted", "Budget exhausted.");
          }
          return { written: 0, budget: "exhausted" };
        }
        let wrote = 0;
        for (const dev of devices) {
          const devInputs = batch.map((k: any) => ({
            keyword: k.keyword,
            keywordId: k.id,
            locationCode: run.location_code,
            languageCode: run.language_code,
            locationName: run.location_name,
            device: dev,
            targetDomain: run.domain,
            depth: run.serp_depth,
          }));
          try {
            const res = await deps.client.serp.rankCheckBatch(
              {
                brandKey: ctx.brandKey,
                feature: "rank_tracking.check",
                // Each device is a separate paid call within this step.
                idempotencyKey: `${jobStepKey(ctx, stepName)}:${dev}`,
                maxUsd: run.approved_max_usd,
                jobId: ctx.jobId,
              },
              devInputs,
            );
            // The metered client returns PromiseSettledResult[] (one per
            // keyword): fulfilled rows become snapshots, the first rejection
            // is kept as the run's reason (spec §6.2.7, PORT :105-130).
            const settled: any[] = Array.isArray(res) ? res : (res?.results ?? res?.data ?? []);
            const fulfilled: any[] = [];
            for (const item of settled) {
              if (item && item.status === "rejected") {
                const reason = item.reason;
                const upstream = isUpstream(reason) || !reason?.code;
                await repo.setRunErrorIfEmpty(
                  ctx.brandKey,
                  run.id,
                  upstream ? "dataforseo_unavailable" : reason.code,
                  upstream ? "Our search data provider had errors." : String(reason?.message ?? "").slice(0, 200),
                );
              } else if (item && item.status === "fulfilled") {
                fulfilled.push(item.value);
              } else if (item) {
                fulfilled.push(item);
              }
            }
            const rows = mapResultsToSnapshotRows(ctx.brandKey, run.id, fulfilled.map((r: any) => ({
              keywordId: r.keywordId ?? r.keyword_id,
              keyword: r.keyword,
              device: dev,
              position: r.position ?? null,
              url: r.url ?? null,
              serpFeatures: r.serpFeatures ?? r.serp_features ?? [],
            })));
            if (rows.length) {
              await repo.insertSnapshots(rows);
              wrote += rows.length;
            }
          } catch (err: any) {
            if (err instanceof SpendRefused) throw err;
            const code = isUpstream(err) ? "dataforseo_unavailable" : (err?.code ?? "dataforseo_unavailable");
            const msg = isUpstream(err) ? "Our search data provider had errors." : String(err?.message ?? "Our search data provider had errors.").slice(0, 200);
            await repo.setRunErrorIfEmpty(ctx.brandKey, run.id, code, msg);
          }
        }
        checked = Math.min(total, checked + batch.length);
        await repo.updateRun(ctx.brandKey, run.id, { keywords_checked: checked } as any);
        await ctx.progress?.(checked, total, "Checking keywords");
        return { written: wrote };
      });
    } catch (err: any) {
      if (err instanceof SpendRefused) throw err;
      if (err?.name === "StepFailedError") {
        (deps.logger ?? console).warn?.(`[rank-check] batch ${stepName} failed`, (err as any)?.code);
        continue;
      }
      (deps.logger ?? console).warn?.(`[rank-check] batch ${stepName} failed`, (err as any)?.code);
    }
  }
}

export async function runQueuedRound(
  ctx: any,
  run: any,
  round: 0 | 1 | 2,
  deps: CheckDeps,
  onCompleted?: (rows: any[]) => Promise<void>,
): Promise<{ completed: number; failed: number; expired: number }> {
  const repo = deps.repo;
  const plan = await ctx.step.do("plan-" + round, DB_STEP, async () => {
    let inputs: any[] = [];
    if (round === 0) {
      const all = await repo.listKeywords(ctx.brandKey, run.config_id);
      const byId = new Map(all.map((k: any) => [k.id, k]));
      const frozen = (run.keyword_ids ?? []).map((id: string) => byId.get(id)).filter(Boolean);
      inputs = expandToTaskInputs(frozen, run.devices);
    } else {
      const plannedExisting = await repo.tasksByState(ctx.brandKey, run.id, round, ["planned"], 10000);
      inputs = plannedExisting.map((t: any) => ({ keywordId: t.tracking_keyword_id, keyword: t.keyword, device: t.device }));
      if (inputs.length === 0) {
        return { planned: 0, chunks: 0 };
      }
    }
    if (round === 0) {
      await repo.insertTasks(inputs.map((t: any) => ({
        brand_key: ctx.brandKey,
        run_id: run.id,
        round,
        tracking_keyword_id: t.keywordId,
        keyword: t.keyword,
        device: t.device,
        state: "planned",
      })));
    }
    const planned = round === 0 ? inputs.length : (await repo.tasksByState(ctx.brandKey, run.id, round, ["planned"], 10000)).length;
    const chunks = Math.ceil(planned / 100);
    return { planned, chunks };
  });

  for (let c = 0; c < (plan?.chunks ?? 0); c++) {
    const stepName = "post-" + round + "-" + c;
    try {
      await ctx.step.do(stepName, SINGLE_ATTEMPT, async () => {
        const allPlanned = await repo.tasksByState(ctx.brandKey, run.id, round, ["planned"], 10000);
        allPlanned.sort((a: any, b: any) => (a.id ?? 0) - (b.id ?? 0));
        const chunk = allPlanned.slice(c * 100, c * 100 + 100);
        if (chunk.length === 0) return;
        const est = estimatePairsUsd(chunk.map((t: any) => ({ keyword: t.keyword })), run.serp_depth, "queued");
        const reserved = await repo.reserve(ctx.brandKey, run.id, est);
        if (!reserved) {
          for (const t of chunk) {
            try {
              await repo.updateTasks([{ id: t.id, brand_key: t.brand_key, run_id: t.run_id, state: "rejected", message: "budget_exhausted" }]);
            } catch { /* ignore */ }
          }
          return;
        }
        const postInput = {
          tasks: chunk.map((t: any) => ({
            keyword: t.keyword,
            keywordId: t.tracking_keyword_id,
            device: t.device,
          })),
          locationCode: run.location_code,
          languageCode: run.language_code,
          locationName: run.location_name,
          depth: run.serp_depth,
          targetDomain: run.domain,
        };
        try {
          const res = await deps.client.serp.rankCheckTaskPost(
            {
              brandKey: ctx.brandKey,
              feature: "rank_tracking.check",
              idempotencyKey: jobStepKey(ctx, stepName),
              maxUsd: run.approved_max_usd,
              jobId: ctx.jobId,
            },
            postInput,
          );
          // The metered client returns PostedRankCheckTask[] ({ keywordId,
          // device, taskId }) holding only accepted tasks; raw provider
          // entries ({ id, status_code, data.tag }) are still understood.
          const posted: any[] = Array.isArray(res) ? res : (res?.results ?? res?.data ?? res?.tasks ?? []);
          for (const t of chunk) {
            const want = `${t.tracking_keyword_id}:${t.device}`;
            const match = posted.find(
              (p: any) => p.tag === want || p.data?.tag === want || (p.keywordId != null && `${p.keywordId}:${p.device}` === want),
            );
            const taskId = match?.taskId ?? match?.id ?? match?.task_id;
            const accepted = match && taskId && (match.taskId != null || match.status_code === 20000 || match.status_code === 20100);
            if (accepted) {
              await repo.updateTasks([{ id: t.id, brand_key: t.brand_key, run_id: t.run_id, state: "posted", provider_task_id: taskId }]);
            } else if (match) {
              await repo.updateTasks([{ id: t.id, brand_key: t.brand_key, run_id: t.run_id, state: "rejected", message: String(match.status_message ?? "rejected").slice(0, 300) }]);
            } else {
              await repo.updateTasks([{ id: t.id, brand_key: t.brand_key, run_id: t.run_id, state: "rejected", message: "missing from response" }]);
            }
          }
        } catch (err: any) {
          if (err instanceof SpendRefused) throw err;
          (deps.logger ?? console).warn?.(`[rank-check] post ${stepName} failed`, (err as any)?.code);
        }
      });
    } catch (err: any) {
      if (err instanceof SpendRefused) throw err;
      (deps.logger ?? console).warn?.(`[rank-check] post step ${stepName} failed`, (err as any)?.code);
    }
  }

  let completed = 0;
  let failed = 0;
  for (let r = 0; r < 6; r++) {
    await ctx.step.sleep("wait-" + round + "-" + r, QUEUED_POLL_SECONDS[r] ?? 120);
    const collect: any = await ctx.step.do("collect-" + round + "-" + r, READ_STEP, async () => {
      const posted = await repo.tasksByState(ctx.brandKey, run.id, round, ["posted"], TASK_GETS_PER_COLLECT);
      let c = 0;
      let f = 0;
      const collectedRows: any[] = [];
      for (let i = 0; i < posted.length; i += TASK_GET_CONCURRENCY) {
        const group = posted.slice(i, i + TASK_GET_CONCURRENCY);
        await Promise.all(group.map(async (t: any) => {
          try {
            const fetchFn = deps.fetchTaskResult;
            if (!fetchFn) return;
            const res = await fetchFn({
              taskId: t.provider_task_id,
              keywordId: t.tracking_keyword_id,
              keyword: t.keyword,
              targetDomain: run.domain,
            });
            if (res.status === "pending") return;
            if (res.status === "failed") {
              await repo.updateTasks([{ id: t.id, brand_key: t.brand_key, run_id: t.run_id, state: "failed", message: String(res.message ?? "failed").slice(0, 300) }]);
              f++;
              return;
            }
            await repo.updateTasks([{ id: t.id, brand_key: t.brand_key, run_id: t.run_id, state: "completed", position: res.result?.position ?? null, url: res.result?.url ?? null, serp_features: res.result?.serpFeatures ?? [] }]);
            collectedRows.push({
              keywordId: t.tracking_keyword_id,
              keyword: t.keyword,
              device: t.device,
              position: res.result?.position ?? null,
              url: res.result?.url ?? null,
              serpFeatures: res.result?.serpFeatures ?? [],
            });
            c++;
          } catch {
            // leave pending
          }
        }));
      }
      if (onCompleted && collectedRows.length) await onCompleted(collectedRows);
      return { completed: c, failed: f };
    });
    completed += collect.completed;
    failed += collect.failed;
    const remaining = await repo.tasksByState(ctx.brandKey, run.id, round, ["posted"], 1);
    if (remaining.length === 0) break;
  }

  await ctx.step.do("expire-" + round, DB_STEP, async () => {
    await repo.expireTasks(ctx.brandKey, run.id, round);
  });

  const leftover = await repo.tasksByState(ctx.brandKey, run.id, round, ["planned", "posted"], 10000);
  return { completed, failed, expired: leftover.length };
}
