"use client";

import Link from "next/link";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";
import { EmptyState } from "@/components/app/EmptyState";
import { QueryError } from "@/components/app/QueryState";
import { ApiError } from "@/lib/query/fetchJson";

/** Reads the error code off a fetchJson failure (or a thrown AppError shape). */
export function ga4ErrorCode(error: unknown): string {
  if (error instanceof ApiError) return error.code;
  if (error && typeof error === "object") {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code) return code;
  }
  return "unknown";
}

function ga4ErrorRecovery(error: unknown): string | undefined {
  if (error instanceof ApiError) return error.recovery;
  if (error && typeof error === "object") {
    const recovery = (error as { recovery?: unknown }).recovery;
    if (typeof recovery === "string") return recovery;
  }
  return undefined;
}

function ga4RetryAfterMinutes(error: unknown): number | null {
  const details =
    error instanceof ApiError
      ? error.details
      : error && typeof error === "object"
        ? (error as { details?: unknown }).details
        : undefined;
  if (details && typeof details === "object") {
    const seconds = (details as { retryAfterSeconds?: unknown })
      .retryAfterSeconds;
    if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
      return Math.ceil(seconds / 60);
    }
  }
  return null;
}

/**
 * Maps a GA4 report failure to the §6.6.3 copy. Owners get the reconnect /
 * choose-property actions; members are told to ask the owner.
 */
export function Ga4ErrorState({
  error,
  canManage,
  onRetry,
  isRetrying = false,
}: {
  error: unknown;
  canManage: boolean;
  onRetry?: () => void;
  isRetrying?: boolean;
}) {
  const code = ga4ErrorCode(error);

  if (code === "ga4_reconnect_required") {
    const message =
      error instanceof Error
        ? error.message
        : "The Google Analytics connection has expired or was revoked.";
    return (
      <Alert variant="warning">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <span>{message}</span>
          {canManage ? (
            <Link
              href="/portal/settings/integrations#google-analytics"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Reconnect
            </Link>
          ) : (
            <span className="text-sm">
              Ask the workspace owner to reconnect Google Analytics.
            </span>
          )}
        </AlertDescription>
      </Alert>
    );
  }

  if (code === "ga4_property_inaccessible") {
    const message =
      error instanceof Error
        ? error.message
        : "The connected Google account can no longer read this property.";
    return (
      <Alert variant="warning">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <span>{message}</span>
          {canManage ? (
            <Link
              href="/portal/settings/integrations#google-analytics"
              className={buttonVariants({ variant: "outline", size: "sm" })}
            >
              Choose another property
            </Link>
          ) : null}
        </AlertDescription>
      </Alert>
    );
  }

  if (code === "ga4_quota_exhausted") {
    const minutes = ga4RetryAfterMinutes(error);
    return (
      <Alert variant="warning">
        <AlertDescription>
          Google Analytics' reporting quota for this property is used up. Try
          again{" "}
          {minutes !== null ? `in about ${minutes} minutes.` : "later."}
        </AlertDescription>
      </Alert>
    );
  }

  if (code === "ga4_report_incompatible") {
    return (
      <EmptyState
        variant="plain"
        title="This report isn't available for this property."
      />
    );
  }

  return (
    <QueryError
      error={error}
      fallback="Couldn't load this report from Google Analytics."
      onRetry={onRetry}
      isRetrying={isRetrying}
    />
  );
}

/** The §6.5.2 recovery line for error codes that carry one. */
export function ga4ErrorRecoveryText(error: unknown): string | undefined {
  return ga4ErrorRecovery(error);
}
