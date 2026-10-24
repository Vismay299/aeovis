import { randomUUID } from "node:crypto";
import { keepAlive } from "../keepAlive.js";
import { buildSelfContinueInit, resolveSelfContinueUrl, SELF_CONTINUE_HOLD_MS, makeSelfContinue } from "../selfContinue.js";
import { runDuePeriodics } from "./periodic.ts";
import type { PeriodicReport } from "./periodic.ts";
import { LEASE_SECONDS, runJob } from "./runner.ts";
import type { RunOutcome } from "./runner.ts";
import { jobStore } from "./store.ts";
import type { JobStore } from "./store.ts";
import { runWatchdog } from "./watchdog.ts";
import type { WatchdogReport } from "./watchdog.ts";

/** Vercel caps the function at 300 s; the rest is left for settles and final writes. */
export const TICK_BUDGET_MS = 240_000;
export const DEFAULT_CLAIM_LIMIT = 8;
export const DEFAULT_CONCURRENCY = 4;
const MAX_CLAIM_LIMIT = 50;
const MAX_CONCURRENCY = 8;
const CONTINUE_SOON_MS = 5_000;

export type TickReport = {
  claimed: number;
  completed: number;
  partial: number;
  failed: number;
  yielded: number;
  cancelled: number;
  lost: number;
  watchdog: WatchdogReport | null;
  periodics: PeriodicReport | null;
  errors: string[];
};

export type TickDeps = {
  store?: JobStore;
  now?: () => number;
  env?: Record<string, string | undefined>;
  selfContinue?: (jobId: string) => unknown;
  selfContinueTick?: () => unknown;
  logger?: Pick<Console, "error" | "warn" | "log">;
  owner?: string;
};

function readInt(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  max: number,
  min = 1
): number {
  const raw = Number(String(env[name] ?? "").trim());
  if (!Number.isInteger(raw) || raw < min) return fallback;
  return Math.min(raw, max);
}

let perJobContinue: ((jobId: string) => unknown) | null = null;

function defaultSelfContinue(jobId: string): unknown {
  perJobContinue ??= makeSelfContinue({ routePath: "/api/jobs/tick", label: "jobs-tick" });
  return perJobContinue(jobId);
}

/** The batch continue names no job, so it asks for a full tick. */
function defaultSelfContinueTick(): unknown {
  const withJob = resolveSelfContinueUrl("/api/jobs/tick", "", process.env);
  if (!withJob) return { fired: false, reason: "no_url" };
  const url = new URL(withJob);
  url.searchParams.delete("job_id");
  const { init } = buildSelfContinueInit(process.env);
  const headers: Record<string, string> = init ? { ...init.headers } : {};
  return keepAlive(
    Promise.resolve(fetch(url.toString(), { headers, redirect: "manual" })).catch(() => undefined),
    { label: "jobs-tick self-continue", maxMs: SELF_CONTINUE_HOLD_MS }
  );
}

/**
 * One tick: watchdog, periodics, claim, run until the budget runs out, then
 * report. Watchdog and periodic failures are held until everything else has
 * run, so a sweep outage cannot suppress job progress.
 */
export async function runTick(input: { jobId?: string; startedAt: number }, deps: TickDeps = {}): Promise<TickReport> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  const logger = deps.logger ?? console;
  const store = deps.store ?? jobStore();
  const owner = deps.owner ?? "tick:" + randomUUID();
  const deadlineMs = input.startedAt + TICK_BUDGET_MS;
  const report: TickReport = {
    claimed: 0,
    completed: 0,
    partial: 0,
    failed: 0,
    yielded: 0,
    cancelled: 0,
    lost: 0,
    watchdog: null,
    periodics: null,
    errors: [],
  };

  try {
    report.watchdog = await runWatchdog({ store, logger });
  } catch (err) {
    // The watchdog rethrows its first sweep failure once both sweeps have run.
    report.errors.push(`watchdog: ${err instanceof Error ? err.message : String(err)}`);
  }

  report.periodics = await runDuePeriodics(new Date(now()), { store, logger });
  for (const failure of report.periodics.errors) report.errors.push(`${failure.name}: ${failure.reason}`);

  const claimed = await store.claimDue(
    owner,
    readInt(env, "JOBS_TICK_CLAIM_LIMIT", DEFAULT_CLAIM_LIMIT, MAX_CLAIM_LIMIT),
    LEASE_SECONDS,
    input.jobId ?? null
  );
  report.claimed = claimed.length;

  const count = (outcome: RunOutcome): void => {
    if (outcome === "completed") report.completed += 1;
    else if (outcome === "partial") report.partial += 1;
    else if (outcome === "failed") report.failed += 1;
    else if (outcome === "cancelled") report.cancelled += 1;
    else if (outcome === "lost_lease") report.lost += 1;
    else report.yielded += 1;
  };

  const selfContinue = deps.selfContinue ?? defaultSelfContinue;
  const yielded: string[] = [];
  let index = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const job = claimed[index];
      index += 1;
      if (!job) return;
      if (now() >= deadlineMs) {
        // Never leave a claimed job holding a lease the runner will not use.
        await store.yieldJob(job.id, owner, new Date(now()));
        report.yielded += 1;
        yielded.push(job.id);
        continue;
      }
      const outcome = await runJob(job, { store, owner, deadlineMs, now, selfContinue, logger });
      count(outcome);
      if (outcome === "yielded") yielded.push(job.id);
    }
  };

  const concurrency = Math.min(
    readInt(env, "JOBS_TICK_CONCURRENCY", DEFAULT_CONCURRENCY, MAX_CONCURRENCY),
    Math.max(claimed.length, 1)
  );
  await Promise.all(Array.from({ length: concurrency }, worker));

  if (yielded.length > 0) {
    const soon = now() + CONTINUE_SOON_MS;
    for (const jobId of yielded) {
      let dueSoon = false;
      try {
        const row = await store.getJob(jobId);
        dueSoon = Boolean(row && Date.parse(row.run_at) <= soon);
      } catch {
        dueSoon = false;
      }
      if (dueSoon) {
        (deps.selfContinueTick ?? defaultSelfContinueTick)();
        break;
      }
    }
  }

  logger.log(
    `[jobs-tick] claimed=${report.claimed} completed=${report.completed} partial=${report.partial} ` +
      `failed=${report.failed} yielded=${report.yielded} cancelled=${report.cancelled} lost=${report.lost} ` +
      `watchdog=${JSON.stringify(report.watchdog)}`
  );
  if (report.errors.length > 0) throw new Error(report.errors[0]);
  return report;
}
