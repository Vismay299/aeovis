import { enqueueSystemJob } from "./enqueue.ts";
import { definePeriodic } from "./periodic.ts";
import { defineJob } from "./registry.ts";
import { jobStore } from "./store.ts";
import type { JobStore } from "./store.ts";
import { DB_STEP } from "./stepConfigs.ts";

const DAY_MS = 86_400_000;
const JOB_RETENTION_DAYS = 30;
const HOLD_RETENTION_DAYS = 90;
const LEDGER_RETENTION_DAYS = 395;
const PRUNE_BATCH = 1_000;
const PRUNE_MAX_STEPS = 20;
const SPEND_PRUNE_LIMIT = 5_000;

export type MaintenanceDeps = { store?: JobStore };

/**
 * F01's own system jobs. `cache.retention` is NOT registered here: its step
 * calls `prune_provider_cache`, which arrives with migration 042 in phase 4, so
 * registering it now would enqueue an hourly job whose step always fails.
 */
export function registerMaintenanceJobs(deps: MaintenanceDeps = {}): void {
  const store = (): JobStore => deps.store ?? jobStore();

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
      return { result: pruned };
    },
    { deadlineSeconds: 3_600, maxInvocations: 10 }
  );

  definePeriodic({
    name: "jobs.retention",
    everySeconds: 86_400,
    run: async (now) => {
      await enqueueSystemJob("jobs.retention", {}, { dedupeKey: `jobs.retention:${now.toISOString().slice(0, 10)}` }, { store: deps.store });
    },
  });

  definePeriodic({
    name: "spend.retention",
    everySeconds: 86_400,
    run: async (now) => {
      await enqueueSystemJob("spend.retention", {}, { dedupeKey: `spend.retention:${now.toISOString().slice(0, 10)}` }, { store: deps.store });
    },
  });
}

registerMaintenanceJobs();
