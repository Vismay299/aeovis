// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/server/lib/ga4Errors.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { AppError, toErrorResponse } from "../../shared/http/errors.ts";

export class Ga4AdminApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "Ga4AdminApiError";
    this.status = status;
  }
}

export class Ga4TokenError extends Error {
  readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "Ga4TokenError";
    this.cause = cause;
  }
}

export class Ga4DataApiError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  readonly upstreamReason: string | null;

  constructor(
    status: number,
    message: string,
    retryAfterSeconds: number | null = null,
    upstreamReason: string | null = null,
  ) {
    super(message);
    this.name = "Ga4DataApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
    this.upstreamReason = upstreamReason;
  }
}

export class Ga4MalformedResponseError extends Error {
  constructor() {
    super("Google Analytics returned an invalid reporting response.");
    this.name = "Ga4MalformedResponseError";
  }
}

export type Ga4ReportErrorCode =
  | "validation_error"
  | "ga4_not_connected"
  | "ga4_reconnect_required"
  | "ga4_property_inaccessible"
  | "ga4_report_incompatible"
  | "ga4_quota_exhausted"
  | "ga4_upstream_unavailable"
  | "ga4_malformed_response"
  | "gsc_not_connected"
  | "gsc_reconnect_required"
  | "gsc_quota_exhausted"
  | "gsc_unavailable";

export class Ga4ReportError extends Error {
  readonly code: Ga4ReportErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: Ga4ReportErrorCode,
    message: string,
    retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "Ga4ReportError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function ga4ErrorToAppError(err: unknown): AppError {
  if (err instanceof AppError) {
    return err;
  }

  if (err instanceof Ga4ReportError) {
    switch (err.code) {
      case "validation_error":
        return new AppError(400, "invalid_request", err.message);
      case "ga4_not_connected":
        return new AppError(
          409,
          "ga4_not_connected",
          "Google Analytics isn't connected for this workspace.",
          { recovery: "Connect it in Workspace settings." },
        );
      case "ga4_reconnect_required":
        return new AppError(
          409,
          "ga4_reconnect_required",
          err.message || "The Google Analytics connection has expired or was revoked.",
          { recovery: "Reconnect Google Analytics in Workspace settings." },
        );
      case "ga4_property_inaccessible":
        return new AppError(
          409,
          "ga4_property_inaccessible",
          "The connected Google account can no longer read this property.",
          { recovery: "Choose another property in Workspace settings." },
        );
      case "ga4_report_incompatible":
        return new AppError(
          422,
          "ga4_report_incompatible",
          "This report isn't available for this Google Analytics property.",
        );
      case "ga4_quota_exhausted":
        return new AppError(
          429,
          "ga4_quota_exhausted",
          "Google Analytics' reporting quota for this property is used up.",
          {
            recovery: "Try again later.",
            details: err.retryAfterSeconds !== null ? { retryAfterSeconds: err.retryAfterSeconds } : undefined,
          },
        );
      case "ga4_upstream_unavailable":
        return new AppError(
          503,
          "ga4_upstream_unavailable",
          err.message.includes("Data API")
            ? "The Google Analytics Data API isn't enabled for Perceev's Google project."
            : "Google Analytics is unavailable right now.",
          { recovery: "Please retry." },
        );
      case "ga4_malformed_response":
        return new AppError(
          502,
          "ga4_malformed_response",
          "Google Analytics returned a report we couldn't read.",
          { recovery: "Please retry." },
        );
      case "gsc_not_connected":
        return new AppError(
          409,
          "gsc_not_connected",
          "Connect Search Console to see search opportunities.",
        );
      case "gsc_reconnect_required":
        return new AppError(
          409,
          "gsc_reconnect_required",
          "Search Console access was lost. Reconnect it on the Search Console page.",
        );
      case "gsc_quota_exhausted":
        return new AppError(
          429,
          "gsc_quota_exhausted",
          "Search Console's quota is used up for now.",
          { recovery: "Try again later." },
        );
      case "gsc_unavailable":
        return new AppError(
          503,
          "gsc_unavailable",
          "Search Console is unavailable right now.",
          { recovery: "Please retry." },
        );
      default:
        return new AppError(500, "internal_error", err.message);
    }
  }

  if (err instanceof Ga4TokenError) {
    return new AppError(
      409,
      "ga4_reconnect_required",
      "The Google Analytics connection has expired or was revoked.",
      { recovery: "Reconnect Google Analytics in Workspace settings.", cause: err },
    );
  }

  if (err instanceof Ga4AdminApiError) {
    if (err.status === 401) {
      return new AppError(
        409,
        "ga4_reconnect_required",
        "The Google Analytics connection has expired or was revoked.",
        { recovery: "Reconnect Google Analytics in Workspace settings." },
      );
    }
    if (err.status === 403 || err.status === 404) {
      return new AppError(
        409,
        "ga4_property_inaccessible",
        "The connected Google account can no longer read this property.",
        { recovery: "Choose another property in Workspace settings." },
      );
    }
    if (err.status === 429) {
      return new AppError(
        429,
        "ga4_quota_exhausted",
        "Google Analytics' reporting quota for this property is used up.",
        { recovery: "Try again later." },
      );
    }
    return new AppError(
      503,
      "ga4_upstream_unavailable",
      "Google Analytics is unavailable right now.",
      { recovery: "Please retry." },
    );
  }

  if (err instanceof Ga4DataApiError) {
    if (err.status === 400) {
      return new AppError(
        422,
        "ga4_report_incompatible",
        "This report isn't available for this Google Analytics property.",
      );
    }
    if (err.status === 401) {
      return new AppError(
        409,
        "ga4_reconnect_required",
        "The Google Analytics connection has expired or was revoked.",
        { recovery: "Reconnect Google Analytics in Workspace settings." },
      );
    }
    if (err.status === 403 || err.status === 404) {
      return new AppError(
        409,
        "ga4_property_inaccessible",
        "The connected Google account can no longer read this property.",
        { recovery: "Choose another property in Workspace settings." },
      );
    }
    if (err.status === 429) {
      return new AppError(
        429,
        "ga4_quota_exhausted",
        "Google Analytics' reporting quota for this property is used up.",
        {
          recovery: "Try again later.",
          details: err.retryAfterSeconds !== null ? { retryAfterSeconds: err.retryAfterSeconds } : undefined,
        },
      );
    }
    return new AppError(
      503,
      "ga4_upstream_unavailable",
      "Google Analytics is unavailable right now.",
      { recovery: "Please retry." },
    );
  }

  if (err instanceof Ga4MalformedResponseError) {
    return new AppError(
      502,
      "ga4_malformed_response",
      "Google Analytics returned a report we couldn't read.",
      { recovery: "Please retry." },
    );
  }

  return new AppError(500, "internal_error", err instanceof Error ? err.message : "An unexpected error occurred.");
}

function isGa4Error(err: unknown): boolean {
  return (
    err instanceof Ga4ReportError ||
    err instanceof Ga4TokenError ||
    err instanceof Ga4AdminApiError ||
    err instanceof Ga4DataApiError ||
    err instanceof Ga4MalformedResponseError
  );
}

/**
 * Route error response for every GA4 read route. GA4 error classes carry a
 * `code` but no HTTP status, so `toErrorResponse` alone turns them into a
 * generic 500; they are mapped through `ga4ErrorToAppError` first. Anything
 * else (bugs, storage errors) still reaches `toErrorResponse` untouched, so
 * its message is logged, never sent. A 429 gains `Retry-After` when known.
 */
export function toGa4ErrorResponse(err: unknown): Response {
  const mapped = isGa4Error(err) ? ga4ErrorToAppError(err) : err;
  const res = toErrorResponse(mapped);
  const details =
    mapped instanceof AppError && mapped.details && typeof mapped.details === "object"
      ? (mapped.details as Record<string, unknown>)
      : null;
  const retryAfter = typeof details?.retryAfterSeconds === "number" ? details.retryAfterSeconds : null;
  if (res.status === 429 && retryAfter !== null && Number.isFinite(retryAfter)) {
    const capped = Math.min(Math.max(Math.ceil(retryAfter), 0), 86400);
    const headers = new Headers(res.headers);
    headers.set("Retry-After", String(capped));
    return new Response(res.body, { status: res.status, headers });
  }
  return res;
}
