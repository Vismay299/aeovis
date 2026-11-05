/**
 * F09 §6.3 — daily retention for price approvals.
 *
 * Keeps 13 months (395 days) of price approvals. Runs daily as a system job,
 * pruning in batches of 5000 via prune_price_approvals(now - 395 days, 5000).
 */
import { AppError } from "../http/appError.ts";
import { enqueueSystemJob } from "../jobs/enqueue.ts";
import type { EnqueueDeps } from "../jobs/enqueue.ts";
import { definePeriodic, listPeriodics } from "../jobs/periodic.ts";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { jobStore } from "../jobs/store.ts";
import type { JobStore } from "../jobs/store.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";
import { getSupabaseAdmin } from "../supabase/admin.js";

const DAY_MS = 86_400_000;
const RETENTION_DAYS = 395;
const PRUNE_LIMIT = 5_000;

export const PRICING_RETENTION_KIND = "pricing.retention";

/** `prune_price_approvals(p_before, p_limit)` — rows deleted. */
export type PrunePriceApprovals = (before: string, limit: number) => Promise<number>;

export type PricingJobsDeps = {
  store?: JobStore | null;
  pruner?: PrunePriceApprovals | null;
  now?: (() => Date) | null;
  selfContinue?: ((jobId: string) => unknown) | null;
};

/**
 * The production pruner. Reads getSupabaseAdmin() at call time.
 */
async function defaultPrunePriceApprovals(before: string, limit: number): Promise<number> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new AppError(503, "pricing_unavailable", "Database is unavailable.");
  }
  const { data, error } = await admin.rpc("prune_price_approvals", {
    p_before: before,
    p_limit: limit,
  });
  if (error) {
    throw new AppError(503, "pricing_unavailable", "Price approvals could not be pruned.", {
      cause: error,
    });
  }
  const deleted = Number(data);
  return Number.isFinite(deleted) ? deleted : 0;
}

let boundStore: JobStore | null = null;
let boundPruner: PrunePriceApprovals | null = null;
let boundNow: (() => Date) | null = null;
let boundSelfContinue: ((jobId: string) => unknown) | null = null;

const activeStore = (): JobStore => boundStore ?? jobStore();
const activePruner = (): PrunePriceApprovals => boundPruner ?? defaultPrunePriceApprovals;
const activeNow = (): Date => (boundNow ?? (() => new Date()))();

function jobDefined(kind: string): boolean {
  return getJobDefinition(kind) !== undefined;
}

function periodicDefined(name: string): boolean {
  return listPeriodics().some((task) => task.name === name);
}

/** The ISO timestamp 395 days before `now`. */
export function retentionCutoff(now: Date): string {
  return new Date(now.getTime() - RETENTION_DAYS * DAY_MS).toISOString();
}

export function registerPricingJobs(deps: PricingJobsDeps = {}): void {
  if ("store" in deps) boundStore = deps.store ?? null;
  if ("pruner" in deps) boundPruner = deps.pruner ?? null;
  if ("now" in deps) boundNow = deps.now ?? null;
  if ("selfContinue" in deps) boundSelfContinue = deps.selfContinue ?? null;

  if (!jobDefined(PRICING_RETENTION_KIND)) {
    defineJob(
      PRICING_RETENTION_KIND,
      async (ctx) => {
        const before = retentionCutoff(activeNow());
        const pruned = await ctx.step.do("prune", DB_STEP, () =>
          activePruner()(before, PRUNE_LIMIT),
        );
        return { result: { pruned } };
      },
      { deadlineSeconds: 3_600, maxInvocations: 10 },
    );
  }

  if (!periodicDefined(PRICING_RETENTION_KIND)) {
    definePeriodic({
      name: PRICING_RETENTION_KIND,
      everySeconds: 86_400,
      run: async (now) => {
        const enqueueDeps: EnqueueDeps = { store: activeStore() };
        if (boundSelfContinue) enqueueDeps.selfContinue = boundSelfContinue;
        await enqueueSystemJob(
          PRICING_RETENTION_KIND,
          {},
          { dedupeKey: `${PRICING_RETENTION_KIND}:${now.toISOString().slice(0, 10)}` },
          enqueueDeps,
        );
      },
    });
  }
}

export function resetPricingJobDeps(): void {
  boundStore = null;
  boundPruner = null;
  boundNow = null;
  boundSelfContinue = null;
}

registerPricingJobs();
