import { enqueueSystemJob } from "../jobs/enqueue.ts";
import { definePeriodic, listPeriodics } from "../jobs/periodic.ts";
import { jobStore, type JobStore } from "../jobs/store.ts";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";
import { AppError } from "../../shared/http/appError.ts";
import { getSupabaseAdmin } from "../../shared/supabase/admin.js";

// F23 §6.3 — share-view retention. Reports and templates are kept until the
// customer deletes them; the only rows that grow per view are
// `report_share_views`, and they are pruned 395 days after the day they record.
//
// The cutoff is a DATE, not a timestamp: rows are keyed by the UTC day they
// count, so "older than 395 days" is a day boundary and the SQL function takes
// `p_before date`.

export const REPORTS_RETENTION_KIND = "reports.retention";
export const REPORTS_RETENTION_DAYS = 395;
export const REPORTS_PRUNE_BATCH_LIMIT = 5_000;
export const REPORTS_MAX_PRUNE_STEPS = 20;

const DAY_MS = 86_400_000;

export type ReportJobDeps = {
  admin?: any;
  now?: () => number;
  store?: JobStore;
  /** Tests pass a no-op so enqueueing never reaches the tick route. */
  selfContinue?: (jobId: string) => unknown;
};

let boundAdmin: any = null;
let boundNow: (() => number) | null = null;
let boundStore: JobStore | null = null;
let boundSelfContinue: ((jobId: string) => unknown) | null = null;

export function registerReportJobs(deps: ReportJobDeps = {}): void {
  if (deps.admin) boundAdmin = deps.admin;
  if (deps.now) boundNow = deps.now;
  if (deps.store) boundStore = deps.store;
  if (deps.selfContinue) boundSelfContinue = deps.selfContinue;

  if (!listPeriodics().some((periodic) => periodic.name === REPORTS_RETENTION_KIND)) {
    definePeriodic({
      name: REPORTS_RETENTION_KIND,
      everySeconds: 86_400,
      run: async (now: Date) => {
        await enqueueSystemJob(
          REPORTS_RETENTION_KIND,
          {},
          { dedupeKey: `${REPORTS_RETENTION_KIND}:${now.toISOString().slice(0, 10)}` },
          {
            store: boundStore ?? jobStore(),
            ...(boundSelfContinue ? { selfContinue: boundSelfContinue } : {}),
          }
        );
      },
    });
  }

  if (!getJobDefinition(REPORTS_RETENTION_KIND)) {
    defineJob(
      REPORTS_RETENTION_KIND,
      async (ctx) => {
        const admin = boundAdmin ?? getSupabaseAdmin();
        if (!admin) throw new AppError(503, "database_unavailable", "Database is unavailable.");
        const before = new Date(
          (boundNow ?? Date.now)() - REPORTS_RETENTION_DAYS * DAY_MS
        )
          .toISOString()
          .slice(0, 10);

        let views = 0;
        for (let step = 1; step <= REPORTS_MAX_PRUNE_STEPS; step += 1) {
          const deleted = await ctx.step.do<number>(`prune-${step}`, DB_STEP, async () => {
            const { data, error } = await admin.rpc("prune_report_share_views", {
              p_before: before,
              p_limit: REPORTS_PRUNE_BATCH_LIMIT,
            });
            if (error) throw error;
            const count = Number(data);
            return Number.isFinite(count) ? count : 0;
          });
          views += deleted;
          // A short batch means there is nothing older left in this range.
          if (deleted < REPORTS_PRUNE_BATCH_LIMIT) break;
        }

        return { status: "completed", result: { views } };
      },
      { deadlineSeconds: 1800, maxInvocations: 30 }
    );
  }
}

// Auto-register on import (src/server/jobs/kinds.ts imports this module).
registerReportJobs();
