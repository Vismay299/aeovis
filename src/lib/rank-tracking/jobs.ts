// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/rank-tracking/jobs
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { z } from "zod";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { definePeriodic, listPeriodics } from "../jobs/periodic.ts";
import { enqueueSystemJob, type EnqueueDeps } from "../jobs/enqueue.ts";
import { jobStore, type JobStore } from "../jobs/store.ts";
import { getSupabaseAdmin } from "../supabase/admin.js";
import { rankCheckPayloadSchema, runRankCheckJob, type RankCheckDeps } from "./checkJob.ts";
import { runRankScheduleTick, type RankScheduleDeps } from "./schedules.ts";
import { runRankRetention } from "./retention.ts";

// Registers rank_tracking.check.run (and the other rank priced actions) for
// the jobs process: the scheduled tick prices through F09 `quote()`, and the
// tick route only imports `../jobs/kinds.ts`, so nothing else would load them.
import "../pricing/actions/rankTracking.ts";

export const RANK_CHECK_KIND = "rank_tracking.check";
export const RANK_SCHEDULES_TICK_KIND = "rank_tracking.schedules.tick";
export const RANK_SCHEDULES_PERIODIC_NAME = "rank_tracking.schedules";
export const RANK_RETENTION_KIND = "rank_tracking.retention";

export const rankSchedulesTickPayloadSchema = z.strictObject({
  at: z.iso.datetime(),
});

export type RankTrackingScheduleJobsDeps = {
  store?: JobStore | null;
  scheduleDeps?: RankScheduleDeps | null;
};

let boundDeps: RankCheckDeps | null = null;
let boundStore: JobStore | null = null;
let boundScheduleDeps: RankScheduleDeps | null = null;

export function setRankTrackingJobsDeps(deps: RankCheckDeps): void {
  boundDeps = deps;
}

export function setRankTrackingScheduleJobsDeps(deps: RankTrackingScheduleJobsDeps): void {
  if ("store" in deps) boundStore = deps.store ?? null;
  if ("scheduleDeps" in deps) boundScheduleDeps = deps.scheduleDeps ?? null;
}

export function resetRankTrackingScheduleJobsDeps(): void {
  boundStore = null;
  boundScheduleDeps = null;
}

const activeStore = (): JobStore => boundStore ?? jobStore();

function activeScheduleDeps(): RankScheduleDeps {
  const bound = boundScheduleDeps ?? {};
  if (bound.repo ?? bound.admin) return bound;
  return { ...bound, admin: getSupabaseAdmin() };
}

function jobDefined(kind: string): boolean {
  return getJobDefinition(kind) !== undefined;
}

function periodicDefined(name: string): boolean {
  return listPeriodics().some((task) => task.name === name);
}

export function registerRankTrackingJobs(): void {
  if (!getJobDefinition(RANK_CHECK_KIND)) {
    defineJob(
      RANK_CHECK_KIND,
      async (ctx: any) => {
        const parsed = rankCheckPayloadSchema.parse(ctx.payload);
        const typedCtx = { ...ctx, payload: parsed };
        const r = await runRankCheckJob(typedCtx, boundDeps ?? undefined);
        return { status: (r.status === "partial" ? "partial" : "completed") as "completed" | "partial", result: r.result };
      },
      { payloadSchema: rankCheckPayloadSchema, pollAfterSeconds: 5, deadlineSeconds: 7200, maxInvocations: 200 } as any,
    );
  }

  if (!jobDefined(RANK_SCHEDULES_TICK_KIND)) {
    defineJob(
      RANK_SCHEDULES_TICK_KIND,
      async (ctx: any) => {
        const parsed = rankSchedulesTickPayloadSchema.parse(ctx.payload);
        const result = await runRankScheduleTick(
          new Date(parsed.at),
          ctx,
          activeScheduleDeps(),
        );
        if (result.failed > 0) return { status: "partial" as const, result };
        return { status: "completed" as const, result };
      },
      {
        payloadSchema: rankSchedulesTickPayloadSchema,
        deadlineSeconds: 240,
        pollAfterSeconds: 20,
        maxInvocations: 10,
      } as any,
    );
  }

  if (!jobDefined(RANK_RETENTION_KIND)) {
    defineJob(
      RANK_RETENTION_KIND,
      async (ctx: any) => {
        const totals = await runRankRetention(ctx, activeScheduleDeps());
        return { status: "completed" as const, result: totals };
      },
      { deadlineSeconds: 1800, maxInvocations: 30 } as any,
    );
  }

  if (!periodicDefined(RANK_SCHEDULES_PERIODIC_NAME)) {
    definePeriodic({
      name: RANK_SCHEDULES_PERIODIC_NAME,
      everySeconds: 300,
      run: async (now: Date) => {
        const slot = Math.floor(now.getTime() / 300_000);
        const enqueueDeps: EnqueueDeps = { store: activeStore() };
        await enqueueSystemJob(
          RANK_SCHEDULES_TICK_KIND,
          { at: now.toISOString() },
          {
            dedupeKey: `${RANK_SCHEDULES_PERIODIC_NAME}:${slot}`,
            singleActiveKey: RANK_SCHEDULES_PERIODIC_NAME,
          },
          enqueueDeps,
        );
      },
    });
  }

  if (!periodicDefined(RANK_RETENTION_KIND)) {
    definePeriodic({
      name: RANK_RETENTION_KIND,
      everySeconds: 86_400,
      run: async (now: Date) => {
        const enqueueDeps: EnqueueDeps = { store: activeStore() };
        await enqueueSystemJob(
          RANK_RETENTION_KIND,
          {},
          { dedupeKey: `${RANK_RETENTION_KIND}:${now.toISOString().slice(0, 10)}` },
          enqueueDeps,
        );
      },
    });
  }
}

registerRankTrackingJobs();
