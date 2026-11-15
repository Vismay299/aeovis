// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-search/services/promptExplorer.ts:53-94
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { DB_STEP, StepFailedError } from "../jobs/index.ts";
import type { JobContext, JobResult } from "../jobs/types.ts";
import { createExploreStore, type ExploreStore, type ExploreRunRow } from "./store.ts";
import {
  createProbeDispatchStore,
  dispatchIdentity,
  withLeaseRenewal,
} from "../db/probeDispatch.js";
import { dispatchBudget } from "../workers/durableProbing.js";
import { probeDataforseoModel } from "../engines/dataforseo.ts";
import { probeOpenRouterEngine } from "../engines/openRouterProbe.js";
import { captureServerEvent } from "../telemetry/server.ts";

export const EXPLORE_RUN_JOB_KIND = "explore.run";

export const exploreJobPayloadSchema = z.strictObject({
  runId: z.string().uuid(),
});

export type ExploreJobDeps = {
  store?: ExploreStore;
  dispatchStore?: any;
  admin?: SupabaseClient;
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  askModel?: (params: {
    entry: any;
    run: ExploreRunRow;
    env: Record<string, string | undefined>;
  }) => Promise<any>;
  settleExploreHold?: (runId: string) => Promise<any>;
  captureServerEvent?: typeof captureServerEvent;
  now?: () => Date;
};

export async function askExploreModel(params: {
  entry: any;
  run: ExploreRunRow;
  env: Record<string, string | undefined>;
}): Promise<any> {
  const { entry, run, env } = params;
  const deadlineAt = Date.now() + 150_000;
  const measurementContext = {
    country: (run.country ?? "in").toLowerCase(),
    language: "en",
  };

  if (entry.route === "dataforseo") {
    return probeDataforseoModel(entry.model, run.prompt, {
      model: entry.modelName,
      webSearch: run.web_search,
      countryIso: run.web_search ? run.country : null,
      maxOutputTokens: 4096,
      measurementContext,
      deadlineAt,
    });
  }

  if (entry.route === "openrouter") {
    return probeOpenRouterEngine({
      engine: entry.model,
      query: run.prompt,
      model: entry.modelName,
      durableDispatch: true,
      deadlineAt: deadlineAt as any,
      measurementContext: measurementContext as any,
      webSearch: run.web_search,
    });
  }

  throw new Error(`Unsupported explore route: ${entry.route}`);
}

export async function runExploreJob(
  ctx: JobContext<{ runId: string }>,
  deps?: ExploreJobDeps,
): Promise<JobResult> {
  const env = (deps?.env ?? process.env) as NodeJS.ProcessEnv;
  const nowFn = deps?.now ?? (() => new Date());
  const runId = ctx.payload.runId;

  const admin = deps?.admin ?? (ctx as any).admin;
  const store = deps?.store ?? createExploreStore(admin);
  const dispatchStore = deps?.dispatchStore ?? createProbeDispatchStore(admin);

  // Step 1: Prepare (DB_STEP)
  const prep = await ctx.step.do<{
    brandKey: string;
    idsToAsk: string[];
    alreadyFinished: boolean;
  }>("prepare", DB_STEP, async () => {
    const run = await store.getRun(ctx.brandKey, runId);
    if (!run || !["queued", "running"].includes(run.status)) {
      return { brandKey: ctx.brandKey, idsToAsk: [], alreadyFinished: true };
    }

    if (run.status === "queued") {
      await store.updateRun(ctx.brandKey, runId, { status: "running" });
    }

    const rowsToSeed: any[] = [];
    const ids: string[] = [];
    const now = nowFn();
    const deadlineAt = new Date(now.getTime() + 15 * 60_000).toISOString();

    for (const entry of run.plan) {
      if (entry.route !== null && !entry.skipped && !entry.reusedFrom) {
        const identity = dispatchIdentity(entry.model, env, {
          route: entry.route,
          model: entry.modelName,
        });

        rowsToSeed.push({
          id: entry.observationId,
          purpose: "explore",
          job_id: null,
          engine: entry.model,
          query: run.prompt,
          brand_key: run.brand_key,
          context: {
            explore_run_id: runId,
            brand_key: run.brand_key,
            prompt_hash: run.prompt_hash,
            route: entry.route,
            model_name: entry.modelName,
            web_search: run.web_search,
            country: run.country,
            max_output_tokens: 4096,
          },
          config_version: identity.config_version,
          circuit_key: identity.circuit_key,
          deadline_at: deadlineAt,
        });
        ids.push(entry.observationId);
      }
    }

    if (rowsToSeed.length > 0) {
      await store.seedExplore(rowsToSeed);
    }

    return { brandKey: ctx.brandKey, idsToAsk: ids, alreadyFinished: false };
  });

  if (prep.alreadyFinished) {
    return { status: "completed", result: { runId } };
  }

  // Step 2: Ask (Billed step, retries: 0)
  let askInterrupted = false;
  try {
    await ctx.step.do(
      "ask",
      { retries: 0, timeoutMs: 220_000, billed: true },
      async () => {
        if (prep.idsToAsk.length === 0) return [];

        const run = await store.getRun(prep.brandKey, runId);
        if (!run) return [];

        const dayCap = dispatchBudget(env).dayCap;

        await Promise.allSettled(
          prep.idsToAsk.map(async (obsId) => {
            const entry = run.plan.find((p) => p.observationId === obsId);
            if (!entry) return;

            // Claim probe dispatch
            const claim = await dispatchStore.claim(obsId, {
              reserve: entry.reserveUsd,
              scanCap: run.approved_max_usd,
              dayCap,
              leaseSeconds: 180,
            });

            if (!claim || claim.granted !== true || !claim.lease_token) {
              // Not granted: SQL marked blocked/failed
              return;
            }

            const token = claim.lease_token;
            const askFn = deps?.askModel ?? askExploreModel;

            let result: any = null;
            let decision: { state: "answered" | "failed" } = { state: "failed" };

            try {
              result = await withLeaseRenewal(
                dispatchStore,
                obsId,
                token,
                180,
                async () => {
                  return askFn({ entry, run, env });
                },
              );

              // Check if result has an answer
              const hasAnswer =
                Boolean(result) &&
                (typeof result.text === "string" ? result.text.trim().length > 0 : true) &&
                !result.error;

              decision = { state: hasAnswer ? "answered" : "failed" };
            } catch (askErr: any) {
              console.error(
                `[explore] ask failed ${runId} ${entry.model} ${askErr?.code ?? "unknown"}`,
              );
              decision = { state: "failed" };
              result = {
                error: askErr?.message ?? "Ask failed",
                error_kind: "permanent",
              };
            }

            // Finish claim — never retry billed call
            try {
              await dispatchStore.finish(obsId, token, result, decision);
            } catch (finishErr) {
              console.error(`[explore] finish failed ${runId} ${obsId}`, finishErr);
            }
          }),
        );

        return [];
      },
    );
  } catch (err: any) {
    if (err instanceof StepFailedError) {
      askInterrupted = true;
    } else {
      throw err;
    }
  }

  // Step 3: Finalize (DB_STEP)
  const finalization = await ctx.step.do<{
    finalStatus: "completed" | "partial" | "failed";
    answeredCount: number;
    failedCount: number;
    reusedCount: number;
  }>("finalize", DB_STEP, async () => {
    const run = await store.getRun(prep.brandKey, runId);
    if (!run) {
      return { finalStatus: "failed", answeredCount: 0, failedCount: 0, reusedCount: 0 };
    }

    const observations = await store.listRunObservations(prep.brandKey, runId);
    const now = nowFn();

    // Touch any expired leased rows to mark them ambiguous
    for (const obs of observations) {
      if (obs.state === "leased" && obs.lease_until && new Date(obs.lease_until) < now) {
        try {
          await dispatchStore.claim(obs.id, {
            reserve: 0,
            scanCap: run.approved_max_usd,
            dayCap: 100,
            leaseSeconds: 1,
          });
        } catch {}
      }
    }

    const reloadedObs = await store.listRunObservations(prep.brandKey, runId);
    let answeredCount = 0;
    let failedCount = 0;
    let reusedCount = 0;

    for (const entry of run.plan) {
      if (entry.reusedFrom) {
        reusedCount += 1;
      } else if (entry.skipped === "UNSUPPORTED_COUNTRY") {
        // Country skips count as expected skipped, not failed
      } else {
        const obs = reloadedObs.find((o) => o.id === entry.observationId || o.engine === entry.model);
        if (obs?.state === "answered") {
          answeredCount += 1;
        } else {
          failedCount += 1;
        }
      }
    }

    let finalStatus: "completed" | "partial" | "failed";
    if (askInterrupted) {
      finalStatus = "partial";
    } else {
      const allResolved = run.plan.every((entry) => {
        if (entry.reusedFrom) return true;
        if (entry.skipped === "UNSUPPORTED_COUNTRY") return true;
        const obs = reloadedObs.find((o) => o.id === entry.observationId || o.engine === entry.model);
        return obs?.state === "answered";
      });

      if (allResolved) {
        finalStatus = "completed";
      } else if (answeredCount === 0 && reusedCount === 0) {
        finalStatus = "failed";
      } else {
        finalStatus = "partial";
      }
    }

    await store.updateRun(prep.brandKey, runId, {
      status: finalStatus,
      finished_at: now.toISOString(),
    });

    const captureFn = deps?.captureServerEvent ?? captureServerEvent;
    try {
      await captureFn({
        name: "prompt_explorer:run_finished",
        props: {
          status: finalStatus,
          answered: answeredCount,
          failed: failedCount,
          reused: reusedCount > 0,
        },
        brandKey: prep.brandKey,
      });
    } catch {}

    return { finalStatus, answeredCount, failedCount, reusedCount };
  });

  // Step 4: Settle (DB_STEP)
  await ctx.step.do("settle", DB_STEP, async () => {
    if (deps?.settleExploreHold) {
      await deps.settleExploreHold(runId);
    } else if (admin && typeof admin.rpc === "function") {
      try {
        await admin.rpc("settle_explore_hold", { p_run: runId });
      } catch (err: any) {
        console.error(`[explore] settle failed ${runId}`, err);
      }
    }
  });

  const jobStatus: "completed" | "partial" | undefined =
    finalization.finalStatus === "failed" ? "partial" : finalization.finalStatus;
  return { status: jobStatus, result: { runId, finalStatus: finalization.finalStatus } };
}

export function registerExploreJob(): void {
  if (!getJobDefinition(EXPLORE_RUN_JOB_KIND)) {
    defineJob<{ runId: string }>(
      EXPLORE_RUN_JOB_KIND,
      async (ctx) => {
        const parsed = exploreJobPayloadSchema.parse(ctx.payload);
        return runExploreJob({ ...ctx, payload: parsed });
      },
      {
        payloadSchema: exploreJobPayloadSchema,
        pollAfterSeconds: 3,
        deadlineSeconds: 900,
        maxInvocations: 6,
      },
    );
  }
}
