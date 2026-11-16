import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { definePeriodic, listPeriodics } from "../jobs/periodic.ts";
import { enqueueSystemJob, type EnqueueDeps } from "../jobs/enqueue.ts";
import { jobStore, type JobStore } from "../jobs/store.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";
import { getSupabaseAdmin } from "../supabase/admin.js";
import { runDueSchedules } from "../schedules/runDue.ts";
import { SpendRefused } from "../spend/errors.ts";
import { createBacklinksClient } from "../providers/dataforseo/backlinks.ts";
import {
  advanceSnapshotTarget,
  blockSnapshotTarget,
  evaluateScheduledSnapshot,
  listDueSnapshotTargets,
  recordSnapshot,
  type DueSnapshotTarget,
  type SnapshotScheduleDeps,
} from "./snapshots.ts";

export const SNAPSHOTS_TICK_KIND = "backlinks.snapshots_tick";
export const SNAPSHOTS_TICK_PERIODIC = "backlinks.snapshots_tick";
export const SNAPSHOTS_RETENTION_KIND = "backlinks.snapshots_retention";
export const SNAPSHOTS_RETENTION_PERIODIC = "backlinks.snapshots_retention";

const emptyPayload = z.strictObject({});
const PRUNE_LIMIT = 5_000;

export type BacklinkSnapshotJobsDeps = {
  store?: JobStore | null;
  admin?: SupabaseClient | null;
  now?: (() => Date) | null;
  selfContinue?: ((jobId: string) => unknown) | null;
  listDue?: typeof listDueSnapshotTargets | null;
  scheduleDeps?: SnapshotScheduleDeps | null;
  createBacklinksClient?: typeof createBacklinksClient | null;
  advanceTarget?: typeof advanceSnapshotTarget | null;
  blockTarget?: typeof blockSnapshotTarget | null;
  record?: typeof recordSnapshot | null;
  logger?: Pick<Console, "log" | "error" | "warn">;
};

let bound: BacklinkSnapshotJobsDeps = {};
const activeStore = (): JobStore => bound.store ?? jobStore();
const activeAdmin = (): SupabaseClient => {
  const admin = bound.admin ?? getSupabaseAdmin();
  if (!admin) throw new Error("Supabase admin client is unavailable");
  return admin as SupabaseClient;
};
const activeNow = (): Date => (bound.now ?? (() => new Date()))();

function jobDefined(kind: string): boolean {
  return getJobDefinition(kind) !== undefined;
}

function periodicDefined(name: string): boolean {
  return listPeriodics().some((task) => task.name === name);
}

function spendSkipReason(error: SpendRefused): string {
  return error.reason === "over_approved_max" ? "price_changed" : error.reason;
}

export function registerBacklinkSnapshotJobs(deps: BacklinkSnapshotJobsDeps = {}): void {
  bound = { ...bound, ...deps };

  if (!jobDefined(SNAPSHOTS_TICK_KIND)) {
    defineJob(
      SNAPSHOTS_TICK_KIND,
      async (ctx) => {
        const admin = activeAdmin();
        const now = activeNow();
        const items = await ctx.step.do("list", DB_STEP, () =>
          (bound.listDue ?? listDueSnapshotTargets)(admin, now, 20),
        );
        const result = await runDueSchedules<DueSnapshotTarget, { approvedMaxUsd: number }>({
          items,
          now: now.getTime(),
          evaluate: (item, plan) =>
            evaluateScheduledSnapshot(admin, item, plan, bound.scheduleDeps ?? undefined),
          start: async (item, plan, start) => {
            const advanced = await (bound.advanceTarget ?? advanceSnapshotTarget)(
              admin,
              item,
              plan,
              now,
            );
            if (!advanced) return { started: false, reason: "concurrent_change" };
            try {
              const client = (bound.createBacklinksClient ?? createBacklinksClient)();
              const summary = await client.summary(
                {
                  brandKey: item.brandKey,
                  feature: "backlinks.snapshots",
                  idempotencyKey: `backlinks.snapshot:${item.key}:${plan.run}`,
                  maxUsd: start.approvedMaxUsd,
                  jobId: ctx.jobId,
                },
                { target: item.target, includeSubdomains: item.scope === "subdomains" },
              );
              await (bound.record ?? recordSnapshot)(admin, {
                brandKey: item.brandKey,
                target: item.target,
                scope: item.scope,
                source: "scheduled",
                summary,
                capturedAt: new Date(plan.run),
              });
              return { started: true };
            } catch (error) {
              if (error instanceof SpendRefused) {
                const reason = spendSkipReason(error);
                await (bound.blockTarget ?? blockSnapshotTarget)(admin, item, plan, reason, now);
                return { started: false, reason };
              }
              throw error;
            }
          },
          block: (item, plan, reason) =>
            (bound.blockTarget ?? blockSnapshotTarget)(admin, item, plan, reason, now),
          wrap: (name, fn) =>
            ctx.step.do(name, { timeoutMs: 60_000, retries: 0, billed: true }, fn),
          logger: bound.logger ?? console,
        });
        return result.failed > 0
          ? { status: "partial", result }
          : { status: "completed", result };
      },
      {
        payloadSchema: emptyPayload,
        deadlineSeconds: 240,
        pollAfterSeconds: 20,
        maxInvocations: 10,
      },
    );
  }

  if (!jobDefined(SNAPSHOTS_RETENTION_KIND)) {
    defineJob(
      SNAPSHOTS_RETENTION_KIND,
      async (ctx) => {
        const admin = activeAdmin();
        const now = activeNow();
        const before = cutoff25Months(now);
        const { data, error } = await ctx.step.do("prune", DB_STEP, async () => {
          const result = await admin.rpc("prune_backlink_snapshots", {
            p_before: before,
            p_limit: PRUNE_LIMIT,
          });
          if (result.error) throw result.error;
          return result.data;
        });
        const pruned = Number(data) || 0;
        (bound.logger ?? console).log(`[backlinks.retention] pruned=${pruned}`);
        return { status: "completed", result: { pruned } };
      },
      { deadlineSeconds: 1800, maxInvocations: 10 },
    );
  }

  if (!periodicDefined(SNAPSHOTS_TICK_PERIODIC)) {
    definePeriodic({
      name: SNAPSHOTS_TICK_PERIODIC,
      everySeconds: 3600,
      run: async (now) => {
        const hourIso = now.toISOString().slice(0, 13);
        const enqueueDeps: EnqueueDeps = { store: activeStore() };
        if (bound.selfContinue) enqueueDeps.selfContinue = bound.selfContinue;
        await enqueueSystemJob(
          SNAPSHOTS_TICK_KIND,
          {},
          {
            dedupeKey: `${SNAPSHOTS_TICK_KIND}:${hourIso}`,
            singleActiveKey: SNAPSHOTS_TICK_KIND,
          },
          enqueueDeps,
        );
      },
    });
  }

  if (!periodicDefined(SNAPSHOTS_RETENTION_PERIODIC)) {
    definePeriodic({
      name: SNAPSHOTS_RETENTION_PERIODIC,
      everySeconds: 86_400,
      run: async (now) => {
        const enqueueDeps: EnqueueDeps = { store: activeStore() };
        if (bound.selfContinue) enqueueDeps.selfContinue = bound.selfContinue;
        await enqueueSystemJob(
          SNAPSHOTS_RETENTION_KIND,
          {},
          { dedupeKey: `${SNAPSHOTS_RETENTION_KIND}:${now.toISOString().slice(0, 10)}` },
          enqueueDeps,
        );
      },
    });
  }
}

export function resetBacklinkSnapshotJobsDeps(): void {
  bound = {};
}

function cutoff25Months(now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() - 25;
  const day = now.getUTCDate();
  const monthStart = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0)).getUTCDate();
  monthStart.setUTCDate(Math.min(day, lastDay));
  return monthStart.toISOString().slice(0, 10);
}

registerBacklinkSnapshotJobs();
