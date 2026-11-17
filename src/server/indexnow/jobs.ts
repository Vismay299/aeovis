import { AppError } from "../../shared/http/errors.ts";
import { enqueueSystemJob } from "../jobs/enqueue.ts";
import { definePeriodic, listPeriodics } from "../jobs/periodic.ts";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";
import { isFeatureEnabled } from "../features/flags.ts";
import { getSupabaseAdmin } from "../../shared/supabase/admin.js";

let boundAdmin: any = null;
const activeAdmin = (): any => boundAdmin ?? getSupabaseAdmin();

export function registerIndexNowJobs(deps?: { admin?: any }): void {
  if (deps && "admin" in deps) {
    boundAdmin = deps.admin ?? null;
  }

  // 1. periodic indexnow.retention (every 86,400s)
  if (!listPeriodics().some((p) => p.name === "indexnow.retention")) {
    definePeriodic({
      name: "indexnow.retention",
      everySeconds: 86_400,
      run: async (now: Date) => {
        const isEnabled = await isFeatureEnabled("indexnow");
        if (!isEnabled) return;
        const dateIso = now.toISOString().slice(0, 10);
        try {
          await enqueueSystemJob(
            "indexnow.retention",
            {},
            {
              dedupeKey: `indexnow.retention:${dateIso}`,
            }
          );
        } catch (err: unknown) {
          if (err instanceof AppError && err.code === "job_already_running") return;
          throw err;
        }
      },
    });
  }

  // 2. job indexnow.retention definition
  if (!getJobDefinition("indexnow.retention")) {
    defineJob(
      "indexnow.retention",
      async (ctx) => {
        const admin = activeAdmin();
        if (!admin) {
          throw new AppError(503, "database_unavailable", "Database is unavailable.");
        }

        const now = Date.now();
        const submissionsBefore = new Date(now - 395 * 86_400_000).toISOString();
        const checksBefore = new Date(now - 7 * 86_400_000).toISOString();

        let totalSubmissions = 0;
        let totalChecks = 0;

        for (let i = 1; i <= 20; i++) {
          const res = await ctx.step.do(`prune-${i}`, DB_STEP, async () => {
            const { data, error } = await admin.rpc("prune_indexnow", {
              p_submissions_before: submissionsBefore,
              p_checks_before: checksBefore,
              p_limit: 5000,
            });
            if (error) throw error;
            const raw = typeof data === "string" ? JSON.parse(data) : data;
            return {
              submissions: Number(raw?.submissions ?? 0),
              checks: Number(raw?.checks ?? 0),
            };
          });

          totalSubmissions += res.submissions;
          totalChecks += res.checks;

          // Stop when submissions deleted is less than limit (5000)
          if (res.submissions < 5000) {
            break;
          }
        }

        return {
          status: "completed",
          result: {
            submissions: totalSubmissions,
            checks: totalChecks,
          },
        };
      },
      {
        deadlineSeconds: 240,
      }
    );
  }
}

// Auto-register on import
registerIndexNowJobs();
