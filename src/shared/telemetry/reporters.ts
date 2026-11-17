// F26 Phase 3: indirection so F01 modules report errors without importing PostHog.
export type ServerErrorReporter = (err: unknown, props: Record<string, string>) => void;

let reporter: ServerErrorReporter | null = null;

export function setServerErrorReporter(fn: ServerErrorReporter | null): void {
  reporter = fn;
}

export function reportServerError(err: unknown, props: Record<string, string>): void {
  try {
    reporter?.(err, props);
  } catch {
    // Error reporting must never throw.
  }
}
