export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly recovery?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    opts?: { recovery?: string; details?: Record<string, unknown>; cause?: unknown }
  ) {
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.recovery = opts?.recovery;
    this.details = opts?.details;
  }
}

export class WorkspaceError extends AppError {}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
