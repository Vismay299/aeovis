"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/useSetKeywordPinned.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { optimisticHandlers } from "@/lib/query/optimistic";

export type UseOptimisticMutationOptions<TVars, TData = unknown, TCache = unknown> = {
  mutationFn: (vars: TVars) => Promise<TData>;
  queryKey: readonly unknown[];
  apply: (old: TCache, vars: TVars) => TCache;
  onSuccess?: (data: TData, vars: TVars) => void;
  meta?: { errorToast?: false };
};

export function useOptimisticMutation<TVars, TData = unknown, TCache = unknown>(
  options: UseOptimisticMutationOptions<TVars, TData, TCache>
) {
  const client = useQueryClient();
  const handlers = optimisticHandlers<TVars, TCache>(
    client,
    options.queryKey,
    options.apply
  );

  return useMutation({
    mutationFn: options.mutationFn,
    onMutate: handlers.onMutate,
    onSettled: handlers.onSettled,
    onSuccess: options.onSuccess,
    meta: options.meta,
  });
}
