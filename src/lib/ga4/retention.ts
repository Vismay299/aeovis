import { enqueueSystemJob } from "../jobs/enqueue.ts";
import { definePeriodic, listPeriodics } from "../jobs/periodic.ts";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { jobStore, type JobStore } from "../jobs/store.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";
import { getSupabaseAdmin } from "../supabase/admin.js";
import { purgeUnusedGrants } from "./accounts.ts";

const DAY_MS = 86_400_000;
const PURGE_STEP_OPTIONS = { timeoutMs: 120_000, retries: 1 };
const PURGE_BATCH_LIMIT = 50;
const PURGE_MAX_STEPS = 10;

export interface Ga4RetentionDeps {
  admin?: any;
  store?: JobStore | null;
}

let boundStore: JobStore | null = null;
let boundAdmin: any = null;

const activeStore = (): JobStore => boundStore ?? jobStore();
const activeAdmin = (): any => boundAdmin ?? getSupabaseAdmin();

function jobDefined(kind: string): boolean {
  return getJobDefinition(kind) !== undefined;
}

function periodicDefined(name: string): boolean {
  return listPeriodics().some((task) => task.name === name);
}

export function registerGa4RetentionJobs(deps: Ga4RetentionDeps = {}): void {
  if ("store" in deps) boundStore = deps.store ?? null;
  if ("admin" in deps) boundAdmin = deps.admin ?? null;

  const admin = (): any => activeAdmin();

  if (!jobDefined("ga4.retention")) {
    defineJob(
      "ga4.retention",
      async (ctx) => {
        let totalPurged = 0;
        let totalRevoked = 0;

        for (let index = 1; index <= PURGE_MAX_STEPS; index += 1) {
          const stepStart = Date.now();
          const { purged, revoked } = await ctx.step.do(
            `purge-${index}`,
            PURGE_STEP_OPTIONS,
            async () => {
              const res = await purgeUnusedGrants(admin(), {
                updatedBefore: new Date(stepStart - DAY_MS),
                limit: PURGE_BATCH_LIMIT,
                deadline: stepStart + 100_000,
              });
              return res;
            },
          );

          totalPurged += purged;
          totalRevoked += revoked;

          if (purged < PURGE_BATCH_LIMIT) {
            break;
          }
        }

        const attempts = await ctx.step.do(
          "prune-attempts",
          DB_STEP,
          async () => {
            const { data, error } = await admin().rpc("prune_ga4_oauth_attempts");
            if (error) {
              throw new Error(`Failed to prune GA4 oauth attempts: ${error.message}`);
            }
            return Number(data) || 0;
          },
        );

        console.log(`[ga4.retention] purged=${totalPurged} revoked=${totalRevoked} attempts=${attempts}`);

        return {
          result: {
            purged: totalPurged,
            revoked: totalRevoked,
            attempts,
          },
        };
      },
      { deadlineSeconds: 1_800, maxInvocations: 15 },
    );
  }

  if (!periodicDefined("ga4.retention")) {
    definePeriodic({
      name: "ga4.retention",
      everySeconds: 86_400,
      run: async (now) => {
        await enqueueSystemJob(
          "ga4.retention",
          {},
          { dedupeKey: `ga4.retention:${now.toISOString().slice(0, 10)}` },
          { store: activeStore() },
        );
      },
    });
  }
}

// Auto-register on import
registerGa4RetentionJobs();
