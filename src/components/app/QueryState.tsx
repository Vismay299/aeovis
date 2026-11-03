"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/components/QueryState.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { ReactNode } from "react";
import type { UseQueryResult } from "@tanstack/react-query";
import { ErrorState } from "@/components/app/ErrorState";
import { SkeletonCard } from "@/components/app/SkeletonPresets";
import { describeError } from "@/components/app/errors/describeError";
import { queryStateView } from "@/components/app/queryStateView";

/**
 * A load failure with a retry button. The message goes through
 * `describeError`.
 */
export function QueryError({
  error,
  cause,
  fallback,
  onRetry,
  isRetrying = false,
  variant,
  title,
}: {
  /** Omit to always show `fallback`, for errors the page words itself. */
  error?: unknown;
  /**
   * The error behind a `fallback` the page words itself; picks the button.
   */
  cause?: unknown;
  /** Shown when the error has no message of its own. */
  fallback: string;
  onRetry?: () => void;
  isRetrying?: boolean;
  variant?: "inline" | "card" | "page";
  title?: string;
}) {
  return (
    <ErrorState
      variant={variant}
      title={title}
      message={describeError(error ?? cause, fallback)}
      onRetry={onRetry}
      isRetrying={isRetrying}
    />
  );
}

/**
 * Loading, error with retry, or content for one query. A failed refetch keeps
 * the loaded content on screen, with the error above it.
 */
export function QueryState<TData>({
  query,
  errorFallback,
  loading = <SkeletonCard />,
  children,
}: {
  query: UseQueryResult<TData>;
  errorFallback: string;
  loading?: ReactNode;
  children: (data: TData) => ReactNode;
}) {
  const view = queryStateView({
    isPending: query.isPending,
    isError: query.isError,
    data: query.data,
  });

  if (view === "loading") {
    return loading;
  }

  const error = query.isError ? (
    <QueryError
      error={query.error}
      fallback={errorFallback}
      onRetry={() => void query.refetch()}
      isRetrying={query.isFetching}
    />
  ) : null;

  if (view === "error") {
    return error;
  }

  if (view === "error+content") {
    return (
      <>
        {error}
        {children(query.data as TData)}
      </>
    );
  }

  return children(query.data as TData);
}
