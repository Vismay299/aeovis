"use client";

// Portions ported from every-app/open-seo@c5f8db1 (MIT, © 2026 Ben Senescu):
//   src/routes/_app/p/$projectId/saved.tsx
// Modified for Perceev. See THIRD_PARTY_NOTICES.md.

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { parseSearchParams, buildSearch } from "@/lib/query/urlState";

export type UseUrlSearchStateOptions<S> = {
  arrays?: readonly (keyof S)[];
};

export function useUrlSearchState<S extends Record<string, unknown>>(
  schema: { safeParse(v: unknown): { success: boolean; data?: S } },
  defaults: S,
  options?: UseUrlSearchStateOptions<S>
) {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();

  const state = useMemo(
    () => parseSearchParams<S>(searchParams, schema, defaults, options?.arrays),
    [searchParams, schema, defaults, options?.arrays]
  );

  const set = useCallback(
    (patch: Partial<S>, o?: { replace?: boolean }) => {
      const search = buildSearch<S>(searchParams, patch, defaults);
      const target = pathname + search;
      if (o?.replace !== false) {
        router.replace(target, { scroll: false });
      } else {
        router.push(target, { scroll: false });
      }
    },
    [searchParams, defaults, pathname, router]
  );

  return [state, set] as const;
}
