import { enqueueSystemJob } from "./enqueue.ts";
import { definePeriodic, listPeriodics } from "./periodic.ts";
import { defineJob, getJobDefinition } from "./registry.ts";
import { jobStore } from "./store.ts";
import type { JobStore } from "./store.ts";
import { DB_STEP } from "./stepConfigs.ts";
import { pruneCostReconciliations } from "../costs/jobs.ts";

const DAY_MS = 86_400_000;
const JOB_RETENTION_DAYS = 30;
const HOLD_RETENTION_DAYS = 90;
const LEDGER_RETENTION_DAYS = 395;
const CACHE_RETENTION_DAYS = 7;
const CACHE_PRUNE_LIMIT = 1_000;
const CACHE_STORAGE_BATCH = 100;
const PRUNE_BATCH = 1_000;
const PRUNE_MAX_STEPS = 20;
const SPEND_PRUNE_LIMIT = 5_000;

export type MaintenanceDeps = { store?: JobStore | null };

// The retentions' store binding. The module auto-registers handlers on import
// (via `kinds.ts` in the tick route) with the production store; tests call
// `registerMaintenanceJobs({ store })` again, which rebinds every registered
// periodic and (via the definition check in `runJob`) every handler to the
// injected store. Handlers read the binding at call time, never at
// registration time, so the rebinding takes effect for the next tick.
let boundStore: JobStore | null = null;

const activeStore = (): JobStore => boundStore ?? jobStore();

function jobDefined(kind: string): boolean {
  return getJobDefinition(kind) !== undefined;
}

function periodicDefined(name: string): boolean {
  return listPeriodics().some((task) => task.name === name);
}

/**
 * F01's own system jobs, including `cache.retention` (migration 042): its step
 * prunes rows expired more than 7 days and deletes the returned Storage paths
 * from `provider-cache` in batches of 100.
 *
 * Each registration is guarded: the module auto-registers on import (via
 * `kinds.ts` in the tick route), so a test that calls this again must not
 * throw `duplicate_job_kind` / `duplicate_periodic`.
 */
export function registerMaintenanceJobs(deps: MaintenanceDeps = {}): void {
  // Passing `store` rebinds; passing `store: null` unbinds, so a test store
  // cannot stay bound for the rest of the process. The bare call the module
  // makes on import leaves the binding alone.
  if ("store" in deps) boundStore = deps.store ?? null;
  const store = (): JobStore => activeStore();

  if (!jobDefined("jobs.retention")) {
    defineJob(
      "jobs.retention",
      async (ctx) => {
        let pruned = 0;
        for (let index = 1; index <= PRUNE_MAX_STEPS; index += 1) {
          const deleted = await ctx.step.do(`prune-${index}`, DB_STEP, () =>
            store().pruneJobs(new Date(Date.now() - JOB_RETENTION_DAYS * DAY_MS), PRUNE_BATCH)
          );
          pruned += deleted;
          if (deleted < PRUNE_BATCH) break;
        }
        return { result: { pruned } };
      },
      { deadlineSeconds: 3_600, maxInvocations: 50 }
    );
  }

  if (!jobDefined("spend.retention")) {
    defineJob(
      "spend.retention",
      async (ctx) => {
        const pruned = await ctx.step.do("prune-1", DB_STEP, () =>
          store().pruneSpend(
            new Date(Date.now() - HOLD_RETENTION_DAYS * DAY_MS),
            new Date(Date.now() - LEDGER_RETENTION_DAYS * DAY_MS),
            SPEND_PRUNE_LIMIT
          )
        );
        const reconciliations = await ctx.step.do("prune-cost-reconciliations", DB_STEP, () =>
          pruneCostReconciliations(
            new Date(Date.now() - LEDGER_RETENTION_DAYS * DAY_MS),
            SPEND_PRUNE_LIMIT
          )
        );
        return { result: { ...pruned, reconciliations } };
      },
      { deadlineSeconds: 3_600, maxInvocations: 10 }
    );
  }

  if (!jobDefined("cache.retention")) {
    defineJob(
      "cache.retention",
      async (ctx) => {
        const pruned = await ctx.step.do("prune-1", DB_STEP, () =>
          store().pruneProviderCache(new Date(Date.now() - CACHE_RETENTION_DAYS * DAY_MS), CACHE_PRUNE_LIMIT)
        );
        // `deleted` counts every pruned row; `paths` is only the storage-backed
        // subset, so reporting its length would show 0 after deleting a
        // thousand inline rows.
        const paths = pruned.paths.filter((path) => typeof path === "string" && path.length > 0);
        for (let index = 0; index < paths.length; index += CACHE_STORAGE_BATCH) {
          const batch = paths.slice(index, index + CACHE_STORAGE_BATCH);
          const stepName = `prune-${2 + index / CACHE_STORAGE_BATCH}`;
          await ctx.step.do(stepName, DB_STEP, async () => {
            await store().removeCacheBodies(batch);
            return { removed: batch.length };
          });
        }
        return { result: { pruned: pruned.deleted, bodies: paths.length } };
      },
      { deadlineSeconds: 3_600, maxInvocations: 10 }
    );
  }

  if (!periodicDefined("jobs.retention")) {
    definePeriodic({
      name: "jobs.retention",
      everySeconds: 86_400,
      run: async (now) => {
        await enqueueSystemJob("jobs.retention", {}, { dedupeKey: `jobs.retention:${now.toISOString().slice(0, 10)}` }, { store: activeStore() });
      },
    });
  }

  if (!periodicDefined("spend.retention")) {
    definePeriodic({
      name: "spend.retention",
      everySeconds: 86_400,
      run: async (now) => {
        await enqueueSystemJob("spend.retention", {}, { dedupeKey: `spend.retention:${now.toISOString().slice(0, 10)}` }, { store: activeStore() });
      },
    });
  }

  if (!periodicDefined("cache.retention")) {
    definePeriodic({
      name: "cache.retention",
      everySeconds: 3_600,
      run: async (now) => {
        await enqueueSystemJob("cache.retention", {}, { dedupeKey: `cache.retention:${now.toISOString().slice(0, 13)}` }, { store: activeStore() });
      },
    });
  }
}

/** Drops any injected store, so the retentions go back to `jobStore()`. */
export function resetMaintenanceStore(): void {
  boundStore = null;
}

registerMaintenanceJobs();
