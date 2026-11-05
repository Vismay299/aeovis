// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/tanstack-db/queryClient.ts
//   src/client/tanstack-db/queryClient.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.
//
// F05 §6.2 — the shared QueryClient factory. The toast is injected so this
// module stays pure and runs under `node --test`.

import { MutationCache, QueryClient } from "@tanstack/query-core";
import { describeError, isSpendRefused, spendRefusedView } from "./errors.ts";
import { isApiError } from "./fetchJson.ts";

declare module "@tanstack/query-core" {
  interface Register {
    mutationMeta: {
      // Set when the component shows the error itself (inline or in a catch).
      errorToast?: false;
    };
  }
}

export const QUERY_STALE_TIME_MS = 300_000;
export const QUERY_GC_TIME_MS = 3_600_000;

/** Never retry a 4xx; otherwise retry at most twice. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isApiError(error) && error.status >= 400 && error.status <= 499) {
    return false;
  }
  return failureCount < 2;
}

export function createQueryClient(deps: {
  toastError(title: string, description?: string): void;
}): QueryClient {
  return new QueryClient({
    // Every failed mutation shows a toast unless it has its own onError or opts
    // out through meta, so no failure is silent. A 401 redirects to login
    // instead, so it shows none.
    mutationCache: new MutationCache({
      onError(error, _v, _c, mutation) {
        if (isApiError(error) && error.status === 401) return;
        if (mutation.options.onError || mutation.meta?.errorToast === false) {
          return;
        }
        if (isSpendRefused(error)) {
          const v = spendRefusedView(error);
          deps.toastError(
            v.title,
            [v.message, v.recovery].filter(Boolean).join(" "),
          );
          return;
        }
        deps.toastError(describeError(error));
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: QUERY_STALE_TIME_MS,
        gcTime: QUERY_GC_TIME_MS,
        retry: shouldRetryQuery,
      },
      mutations: { retry: 0 },
    },
  });
}
