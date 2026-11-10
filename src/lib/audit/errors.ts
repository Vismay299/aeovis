// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/audit/audit-errors.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { StepFailedError, redactForLog } from "../jobs/runner.ts";

export const AUDIT_ERROR_CODES = [
  "step_timeout",
  "step_attempts_exhausted",
  "billed_step_interrupted",
  "db_error",
  "job_lost",
  "start_failed",
  "start_url_off_site",
  "url_blocked",
  "url_unreachable",
  "no_pages",
  "cancelled",
  "unknown",
] as const;

export type AuditErrorCode = (typeof AUDIT_ERROR_CODES)[number];

const VALID_ERROR_CODES_SET = new Set<string>(AUDIT_ERROR_CODES);

/**
 * Thrown during an audit phase to signal a failure category and current phase.
 */
export class AuditPhaseError extends Error {
  readonly code: AuditErrorCode;
  readonly phase: string | null;

  constructor(code: AuditErrorCode, phase: string | null = null, message?: string) {
    const defaultMsg = `Audit failed in phase ${phase ?? "unknown"}: ${code}`;
    super(message ? `${defaultMsg} - ${message}` : defaultMsg);
    this.name = "AuditPhaseError";
    this.code = code;
    this.phase = phase;
  }
}

/**
 * Classifies an unknown error into a closed audit error code and safe detail.
 * Strips URL query strings from the message and limits length to 500 chars.
 */
export function classifyAuditFailure(err: unknown): {
  errorCode: AuditErrorCode;
  errorDetail: string;
} {
  let rawCode = "unknown";
  let message = "";

  if (err instanceof AuditPhaseError) {
    rawCode = err.code;
    message = err.message;
  } else if (err instanceof StepFailedError) {
    message = err.message;
    const match = message.match(/Audit failed in phase [^:]+:\s*([a-z_]+)/i);
    if (match && VALID_ERROR_CODES_SET.has(match[1])) {
      rawCode = match[1];
    } else if (
      err.code === "step_timeout" ||
      err.code === "step_attempts_exhausted" ||
      err.code === "billed_step_interrupted"
    ) {
      rawCode = err.code;
    } else if (VALID_ERROR_CODES_SET.has(err.code)) {
      rawCode = err.code;
    } else {
      rawCode = "unknown";
    }
  } else if (err instanceof Error) {
    if (err.name === "JobCancelled" || err.message === "cancelled") {
      rawCode = "cancelled";
    }
    message = err.message;
  } else if (typeof err === "string") {
    message = err;
  }

  const errorCode: AuditErrorCode = VALID_ERROR_CODES_SET.has(rawCode)
    ? (rawCode as AuditErrorCode)
    : "unknown";

  const safeMessage = redactForLog(message || "An unexpected error occurred during site audit.");
  const errorDetail = safeMessage.slice(0, 500);

  return { errorCode, errorDetail };
}
