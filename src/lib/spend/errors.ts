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

export class SpendRefused extends AppError {
  readonly reason: SpendRefusalReason;
  readonly scope?: "feature" | "workspace";
  readonly limitUsd?: number;
  readonly estimateUsd?: number;

  constructor(
    reason: SpendRefusalReason,
    opts?: { scope?: "feature" | "workspace"; limitUsd?: number; estimateUsd?: number; cause?: unknown }
  ) {
    const copy = REFUSAL[reason];
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
