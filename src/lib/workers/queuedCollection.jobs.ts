import { enqueueSystemJob } from "../jobs/enqueue.ts";
import { definePeriodic, listPeriodics } from "../jobs/periodic.ts";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";
import { AppError } from "../http/errors.ts";
import { getSupabaseAdmin } from "../supabase/admin.js";

export type QueuedCollectionRpc = (
  name: string,
  args?: Record<string, unknown>,
) => Promise<unknown>;

let boundRpc: QueuedCollectionRpc | null = null;

const defaultRpc: QueuedCollectionRpc = async (name, args = {}) => {
  const admin = getSupabaseAdmin();
  if (!admin) throw new AppError(503, "database_unavailable", "Database is unavailable.");
  const { data, error } = await admin.rpc(name, args);
  if (error) throw error;
  return data;
};

function activeRpc(): QueuedCollectionRpc {
  return boundRpc ?? defaultRpc;
}

function slot5m(now: Date): string {
  return String(Math.floor(now.getTime() / (5 * 60 * 1000)));
}

export function registerQueuedCollectionJobs(deps: { rpc?: QueuedCollectionRpc | null } = {}): void {
  if ("rpc" in deps) boundRpc = deps.rpc ?? null;

  if (!listPeriodics().some((task) => task.name === "dataforseo.posted_sweep")) {
    definePeriodic({
      name: "dataforseo.posted_sweep",
      everySeconds: 300,
      run: async (now) => {
        await enqueueSystemJob(
          "dataforseo.posted_sweep",
          {},
          { dedupeKey: `dataforseo.posted-sweep:${slot5m(now)}` },
        );
      },
    });
  }

  if (!getJobDefinition("dataforseo.posted_sweep")) {
    defineJob(
      "dataforseo.posted_sweep",
      async (ctx) => {
        const expired = await ctx.step.do("expire", DB_STEP, () =>
          activeRpc()("expire_posted_probe_dispatch", { p_limit: 200 }),
        );
        return { result: { expired: Number(expired) || 0 } };
      },
      { deadlineSeconds: 900, maxInvocations: 3 },
    );
  }
}

registerQueuedCollectionJobs();
