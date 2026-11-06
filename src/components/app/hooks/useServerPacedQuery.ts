"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/ai-visibility/shared.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useEffect, useRef } from "react";
import { useQuery, type UseQueryOptions, type UseQueryResult } from "@tanstack/react-query";
import { pollIntervalMs, pacedStaleTime, finishTransition } from "@/lib/query/polling";

export type UseServerPacedQueryOptions<TData = unknown, TError = Error> = Omit<
  UseQueryOptions<TData, TError>,
  "refetchInterval" | "refetchIntervalInBackground" | "staleTime"
> & {
  isActive(d: TData): boolean;
  pollAfterSeconds?(d: TData): number | null | undefined;
  floorSeconds?: number;
  fallbackSeconds?: number;
  sameRun?(a: TData, b: TData): boolean;
  onFinish?(d: TData): void;
};

export function useServerPacedQuery<TData = unknown, TError = Error>(
  options: UseServerPacedQueryOptions<TData, TError>
): UseQueryResult<TData, TError> {
  const {
    isActive,
    pollAfterSeconds,
    floorSeconds,
    fallbackSeconds,
    sameRun,
    onFinish,
    ...queryOptions
  } = options;

  const onFinishRef = useRef(onFinish);
  useEffect(() => {
    onFinishRef.current = onFinish;
  });

  const prevDataRef = useRef<TData | undefined>(undefined);

  const query = useQuery<TData, TError>({
    ...queryOptions,
    refetchInterval: (q) =>
      pollIntervalMs(q.state.data, {
        isActive,
        pollAfterSeconds,
        floorSeconds,
        fallbackSeconds,
      }),
    refetchIntervalInBackground: false,
    staleTime: (q) => pacedStaleTime(q.state.data, isActive),
  });

  useEffect(() => {
    if (
      finishTransition(prevDataRef.current, query.data, {
        isActive,
        sameRun,
      })
    ) {
      if (query.data !== undefined) {
        onFinishRef.current?.(query.data);
      }
    }
    prevDataRef.current = query.data;
  }, [query.data, isActive, sameRun]);

  return query;
}
