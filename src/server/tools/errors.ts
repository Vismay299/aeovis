// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/mcp/tool-error-message.ts
//   src/server/mcp/instrumentation.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { ZodError } from "zod";
import { AppError } from "../../shared/http/appError.ts";
import { SpendRefused } from "../../shared/spend/errors.ts";

export type ToolErrorView = {
  code: string;
  message: string;
  recovery: string | null;
  retryable: boolean;
  details?: Record<string, unknown>;
};

const HINTS: Record<string, string> = {
  unknown_location: "Use the workspace market, or ask the user which country or city they mean.",
  upstream_unavailable: "The data provider is temporarily unavailable; this is not a problem with the request.",
  daily_cap: "Retrying will not help until the limit resets or the owner raises it.",
  workspace_cap: "Retrying will not help until the limit resets or the owner raises it.",
  feature_disabled: "This feature is not enabled for this workspace; tell the user and do not retry.",
  price_changed: "Ask the user to approve the new price.",
  job_already_running: "Read the running job's status instead of starting another.",
};

const DETAIL_KEYS = new Set(["quote", "approvedMaxUsd", "activeJobId"]);

function safeDetails(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!details) return undefined;
  const picked = Object.fromEntries(Object.entries(details).filter(([key]) => DETAIL_KEYS.has(key)));
  return Object.keys(picked).length ? picked : undefined;
}

function invalidInput(error: ZodError): ToolErrorView {
  const issues = error.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "input";
    return path + ": " + issue.message;
  });
  let message = "The tool input was not valid: " + issues.join("; ");
  if (message.length > 500) message = message.slice(0, 499) + "…";
  return {
    code: "invalid_input",
    message,
    recovery: "Fix the listed fields and call the tool again.",
    retryable: false,
  };
}

export function toToolError(error: unknown): ToolErrorView {
  if (error instanceof SpendRefused) {
    return {
      code: error.reason,
      message: error.message,
      recovery: error.recovery ?? HINTS[error.code] ?? null,
      retryable: false,
    };
  }
  if (error instanceof AppError) {
    const details = safeDetails(error.details);
    return {
      code: error.code,
      message: error.message,
      recovery: error.recovery ?? HINTS[error.code] ?? null,
      retryable: error.status >= 500 || error.code === "upstream_unavailable",
      ...(details ? { details } : {}),
    };
  }
  if (error instanceof ZodError) return invalidInput(error);
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "TimeoutError"
  ) {
    return {
      code: "tool_timeout",
      message: "The tool took too long. Try a narrower request.",
      recovery: null,
      retryable: true,
    };
  }

  const name =
    error instanceof Error && typeof error.name === "string" ? error.name.slice(0, 80) : "UnknownError";
  console.error("[tools] failed", { code: "internal_error", name });
  return {
    code: "internal_error",
    message: "The tool failed. Try again or narrow the request.",
    recovery: null,
    retryable: true,
  };
}
