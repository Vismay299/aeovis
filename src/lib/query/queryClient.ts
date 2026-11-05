// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/client/tanstack-db/queryClient.ts
//   src/client/tanstack-db/queryClient.test.ts
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.
//
// F05 §6.2 — the shared QueryClient factory. The toast is injected so this
// module stays pure and runs under `node --test`.

import { MutationCache, QueryClient } from "@tanstack/query-core";
import { describeError, isSpendRefused, spendRefusedView } from "./errors.ts";
import { hasUnauthorizedHandler, isAbortError, isApiError } from "./fetchJson.ts";

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

/**
 * Never retry a 4xx or a response that failed its schema (the same request
 * gets the same answer); otherwise retry at most twice.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (isApiError(error)) {
    if (error.status >= 400 && error.status <= 499) return false;
    if (error.code === "invalid_response") return false;
  }
  return failureCount < 2;
}

export function createQueryClient(deps: {
  toastError(title: string, description?: string): void;
}): QueryClient {
  return new QueryClient({
    // Every failed mutation shows a toast unless it has its own onError or opts
    // out through meta, so no failure is silent. A 401 redirects to login
    // instead, so it shows none, but only while a redirect handler is
    // registered. A cancelled request is not a failure.
    //
    // `mutation.options.onError` is the `useMutation({ onError })` one. An
    // onError passed per call (in the options after the variables) lives on
    // the observer and is invisible here, so mutationOnErrorGuard.test.mjs
    // forbids it: use useMutation's onError or `meta: { errorToast: false }`.
    mutationCache: new MutationCache({
      onError(error, _v, _c, mutation) {
        if (isAbortError(error)) return;
        if (
          isApiError(error) &&
          error.status === 401 &&
          hasUnauthorizedHandler()
        ) {
          return;
        }
        if (mutation.options.onError || mutation.meta?.errorToast === false) {
          return;
        }
        if (isSpendRefused(error)) {
          const v = spendRefusedView(error);
          deps.toastError(v.title, v.text);
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
