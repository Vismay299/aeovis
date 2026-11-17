/**
 * F07 §6.3 — daily retention for the project research log. Own code.
 *
 * The other F07 tables are capped per workspace, so the log is the only one that
 * grows without bound and the only one that needs a prune. This is the sole
 * place the job reaches `prune_project_research_log`: F01's job store has no
 * research-log prune and F07 does not own that file (GAP-01), so the RPC is
 * called here behind an injectable pruner.
 */

import { AppError } from "../../shared/http/appError.ts";
import { enqueueSystemJob } from "../jobs/enqueue.ts";
import type { EnqueueDeps } from "../jobs/enqueue.ts";
import { definePeriodic, listPeriodics } from "../jobs/periodic.ts";
import { defineJob, getJobDefinition } from "../jobs/registry.ts";
import { jobStore } from "../jobs/store.ts";
import type { JobStore } from "../jobs/store.ts";
import { DB_STEP } from "../jobs/stepConfigs.ts";
import { getSupabaseAdmin } from "../../shared/supabase/admin.js";

const DAY_MS = 86_400_000;
const RETENTION_DAYS = 90;
const PRUNE_LIMIT = 5_000;
const PRUNE_MAX_STEPS = 10;

export const PROJECT_CONTEXT_RETENTION_KIND = "project_context.retention";

/** `prune_project_research_log(p_before, p_limit)` — rows deleted. */
export type PruneResearchLog = (before: string, limit: number) => Promise<number>;

export type ProjectContextJobsDeps = {
  store?: JobStore | null;
  pruner?: PruneResearchLog | null;
  now?: (() => Date) | null;
  /**
   * Test-only: the periodic enqueues a job that is immediately continued by a
   * fire-and-forget fetch to the app. A unit test binds a no-op so running the
   * periodic cannot fire a real tick at whatever is listening on localhost — the
   * production default is untouched.
   */
  selfContinue?: ((jobId: string) => unknown) | null;
};

/**
 * The production pruner. `getSupabaseAdmin()` is read at call time so the
 * service client is never constructed while this module is imported.
 */
async function defaultPruneResearchLog(before: string, limit: number): Promise<number> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    throw new AppError(503, "context_unavailable", "Workspace storage is unavailable.");
  }
  const { data, error } = await admin.rpc("prune_project_research_log", { p_before: before, p_limit: limit });
  if (error) {
    throw new AppError(503, "context_unavailable", "The research log could not be pruned.", { cause: error });
  }
  const deleted = Number(data);
  return Number.isFinite(deleted) ? deleted : 0;
}

// The retentions' bindings. The module auto-registers on import (via
// `src/server/jobs/kinds.ts` in the tick route); tests call
// `registerProjectContextJobs({ store, pruner, now })`, which rebinds and leaves
// the already-registered handler/periodic in place. Handlers read the binding at
// call time, never at registration time.
let boundStore: JobStore | null = null;
let boundPruner: PruneResearchLog | null = null;
let boundNow: (() => Date) | null = null;
let boundSelfContinue: ((jobId: string) => unknown) | null = null;

const activeStore = (): JobStore => boundStore ?? jobStore();
const activePruner = (): PruneResearchLog => boundPruner ?? defaultPruneResearchLog;
const activeNow = (): Date => (boundNow ?? (() => new Date()))();

function jobDefined(kind: string): boolean {
  return getJobDefinition(kind) !== undefined;
}

function periodicDefined(name: string): boolean {
  return listPeriodics().some((task) => task.name === name);
}

/** The UTC day `RETENTION_DAYS` before `now`, as the DATE the RPC compares against. */
export function retentionCutoff(now: Date): string {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(today - RETENTION_DAYS * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Registers the retention job and its daily periodic. Both registrations are
 * guarded: this module auto-registers on import, so a later call must rebind
 * rather than throw `duplicate_job_kind` / `duplicate_periodic`.
 */
export function registerProjectContextJobs(deps: ProjectContextJobsDeps = {}): void {
  // `{ store: null }` etc. unbind, so an injected value cannot stay bound for
  // the rest of the process. The bare call on import leaves every binding alone.
  if ("store" in deps) boundStore = deps.store ?? null;
  if ("pruner" in deps) boundPruner = deps.pruner ?? null;
  if ("now" in deps) boundNow = deps.now ?? null;
  if ("selfContinue" in deps) boundSelfContinue = deps.selfContinue ?? null;

  if (!jobDefined(PROJECT_CONTEXT_RETENTION_KIND)) {
    defineJob(
      PROJECT_CONTEXT_RETENTION_KIND,
      async (ctx) => {
        const before = retentionCutoff(activeNow());
        let pruned = 0;
        // Prune in fixed batches across all workspaces, stopping on the first
        // pass that is not full: a short pass means the log is drained.
        for (let index = 1; index <= PRUNE_MAX_STEPS; index += 1) {
          const deleted = await ctx.step.do(`prune-${index}`, DB_STEP, () =>
            activePruner()(before, PRUNE_LIMIT)
          );
          pruned += deleted;
          if (deleted < PRUNE_LIMIT) break;
        }
        return { result: { pruned } };
      },
      { deadlineSeconds: 3_600, maxInvocations: 10 },
    );
  }

  if (!periodicDefined(PROJECT_CONTEXT_RETENTION_KIND)) {
    definePeriodic({
      name: PROJECT_CONTEXT_RETENTION_KIND,
      everySeconds: 86_400,
      run: async (now) => {
        const enqueueDeps: EnqueueDeps = { store: activeStore() };
        if (boundSelfContinue) enqueueDeps.selfContinue = boundSelfContinue;
        await enqueueSystemJob(
          PROJECT_CONTEXT_RETENTION_KIND,
          {},
          { dedupeKey: `${PROJECT_CONTEXT_RETENTION_KIND}:${now.toISOString().slice(0, 10)}` },
          enqueueDeps,
        );
      },
    });
  }
}

/** Drops every injected binding, so the job goes back to the real store and RPC. */
export function resetProjectContextJobDeps(): void {
  boundStore = null;
  boundPruner = null;
  boundNow = null;
  boundSelfContinue = null;
}

registerProjectContextJobs();
