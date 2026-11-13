// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/workflows/rankCheckPaths.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError } from "../http/appError.ts";
import { STEP, SINGLE_ATTEMPT, READ_STEP, DB_STEP } from "../jobs/stepConfigs.ts";
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
      out.push({ keywordId: k.id, keyword: k.keyword, device: d });
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

export async function runLiveCheck(ctx: any, run: any, deps: CheckDeps): Promise<void> {
  const repo = deps.repo;
  const keywords = await repo.listKeywords(ctx.brandKey, run.config_id);
  const byId = new Map(keywords.map((k: any) => [k.id, k]));
  const frozen = (run.keyword_ids ?? []).map((id: string) => byId.get(id)).filter(Boolean);
  const total = frozen.length;
  let checked = 0;
  for (let i = 0; i < frozen.length; i += KEYWORDS_PER_BATCH) {
    const batch = frozen.slice(i, i + KEYWORDS_PER_BATCH);
    const pairs = batch.map((k: any) => ({ keyword: k.keyword, keywordId: k.id }));
    const stepName = "live-batch-" + Math.floor(i / KEYWORDS_PER_BATCH);
    try {
      await ctx.step.do(stepName, { retries: 0, timeoutMs: 120000, billed: true } as any, async () => {
        const est = estimatePairsUsd(pairs, run.serp_depth, "live");
        const reserved = await repo.reserve(ctx.brandKey, run.id, est);
        if (!reserved) {
          if (checked === 0) {
            await repo.updateRun(ctx.brandKey, run.id, { error_code: "budget_exhausted" } as any);
          }
          return { written: 0, budget: "exhausted" };
        }
        const inputs = batch.map((k: any) => ({
          keyword: k.keyword,
          keywordId: k.id,
          locationCode: run.location_code,
          languageCode: run.language_code,
          locationName: run.location_name,
          device: run.devices === "both" ? "mobile" : run.devices,
          targetDomain: run.domain,
          depth: run.serp_depth,
        }));
        // call batch for each device
        const devices = run.devices === "both" ? ["desktop", "mobile"] : [run.devices];
        let firstError: string | null = null;
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
                idempotencyKey: `job:${ctx.jobId}:${stepName}:${dev}`,
                maxUsd: run.approved_max_usd,
                jobId: ctx.jobId,
              },
              devInputs,
            );
            const rows = mapResultsToSnapshotRows(ctx.brandKey, run.id, (res?.results ?? []).map((r: any) => ({
              keywordId: r.keywordId ?? r.keyword_id,
              keyword: r.keyword,
              device: dev,
              position: r.position,
              url: r.url,
              serpFeatures: r.serpFeatures ?? r.serp_features ?? [],
            })));
            await repo.insertSnapshots(rows);
          } catch (err: any) {
            if (!firstError) {
              firstError = err?.code ?? "dataforseo_unavailable";
              await repo.setRunErrorIfEmpty(ctx.brandKey, run.id, firstError, (err?.message ?? "Our search data provider had errors.").slice(0, 200));
            }
          }
        }
        checked = Math.min(total, checked + batch.length);
        await repo.updateRun(ctx.brandKey, run.id, { keywords_checked: checked } as any);
        await ctx.progress(checked, total, "Checking keywords");
        return { written: batch.length };
      });
    } catch (err: any) {
      // batch step failed; continue
      (deps.logger ?? console).warn?.(`[rank-check] batch ${stepName} failed`, err?.code);
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
  // plan
  const plan = await ctx.step.do("plan-" + round, DB_STEP, async () => {
    const tasks = round === 0 ? expandToTaskInputs(await repo.listKeywords(ctx.brandKey, run.config_id).then((ks: any[]) =>
      (run.keyword_ids ?? []).map((id: string) => ks.find((k: any) => k.id === id)).filter(Boolean),
    ), run.devices) : [];
    await repo.insertTasks(tasks.map((t: any) => ({
      brand_key: ctx.brandKey,
      run_id: run.id,
      round,
      tracking_keyword_id: t.keywordId,
      keyword: t.keyword,
      device: t.device,
      state: "planned",
    })));
    const planned = tasks.length;
    const chunks = Math.ceil(planned / 100);
    return { planned, chunks };
  });

  // post chunks
  for (let c = 0; c < (plan?.chunks ?? 0); c++) {
    const stepName = "post-" + round + "-" + c;
    try {
      await ctx.step.do(stepName, { retries: 0, timeoutMs: 120000, billed: true } as any, async () => {
        const tasks = await repo.tasksByState(ctx.brandKey, run.id, round, ["planned"], 100, undefined);
        // offset by c*100 handled by tasksByState? assume returns all; slice
        const chunk = tasks.slice(c * 100, c * 100 + 100);
        const est = estimatePairsUsd(chunk.map((t: any) => ({ keyword: t.keyword })), run.serp_depth, "queued");
        const reserved = await repo.reserve(ctx.brandKey, run.id, est);
        if (!reserved) {
          for (const t of chunk) await repo.updateTasks([{ ...t, state: "rejected", message: "budget_exhausted" }]);
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
              idempotencyKey: `job:${ctx.jobId}:${stepName}`,
              maxUsd: run.approved_max_usd,
              jobId: ctx.jobId,
            },
            postInput,
          );
          const posted = res?.results ?? res?.tasks ?? [];
          for (const t of chunk) {
            const match = posted.find((p: any) => p.tag === `${t.tracking_keyword_id}:${t.device}` || p.data?.tag === `${t.tracking_keyword_id}:${t.device}`);
            if (match && (match.status_code === 20000 || match.status_code === 20100)) {
              await repo.updateTasks([{ ...t, state: "posted", provider_task_id: match.id ?? match.task_id }]);
            } else if (match) {
              await repo.updateTasks([{ ...t, state: "rejected", message: match.status_message ?? "rejected" }]);
            } else {
              await repo.updateTasks([{ ...t, state: "rejected", message: "missing from response" }]);
            }
          }
        } catch (err: any) {
          (deps.logger ?? console).warn?.(`[rank-check] post ${stepName} failed`, err?.code);
        }
      });
    } catch (err: any) {
      (deps.logger ?? console).warn?.(`[rank-check] post step ${stepName} failed`, err?.code);
    }
  }

  // collect rounds
  let completed = 0;
  let failed = 0;
  for (let r = 0; r < 6; r++) {
    await ctx.step.sleep("wait-" + round + "-" + r, QUEUED_POLL_SECONDS[r] ?? 120);
    const collect = await ctx.step.do("collect-" + round + "-" + r, READ_STEP, async () => {
      const posted = await repo.tasksByState(ctx.brandKey, run.id, round, ["posted"], TASK_GETS_PER_COLLECT);
      let c = 0;
      let f = 0;
      const collectedRows: any[] = [];
      // process with concurrency 25
      const chunks2: any[][] = [];
      for (let i = 0; i < posted.length; i += TASK_GET_CONCURRENCY) chunks2.push(posted.slice(i, i + TASK_GET_CONCURRENCY));
      for (const ch of chunks2) {
        await Promise.all(ch.map(async (t: any) => {
          try {
            const res = await (deps.fetchTaskResult ?? (async () => ({ status: "pending" })))( {
              taskId: t.provider_task_id,
              keywordId: t.tracking_keyword_id,
              keyword: t.keyword,
              targetDomain: run.domain,
            });
            if (res.status === "pending") return;
            if (res.status === "failed") {
              await repo.updateTasks([{ ...t, state: "failed", message: res.message ?? "failed" }]);
              f++;
              return;
            }
            // completed
            await repo.updateTasks([{ ...t, state: "completed", position: res.result?.position, url: res.result?.url, serp_features: res.result?.serpFeatures ?? [] }]);
            collectedRows.push({
              keywordId: t.tracking_keyword_id,
              keyword: t.keyword,
              device: t.device,
              position: res.result?.position ?? null,
              url: res.result?.url ?? null,
              serpFeatures: res.result?.serpFeatures ?? [],
            });
            c++;
          } catch (e: any) {
            // leave pending
          }
        }));
      }
      if (onCompleted && collectedRows.length) await onCompleted(collectedRows);
      return { completed: c, failed: f, collectedRows };
    });
    completed += collect.completed;
    failed += collect.failed;
    const remaining = await repo.tasksByState(ctx.brandKey, run.id, round, ["posted"], 1);
    if (remaining.length === 0) break;
  }

  await ctx.step.do("expire-" + round, DB_STEP, async () => {
    await repo.expireTasks(ctx.brandKey, run.id, round);
  });

  // mark expired count
  const expiredTasks = await repo.tasksByState(ctx.brandKey, run.id, round, ["planned", "posted"], 10000);
  const expired = expiredTasks.length;
  return { completed, failed, expired };
}
