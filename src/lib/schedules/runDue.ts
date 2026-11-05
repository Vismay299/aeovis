// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/ai-visibility/services/scheduledAiVisibility.ts.
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import {
  planWindows,
  type ScheduleInterval,
} from "../../shared/schedule.ts";

export type DueItem = {
  key: string;
  observedNextRunAt: string;
  interval: ScheduleInterval;
};

export type WindowPlan = {
  run: string;
  missed: string[];
  next: string;
};

export type Evaluation<C> = { skip: string } | { start: C };

type RunDueResult = {
  started: number;
  skipped: Record<string, number>;
  failed: number;
  notDue: number;
};

type RunDueInput<T extends DueItem, C> = {
  items: T[];
  now: number;
  evaluate(item: T, plan: WindowPlan): Promise<Evaluation<C>>;
  start(
    item: T,
    plan: WindowPlan,
    ctx: C,
  ): Promise<{ started: boolean; reason?: string }>;
  block(item: T, plan: WindowPlan, reason: string): Promise<void>;
  wrap?(name: string, fn: () => Promise<void>): Promise<void>;
  logger?: Pick<Console, "error" | "warn">;
};

function addSkipped(skipped: Record<string, number>, reason: string): void {
  skipped[reason] = (skipped[reason] ?? 0) + 1;
}

export async function runDueSchedules<T extends DueItem, C>(
  i: RunDueInput<T, C>,
): Promise<RunDueResult> {
  const result: RunDueResult = {
    started: 0,
    skipped: {},
    failed: 0,
    notDue: 0,
  };
  const wrap = i.wrap ?? ((_name, fn) => fn());
  const logger = i.logger ?? console;

  for (const item of i.items) {
    const planned = planWindows(item.observedNextRunAt, item.interval, i.now);
    if (planned.run === null) {
      result.notDue += 1;
      continue;
    }

    const plan: WindowPlan = {
      run: planned.run,
      missed: planned.missed,
      next: planned.next,
    };
    let blockFailed = false;
    const block = async (reason: string) => {
      try {
        await i.block(item, plan, reason);
        addSkipped(result.skipped, reason);
      } catch {
        blockFailed = true;
        result.failed += 1;
        logger.error("[schedules] block failed", { key: item.key });
      }
    };

    try {
      await wrap(`window:${item.key}:${plan.run}`, async () => {
        const evaluation = await i.evaluate(item, plan);
        if ("skip" in evaluation) {
          await block(evaluation.skip);
          return;
        }

        const started = await i.start(item, plan, evaluation.start);
        if (started.started) {
          result.started += 1;
        } else if (started.reason) {
          addSkipped(result.skipped, started.reason);
        }
      });
    } catch {
      logger.error("[schedules] start failed", { key: item.key });
      if (!blockFailed) await block("start_failed");
    }
  }

  return result;
}
