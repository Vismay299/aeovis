import { AppError } from "../http/errors.ts";
import { KIND_PATTERN } from "./registry.ts";
import { jobStore } from "./store.ts";
import type { JobStore } from "./store.ts";

export type PeriodicTask = {
  name: string;
  everySeconds: number;
  run: (now: Date) => Promise<void>;
};

export type PeriodicFailure = { name: string; reason: string };

export type PeriodicReport = { due: number; ran: number; failed: number; errors: PeriodicFailure[] };

export type PeriodicDeps = { store?: JobStore; logger?: Pick<Console, "error" | "warn"> };

const MIN_INTERVAL_SECONDS = 60;
const tasks = new Map<string, PeriodicTask>();

export function definePeriodic(task: PeriodicTask): void {
  if (!KIND_PATTERN.test(task.name)) {
    throw new AppError(500, "invalid_periodic_name", "A periodic name must look like 'feature.action'.");
  }
  if (!Number.isInteger(task.everySeconds) || task.everySeconds < MIN_INTERVAL_SECONDS) {
    throw new AppError(500, "invalid_periodic_interval", "A periodic must run at least every 60 seconds.");
  }
  if (tasks.has(task.name)) {
    throw new AppError(500, "duplicate_periodic", "This periodic is already defined.");
  }
  tasks.set(task.name, task);
}

export function listPeriodics(): PeriodicTask[] {
  return [...tasks.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function describe(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 500);
}

/**
 * Claims each periodic's next slot before running it, so a task that fails or
 * is busy moves on instead of staying due. Missed slots collapse into one
 * catch-up run inside `claim_due_periodic`.
 */
export async function runDuePeriodics(now: Date, deps?: PeriodicDeps): Promise<PeriodicReport> {
  const store = deps?.store ?? jobStore();
  const logger = deps?.logger ?? console;
  const report: PeriodicReport = { due: 0, ran: 0, failed: 0, errors: [] };

  for (const task of listPeriodics()) {
    let claimed: boolean;
    try {
      claimed = await store.claimDuePeriodic(task.name, task.everySeconds, now);
    } catch (err) {
      report.errors.push({ name: task.name, reason: describe(err) });
      logger.error("[jobs] periodic claim failed", { name: task.name, reason: describe(err) });
      continue;
    }
    if (!claimed) continue;
    report.due += 1;
    try {
      await task.run(now);
      report.ran += 1;
      await store.markPeriodic(task.name, null);
    } catch (err) {
      report.failed += 1;
      const reason = describe(err);
      report.errors.push({ name: task.name, reason });
      logger.error("[jobs] periodic failed", { name: task.name, reason });
      try {
        await store.markPeriodic(task.name, reason);
      } catch (markErr) {
        report.errors.push({ name: task.name, reason: describe(markErr) });
        logger.error("[jobs] periodic record failed", { name: task.name, reason: describe(markErr) });
      }
    }
  }
  return report;
}
