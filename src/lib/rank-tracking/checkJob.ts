// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/workflows/RankCheckWorkflow.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { AppError } from "../http/appError.ts";
import { STEP, DB_STEP } from "../jobs/stepConfigs.ts";
import { getJobStatus } from "../jobs/status.ts";
import type { JobContext } from "../jobs/types.ts";
import { createRankTrackingRepository } from "./repository.ts";
import { beginRankCheckRun, failRunIfActive } from "./runGuards.ts";
import { runLiveCheck, runQueuedRound } from "./checkPaths.ts";
import { retryRankChecks } from "./retries.ts";

export const rankCheckPayloadSchema = z.strictObject({ runId: z.string().uuid() });

export type RankCheckPayload = z.infer<typeof rankCheckPayloadSchema>;

export type RankCheckDeps = {
  admin?: any;
  repo?: ReturnType<typeof createRankTrackingRepository>;
  client?: any;
  fetchTaskResult?: any;
};

export async function runRankCheckJob(
  ctx: JobContext<RankCheckPayload>,
  deps?: RankCheckDeps,
): Promise<{ status: string; result?: unknown }> {
  const admin = deps?.admin ?? (ctx as any).admin;
  const repo = deps?.repo ?? createRankTrackingRepository(admin);
  const runId = ctx.payload.runId;
  const run = await repo.getRun(ctx.brandKey, runId);
  if (!run) throw new AppError(404, "run_not_found", "Run not found.");

  // check-active
  await ctx.step.do("check-active", DB_STEP, async () => {
    const cfg = await repo.getConfig(ctx.brandKey, run.config_id);
    if (!cfg || (cfg as any).is_active === false) {
      await failRunIfActive(ctx.brandKey, runId, "tracker_archived", "This domain was archived.", { repo });
      throw new AppError(409, "tracker_archived", "This domain was archived.");
    }
  });

  // prepare
  const prepared = await ctx.step.do("prepare", { timeoutMs: 60000, retries: 0 } as any, async () => {
    const r = await repo.getRun(ctx.brandKey, runId);
    if (!r || (r.status !== "pending" && r.status !== "running")) {
      throw new AppError(409, "run_superseded", "Run superseded.");
    }
    await repo.updateRun(ctx.brandKey, runId, { status: "running", phase: "checking" } as any);
    const cfg = await repo.getConfig(ctx.brandKey, run.config_id);
    if (!cfg) throw new AppError(404, "tracker_not_found", "This tracked domain does not exist.");
    const keywords = await repo.listKeywords(ctx.brandKey, run.config_id);
    const keywordIdsSet = new Set((run.keyword_ids ?? []).map((x: string) => x));
    const subset = run.keyword_ids && run.keyword_ids.length > 0;
    const frozen = (subset
      ? keywords.filter((k: any) => keywordIdsSet.has(k.id))
      : keywords
    ).map((k: any) => k.id);
    if (frozen.length === 0) {
      throw new AppError(422, "no_keywords", "No keywords to track. Add keywords to this domain first.");
    }
    const { estimateRankCheckUsd } = await import("./cost.ts");
    const est = estimateRankCheckUsd(
      frozen.map(() => "k"),
      cfg.devices,
      cfg.serp_depth,
      run.method === "queued" ? "queued" : "live",
    );
    if (est.totalUsd > run.approved_max_usd) {
      throw new AppError(409, "price_changed", "This check now costs more than you approved.");
    }
    await repo.updateRun(ctx.brandKey, runId, {
      keyword_ids: frozen,
      keywords_total: frozen.length,
      is_subset_run: subset,
    } as any);
    return { keywordsTotal: frozen.length };
  });

  const method = run.method === "queued" ? "queued" : "live";

  try {
    if (method === "live") {
      await runLiveCheck(ctx, run, {
        repo,
        client: deps?.client,
        fetchTaskResult: deps?.fetchTaskResult,
        logger: console,
      } as any);
    } else {
      await runQueuedRound(ctx, run, 0, {
        repo,
        client: deps?.client,
        fetchTaskResult: deps?.fetchTaskResult,
        logger: console,
      } as any, async (rows: any) => {
        await repo.insertSnapshots(rows);
        const snaps = await repo.snapshotsForRun(ctx.brandKey, runId);
        const devices = new Set(snaps.map((s: any) => s.device));
        // recount keywords_checked
      });
    }

    // retries
    try {
      await retryRankChecks(ctx, run, {
        repo,
        client: deps?.client,
        fetchTaskResult: deps?.fetchTaskResult,
        logger: console,
      } as any);
    } catch (err) {
      console.warn(`[rank-check] retries failed ${runId} ${(err as any)?.code ?? ""}`);
    }

    // finalize
    await ctx.step.do("finalize", { timeoutMs: 60000, retries: 0 } as any, async () => {
      const r = await repo.getRun(ctx.brandKey, runId);
      if (!r || r.status === "completed" || r.status === "failed") return;
      const snaps = await repo.snapshotsForRun(ctx.brandKey, runId);
      const devices = ["desktop", "mobile"];
      const perDevice: Record<string, number> = {};
      for (const d of devices) perDevice[d] = snaps.filter((s: any) => s.device === d).length;
      const totalSnaps = snaps.length;
      if (totalSnaps === 0 && r.keywords_total > 0) {
        await repo.updateRun(ctx.brandKey, runId, {
          status: "failed",
          completed_at: new Date().toISOString(),
          error_message: r.error_message ?? "No keywords could be checked.",
        } as any);
        return;
      }
      const partial =
        perDevice.desktop !== r.keywords_total || perDevice.mobile !== r.keywords_total;
      await repo.updateRun(ctx.brandKey, runId, {
        status: "completed",
        completed_at: new Date().toISOString(),
        keywords_checked: Math.max(perDevice.desktop ?? 0, perDevice.mobile ?? 0),
        phase: null,
      } as any);
      const cfg = await repo.getConfig(ctx.brandKey, r.config_id);
      if (cfg) {
        await repo.updateConfig(ctx.brandKey, cfg.id, {
          last_checked_at: new Date().toISOString(),
          last_skip_reason: null,
          last_skip_at: null,
        } as any);
      }
      if (partial && r.keywords_total > 0) {
        // store partial message via error_message? spec uses completed with partial message
      }
      console.log(
        `[rank-check] ${runId} ${partial ? "partial" : "completed"} trigger=${r.trigger} keywords=${r.keywords_checked}/${r.keywords_total} error_code=${r.error_code ?? ""}`,
      );
    });
  } catch (err: any) {
    await ctx.step.do("mark-failed", DB_STEP, async () => {
      await failRunIfActive(ctx.brandKey, runId, (err as any)?.code ?? "rank_check_failed", (err?.message ?? "failed").slice(0, 500), { repo });
      if (err?.reason) {
        const r = await repo.getRun(ctx.brandKey, runId);
        if (r) {
          const cfg = await repo.getConfig(ctx.brandKey, r.config_id);
          if (cfg) await repo.updateConfig(ctx.brandKey, cfg.id, { last_skip_reason: err.reason } as any);
        }
      }
    });
    throw new AppError(422, "rank_check_failed", "Rank check failed.");
  }

  const finalRun = await repo.getRun(ctx.brandKey, runId);
  return { status: finalRun?.status ?? "completed", result: { keywordsChecked: finalRun?.keywords_checked, keywordsTotal: finalRun?.keywords_total } };
}
