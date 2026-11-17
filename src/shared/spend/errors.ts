import { AppError } from "../http/appError.ts";

export type SpendRefusalReason =
  | "feature_disabled"
  | "workspace_cap"
  | "daily_cap"
  | "over_approved_max";

const REFUSAL: Record<
  SpendRefusalReason,
  { status: number; message: string; recovery?: string }
> = {
  feature_disabled: {
    status: 403,
    message: "This feature is not enabled for your workspace.",
  },
  daily_cap: {
    status: 402,
    message: "Today's spend limit for this workspace has been reached.",
    recovery: "Try again tomorrow or ask the workspace owner to raise the limit.",
  },
  workspace_cap: {
    status: 402,
    message: "This month's spend limit for this workspace has been reached.",
  },
  over_approved_max: {
    status: 409,
    message: "This now costs more than you approved. Review the new price.",
  },
};

/**
 * Feature-scoped copy for a `daily_cap` refusal. A customer cannot ask their
 * workspace owner to raise a cap the platform sets, so the workspace recovery
 * ("ask the workspace owner") would be a dead end here.
 */
const FEATURE_DAILY_CAP: { status: number; message: string; recovery?: string } = {
  status: 402,
  message: "This feature's daily spend limit has been reached.",
  recovery: "Try again tomorrow.",
};

function copyFor(
  reason: SpendRefusalReason,
  scope?: "feature" | "workspace"
): { status: number; message: string; recovery?: string } {
  if (reason === "daily_cap" && scope === "feature") return FEATURE_DAILY_CAP;
  return REFUSAL[reason];
}

export class SpendRefused extends AppError {
  readonly reason: SpendRefusalReason;
  readonly scope?: "feature" | "workspace";
  readonly limitUsd?: number;
  readonly estimateUsd?: number;

  constructor(
    reason: SpendRefusalReason,
    opts?: { scope?: "feature" | "workspace"; limitUsd?: number; estimateUsd?: number; cause?: unknown }
  ) {
    const copy = copyFor(reason, opts?.scope);
    super(copy.status, reason, copy.message, {
      recovery: copy.recovery,
      details: opts?.estimateUsd === undefined ? undefined : { estimateUsd: opts.estimateUsd },
      cause: opts?.cause,
    });
    this.name = "SpendRefused";
    this.reason = reason;
    this.scope = opts?.scope;
    this.limitUsd = opts?.limitUsd;
    this.estimateUsd = opts?.estimateUsd;
  }
}

/**
 * Optional HTTP metadata a provider client attaches to a call-outcome error so
 * toErrorResponse can answer with it (for example 502 dataforseo_auth_failed).
 * Without both status and code the error stays an unhandled 500, as before.
 * The message is then shown to the customer, so it must be our own copy and
 * never quote an upstream body.
 */
export type CallErrorMeta = { status?: number; code?: string; details?: Record<string, unknown> };

export class ChargedCallError extends Error {
  readonly actualUsd: number;
  readonly provider: string;
  readonly endpoint: string;
  readonly status?: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    opts: { actualUsd: number; provider: string; endpoint: string; cause?: unknown } & CallErrorMeta
  ) {
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "ChargedCallError";
    this.actualUsd = opts.actualUsd;
    this.provider = opts.provider;
    this.endpoint = opts.endpoint;
    this.status = opts.status;
    this.code = opts.code;
    this.details = opts.details;
  }
}

export class UnbilledCallError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, opts?: { cause?: unknown } & CallErrorMeta) {
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "UnbilledCallError";
    this.status = opts?.status;
    this.code = opts?.code;
    this.details = opts?.details;
  }
}

export class AmbiguousCallError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, opts?: { cause?: unknown } & CallErrorMeta) {
    super(message, opts && "cause" in opts ? { cause: opts.cause } : undefined);
    this.name = "AmbiguousCallError";
    this.status = opts?.status;
    this.code = opts?.code;
    this.details = opts?.details;
  }
}

export function isCallOutcomeError(e: unknown): e is ChargedCallError | UnbilledCallError | AmbiguousCallError {
  return e instanceof ChargedCallError || e instanceof UnbilledCallError || e instanceof AmbiguousCallError;
}
