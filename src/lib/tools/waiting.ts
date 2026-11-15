// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/features/sam/samChatTools.ts:179-252
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ToolOutcome, } from "./run.ts";
import type { ToolRegistration } from "./types.ts";

function atPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, part) => {
    if (typeof current !== "object" || current === null) return undefined;
    return Reflect.get(current, part);
  }, value);
}

export async function withProgressWait(
  run: () => Promise<ToolOutcome>,
  wait: NonNullable<ToolRegistration["waitForProgress"]>,
  deps?: { sleep?: (ms: number) => Promise<void>; now?: () => number },
): Promise<ToolOutcome> {
  const sleep = deps?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps?.now ?? Date.now;
  const startedAt = now();
  let outcome = await run();
  if (!outcome.ok) return outcome;

  let status = atPath(outcome.output, wait.statusPath);
  let progress = atPath(outcome.output, wait.progressPath);
  while (wait.runningValues.includes(String(status)) && now() - startedAt < wait.budgetMs) {
    const remaining = wait.budgetMs - (now() - startedAt);
    if (remaining <= 0) break;
    await sleep(Math.min(2_000, remaining));
    if (now() - startedAt >= wait.budgetMs) break;

    const next = await run();
    if (!next.ok) return next;
    const nextStatus = atPath(next.output, wait.statusPath);
    const nextProgress = atPath(next.output, wait.progressPath);
    outcome = next;
    if (nextStatus !== status || nextProgress !== progress) return outcome;
    status = nextStatus;
    progress = nextProgress;
  }
  return outcome;
}
