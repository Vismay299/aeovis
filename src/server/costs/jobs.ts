import { enqueueSystemJob } from "../jobs/enqueue.ts";
import { definePeriodic, listPeriodics } from "../jobs/periodic.ts";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { STEP } from "../jobs/stepConfigs.ts";
import { jobStore } from "../jobs/store.ts";
import type { JobStore } from "../jobs/store.ts";
import { getSupabaseAdmin } from "../../shared/supabase/admin.js";

export type CostJobRpc = (name: string, args?: Record<string, unknown>) => Promise<unknown>;

export type CostJobDeps = {
  store?: JobStore | null;
  rpc?: CostJobRpc | null;
};

let boundStore: JobStore | null = null;
let boundRpc: CostJobRpc | null = null;

const activeStore = (): JobStore => boundStore ?? jobStore();

const defaultRpc: CostJobRpc = async (name, args = {}) => {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new Error("Supabase admin client unavailable");
  }
  const { data, error } = await admin.rpc(name, args);
  if (error) {
    throw error;
  }
  return data;
};

const activeRpc: CostJobRpc = async (name, args = {}) => {
  if (boundRpc) {
    return boundRpc(name, args);
  }
  return defaultRpc(name, args);
};

export function slot5m(now: Date): string {
  const ms = now.getTime();
  const slot = Math.floor(ms / (5 * 60 * 1000));
  return String(slot);
}

function periodicDefined(name: string): boolean {
  return listPeriodics().some((task) => task.name === name);
}

export function registerCostJobs(deps: CostJobDeps = {}): void {
  if ("store" in deps) boundStore = deps.store ?? null;
  if ("rpc" in deps) boundRpc = deps.rpc ?? null;

  if (!periodicDefined("costs.sync")) {
    definePeriodic({
      name: "costs.sync",
      everySeconds: 300,
      run: async (now) => {
        await enqueueSystemJob(
          "costs.sync",
          {},
          { dedupeKey: `costs.sync:${slot5m(now)}` },
          { store: activeStore() }
        );
      },
    });
  }

  if (!getJobDefinition("costs.sync")) {
    defineJob(
      "costs.sync",
      async (ctx) => {
        const settled = await ctx.step.do("settle-scan-holds", STEP.DB_STEP, () =>
          activeRpc("settle_finished_scan_holds", { p_limit: 50 })
        );
        const synced = await ctx.step.do("sync-attempts", STEP.DB_STEP, () =>
          activeRpc("sync_probe_attempt_costs", { p_limit: 1000 })
        );
        return { result: { settled, synced } };
      },
      { deadlineSeconds: 900 }
    );
  }
}

export async function pruneCostReconciliations(before: Date, limit = 5000): Promise<number> {
  const result = await activeRpc("prune_cost_reconciliations", {
    p_before: before.toISOString(),
    p_limit: limit,
  });
  return typeof result === "number" ? result : Number(result) || 0;
}
