// Local SEO retention (F17 §6.2.10, §6.3): daily prune of fetches, items, grids
// and searches older than 395 days through prune_local_seo (F17-AC-16 DB half).

import { enqueueSystemJob } from "../jobs/enqueue.ts";
import { definePeriodic, listPeriodics } from "../jobs/periodic.ts";
import { jobStore, type JobStore } from "../jobs/store.ts";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";
import { AppError } from "../http/appError.ts";
import { getSupabaseAdmin } from "../supabase/admin.js";

const DAY_MS = 86_400_000;
export const LOCAL_RETENTION_DAYS = 395;
export const LOCAL_PRUNE_BATCH_LIMIT = 1000;
export const LOCAL_MAX_PRUNE_STEPS = 20;

export type LocalRetentionDeps = {
  admin?: any;
  now?: () => number;
  store?: JobStore;
};

let boundAdmin: any = null;
let boundNow: (() => number) | null = null;
let boundStore: JobStore | null = null;

export function registerLocalRetentionJobs(deps: LocalRetentionDeps = {}): void {
  if (deps.admin) boundAdmin = deps.admin;
  if (deps.now) boundNow = deps.now;
  if (deps.store) boundStore = deps.store;

  if (!listPeriodics().some((p) => p.name === "local.retention")) {
    definePeriodic({
      name: "local.retention",
      everySeconds: 86_400,
      run: async (now: Date) => {
        await enqueueSystemJob(
          "local.retention",
          {},
          { dedupeKey: `local.retention:${now.toISOString().slice(0, 10)}` },
          { store: boundStore ?? jobStore() },
        );
      },
    });
  }

  if (!getJobDefinition("local.retention")) {
    defineJob(
      "local.retention",
      async (ctx) => {
        const admin = boundAdmin ?? getSupabaseAdmin();
        if (!admin) throw new AppError(503, "database_unavailable", "Database is unavailable.");
        const before = new Date((boundNow ?? Date.now)() - LOCAL_RETENTION_DAYS * DAY_MS).toISOString();
        const totals = { fetches: 0, grids: 0, searches: 0 };
        for (let n = 1; n <= LOCAL_MAX_PRUNE_STEPS; n += 1) {
          const counts = await ctx.step.do(`prune-${n}`, DB_STEP, async () => {
            const { data, error } = await admin.rpc("prune_local_seo", {
              p_before: before,
              p_limit: LOCAL_PRUNE_BATCH_LIMIT,
            });
            if (error) throw error;
            return {
              fetches: Number(data?.fetches) || 0,
              grids: Number(data?.grids) || 0,
              searches: Number(data?.searches) || 0,
            };
          });
          totals.fetches += counts.fetches;
          totals.grids += counts.grids;
          totals.searches += counts.searches;
          // Another batch is only needed while any table still hit the batch limit.
          if (
            counts.fetches < LOCAL_PRUNE_BATCH_LIMIT &&
            counts.grids < LOCAL_PRUNE_BATCH_LIMIT &&
            counts.searches < LOCAL_PRUNE_BATCH_LIMIT
          ) {
            break;
          }
        }
        console.log(
          `[local.retention] fetches=${totals.fetches} grids=${totals.grids} searches=${totals.searches}`,
        );
        return { status: "completed", result: totals };
      },
      { deadlineSeconds: 1800, maxInvocations: 30 },
    );
  }
}

// Auto-register on import (src/lib/jobs/kinds.ts imports this module).
registerLocalRetentionJobs();
