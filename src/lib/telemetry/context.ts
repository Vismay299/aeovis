import { AsyncLocalStorage } from "node:async_hooks";

export type TelemetryContext = { userId: string | null; brandKey: string | null };

const storage = new AsyncLocalStorage<TelemetryContext>();

const EMPTY: TelemetryContext = { userId: null, brandKey: null };

/** Bind identity for the rest of this async chain (route handlers). */
export function enterTelemetryContext(ctx: TelemetryContext): void {
  storage.enterWith(ctx);
}

/** Run fn inside a telemetry context (job runner). */
export async function runWithTelemetryContext<T>(
  ctx: TelemetryContext,
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run(ctx, fn);
}

export function currentTelemetryContext(): TelemetryContext {
  return storage.getStore() ?? EMPTY;
}
