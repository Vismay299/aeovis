import { AsyncLocalStorage } from "node:async_hooks";

export type TelemetryContext = { userId: string | null; brandKey: string | null };

const storage = new AsyncLocalStorage<TelemetryContext>();

const EMPTY: TelemetryContext = { userId: null, brandKey: null };

/**
 * Prefer `runWithTelemetryContext` (isolated async scope) or pass explicit
 * `userId` / `brandKey` into capture calls. `enterWith` mutates the current
 * async scope and can bleed identity across concurrent work that shares it.
 * Kept for narrow fallbacks only.
 */
export function enterTelemetryContext(ctx: TelemetryContext): void {
  storage.enterWith(ctx);
}

/** Run fn inside an isolated telemetry context (preferred for jobs and handlers). */
export async function runWithTelemetryContext<T>(
  ctx: TelemetryContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentTelemetryContext(): TelemetryContext {
  return storage.getStore() ?? EMPTY;
}
