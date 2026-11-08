import { AppError } from "../http/errors.ts";
import { enqueueSystemJob } from "../jobs/enqueue.ts";
import { definePeriodic, listPeriodics } from "../jobs/periodic.ts";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";
import { isFeatureEnabled } from "../features/flags.ts";
import { getSupabaseAdmin } from "../supabase/admin.js";
import { deliverOutboxRow } from "./deliver.ts";
import { sweepMilestones, sweepScans, sweepWindows } from "./sweeps.ts";
import type { EmailOutboxRow } from "./types.ts";

export function registerEmailJobs(): void {
  // 1. email.deliver periodic (every 60s)
  if (!listPeriodics().some((p) => p.name === "email.deliver")) {
    definePeriodic({
      name: "email.deliver",
      everySeconds: 60,
      run: async (now: Date) => {
        const isEnabled = await isFeatureEnabled("lifecycle_email");
        if (!isEnabled) return;
        const minuteIso = now.toISOString().slice(0, 16);
        try {
          await enqueueSystemJob(
            "email.deliver",
            {},
            {
              dedupeKey: `email.deliver:${minuteIso}`,
              singleActiveKey: "email.deliver",
            },
          );
        } catch (err: unknown) {
          if (err instanceof AppError && err.code === "job_already_running") return;
          throw err;
        }
      },
    });
  }

  // 2. email.sweep periodic (every 300s)
  if (!listPeriodics().some((p) => p.name === "email.sweep")) {
    definePeriodic({
      name: "email.sweep",
      everySeconds: 300,
      run: async (now: Date) => {
        const isEnabled = await isFeatureEnabled("lifecycle_email");
        if (!isEnabled) return;
        const slotMinutes = Math.floor(now.getUTCMinutes() / 5) * 5;
        const slot = `${now.toISOString().slice(0, 14)}${String(slotMinutes).padStart(2, "0")}`;
        try {
          await enqueueSystemJob(
            "email.sweep",
            {},
            {
              dedupeKey: `email.sweep:${slot}`,
              singleActiveKey: "email.sweep",
            },
          );
        } catch (err: unknown) {
          if (err instanceof AppError && err.code === "job_already_running") return;
          throw err;
        }
      },
    });
  }

  // 3. email.retention periodic (every 86400s)
  if (!listPeriodics().some((p) => p.name === "email.retention")) {
    definePeriodic({
      name: "email.retention",
      everySeconds: 86_400,
      run: async (now: Date) => {
        const isEnabled = await isFeatureEnabled("lifecycle_email");
        if (!isEnabled) return;
        const dateIso = now.toISOString().slice(0, 10);
        try {
          await enqueueSystemJob(
            "email.retention",
            {},
            {
              dedupeKey: `email.retention:${dateIso}`,
            },
          );
        } catch (err: unknown) {
          if (err instanceof AppError && err.code === "job_already_running") return;
          throw err;
        }
      },
    });
  }

  // 4. email.deliver job definition
  if (!getJobDefinition("email.deliver")) {
    defineJob(
      "email.deliver",
      async (ctx) => {
        const admin = getSupabaseAdmin();
        if (!admin) {
          throw new AppError(503, "database_unavailable", "Database is unavailable.");
        }

        // Step 1: close exhausted rows
        await ctx.step.do("close", DB_STEP, async () => {
          const { data, error } = await admin.rpc("close_exhausted_email_outbox");
          if (error) throw error;
          return Number(data) || 0;
        });

        // Step 2: claim rows (retries: 0 as claim mutates)
        const rows = await ctx.step.do("claim", { ...DB_STEP, retries: 0 }, async () => {
          const { data, error } = await admin.rpc("claim_email_outbox", {
            p_limit: 25,
            p_owner: `deliver:${ctx.jobId}`,
          });
          if (error) throw error;
          return (data ?? []) as EmailOutboxRow[];
        });

        let sent = 0;
        let skipped = 0;
        let retried = 0;
        let failed = 0;

        // Step 3: send each row
        for (const row of rows) {
          const result = await ctx.step.do(
            `send:${row.id}`,
            { timeoutMs: 20_000, retries: 0 },
            async () => {
              return await deliverOutboxRow(row, { admin });
            },
          );
          if (result === "sent") sent++;
          else if (result === "skipped") skipped++;
          else if (result === "retry") retried++;
          else if (result === "failed") failed++;
        }

        return {
          status: "completed",
          result: { sent, skipped, retried, failed },
        };
      },
      {
        deadlineSeconds: 240,
        pollAfterSeconds: 20,
      },
    );
  }

  // 5. email.sweep job definition
  if (!getJobDefinition("email.sweep")) {
    defineJob(
      "email.sweep",
      async (ctx) => {
        const admin = getSupabaseAdmin();
        if (!admin) {
          throw new AppError(503, "database_unavailable", "Database is unavailable.");
        }
        const now = new Date();

        // 1. milestones — DB_STEP
        const milestones = await ctx.step.do("milestones", DB_STEP, async () => {
          return await sweepMilestones(admin, now);
        });

        // 2. scans — DB_STEP
        const scans = await ctx.step.do("scans", DB_STEP, async () => {
          return await sweepScans(admin, now);
        });

        // 3. windows — DB_STEP
        const windows = await ctx.step.do("windows", DB_STEP, async () => {
          return await sweepWindows(admin, now);
        });

        return {
          status: "completed",
          result: { milestones, scans, windows },
        };
      },
      {
        deadlineSeconds: 240,
      },
    );
  }

  // 6. email.retention job definition
  if (!getJobDefinition("email.retention")) {
    defineJob(
      "email.retention",
      async (ctx) => {
        const admin = getSupabaseAdmin();
        if (!admin) {
          throw new AppError(503, "database_unavailable", "Database is unavailable.");
        }

        const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();
        let totalPruned = 0;

        for (let i = 1; i <= 20; i++) {
          const count = await ctx.step.do(`prune-${i}`, DB_STEP, async () => {
            const { data, error } = await admin.rpc("prune_email_outbox", {
              p_before: ninetyDaysAgo,
              p_limit: 1000,
            });
            if (error) throw error;
            return Number(data) || 0;
          });
          totalPruned += count;
          if (count < 1000) break;
        }

        return {
          status: "completed",
          result: { pruned: totalPruned },
        };
      },
      {
        deadlineSeconds: 240,
      },
    );
  }
}

// Auto-register on import
registerEmailJobs();
