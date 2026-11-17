import { DB_STEP } from "../../server/jobs/stepConfigs.ts";
import type { JobContext } from "../../server/jobs/types.ts";
import { createRankTrackingRepository } from "./repository.ts";

/**
 * Retention (F15-AC-21): runs (with snapshots and tasks, via cascading
 * deletes) started more than 760 days ago and tasks created more than 14
 * days ago are pruned daily. The loop is capped at 20 rounds of 1,000 so a
 * huge backlog can never wedge the job inside its deadline; leftovers stay
 * for tomorrow's run.
 */
export const RANK_RETENTION_RUNS_BEFORE_DAYS = 760;
export const RANK_RETENTION_TASKS_BEFORE_DAYS = 14;
export const RANK_RETENTION_PRUNE_LIMIT = 1000;
export const RANK_RETENTION_MAX_ROUNDS = 20;

const DAY_MS = 86_400_000;

export type RankRetentionDeps = {
  admin?: any;
  repo?: ReturnType<typeof createRankTrackingRepository>;
  now?: () => Date;
};

export async function runRankRetention(
  ctx: { step: Pick<JobContext<unknown>["step"], "do"> },
  deps?: RankRetentionDeps,
): Promise<{ runs: number; tasks: number; rounds: number }> {
  const repo = deps?.repo ?? createRankTrackingRepository(deps?.admin);
  const nowMs = deps?.now ? deps.now().getTime() : Date.now();
  const runsBefore = new Date(
    nowMs - RANK_RETENTION_RUNS_BEFORE_DAYS * DAY_MS,
  ).toISOString();
  const tasksBefore = new Date(
    nowMs - RANK_RETENTION_TASKS_BEFORE_DAYS * DAY_MS,
  ).toISOString();
  let runs = 0;
  let tasks = 0;
  let rounds = 0;
  for (let n = 1; n <= RANK_RETENTION_MAX_ROUNDS; n += 1) {
    const counts = await ctx.step.do(`prune-${n}`, DB_STEP, () =>
      repo.prune(runsBefore, tasksBefore, RANK_RETENTION_PRUNE_LIMIT),
    );
    runs += Number(counts.runs) || 0;
    tasks += Number(counts.tasks) || 0;
    rounds = n;
    if (Number(counts.runs) < RANK_RETENTION_PRUNE_LIMIT) break;
  }
  return { runs, tasks, rounds };
}
