// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/features/rank-tracking/useSetKeywordPinned.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import type { QueryClient } from "@tanstack/query-core";

export function optimisticHandlers<TVars, TCache>(
  client: QueryClient,
  queryKey: readonly unknown[],
  apply: (old: TCache, vars: TVars) => TCache
): {
  onMutate(vars: TVars): Promise<void>;
  onSettled(_d: unknown, error: unknown): void;
} {
  return {
    async onMutate(vars: TVars) {
      await client.cancelQueries({ queryKey });
      client.setQueriesData<TCache>({ queryKey }, (old) => {
        return old === undefined ? old : apply(old, vars);
      });
    },
    onSettled(_d: unknown, error: unknown) {
      if (error) {
        void client.invalidateQueries({ queryKey });
      }
    },
  };
}
