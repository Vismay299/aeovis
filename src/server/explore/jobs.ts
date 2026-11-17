import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { definePeriodic } from "../jobs/periodic.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";
import { getSupabaseAdmin } from "../../shared/supabase/admin.js";
import { registerExploreJob } from "./job.ts";

export const EXPLORE_SETTLE_PERIODIC = "explore.settle";
export const EXPLORE_RETENTION_PERIODIC = "explore.retention";

export function registerExploreJobs(): void {
  // 1. explore.run job
  registerExploreJob();

  // 2. explore.settle periodic
  if (!getJobDefinition(EXPLORE_SETTLE_PERIODIC)) {
    defineJob(
      EXPLORE_SETTLE_PERIODIC,
      async (ctx) => {
        const admin = getSupabaseAdmin();
        const settled = await ctx.step.do("settle", DB_STEP, async () => {
          if (!admin || typeof admin.rpc !== "function") return 0;
          const { data, error } = await admin.rpc("settle_finished_explore_holds", { p_limit: 50 });
          if (error) {
            console.error("[explore] settle_finished_explore_holds failed", error);
            return 0;
          }
          return typeof data === "number" ? data : 0;
        });
        return { status: "completed", result: { settled } };
      },
      {
        deadlineSeconds: 300,
        maxInvocations: 1,
      },
    );

    definePeriodic({
      name: EXPLORE_SETTLE_PERIODIC,
      everySeconds: 300,
      run: async () => {},
    });
  }

  // 3. explore.retention periodic
  if (!getJobDefinition(EXPLORE_RETENTION_PERIODIC)) {
    defineJob(
      EXPLORE_RETENTION_PERIODIC,
      async (ctx) => {
        const admin = getSupabaseAdmin();
        const now = new Date();
        const cutoff = new Date(now.getTime() - 395 * 86_400_000).toISOString();

        let totalPruned = 0;
        for (let i = 1; i <= 20; i++) {
          const count = await ctx.step.do(`prune-${i}`, DB_STEP, async () => {
            if (!admin || typeof admin.rpc !== "function") return 0;
            const { data, error } = await admin.rpc("prune_explore_runs", {
              p_before: cutoff,
              p_limit: 1000,
            });
            if (error) {
              console.error("[explore] prune_explore_runs failed", error);
              return 0;
            }
            return typeof data === "number" ? data : 0;
          });
          totalPruned += count;
          if (count < 1000) break;
        }

        return { status: "completed", result: { pruned: totalPruned } };
      },
      {
        deadlineSeconds: 900,
        maxInvocations: 1,
      },
    );

    definePeriodic({
      name: EXPLORE_RETENTION_PERIODIC,
      everySeconds: 86400,
      run: async () => {},
    });
  }
}

// Auto-register on import
registerExploreJobs();
